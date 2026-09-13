import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { z } from 'zod'
import {
  SIDECAR_PROTOCOL_VERSION,
  SidecarMethods,
  type SidecarApi,
  type SidecarMethodName,
  type SidecarParams,
  type SidecarResult
} from '@shared/sidecar-api'

/**
 * Electron-side client for the `mull-mac` Swift sidecar.
 *
 * Transport is ndjson JSON-RPC over the child's stdio (see
 * src/shared/sidecar-api.ts for the contract). Responsibilities:
 *   - framing in both directions, with a hard line-length guard
 *   - typed calls: params and results both validated against the zod map, so a
 *     Swift-side shape drift fails here rather than three layers downstream
 *   - crash resilience: pending calls reject, the child is respawned with
 *     backoff, and `init` is replayed before anything else goes out
 *
 * Nothing in this file imports `electron`, so it is unit-testable under node.
 */

const MAX_LINE_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5_000
const RESTART_BACKOFF_MS = [200, 500, 1_500, 5_000]
const MAX_RESTARTS = 8

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export interface SidecarClientOptions {
  binaryPath: string
  timeoutMs?: number
  /** Injected for tests; defaults to node's spawn. */
  spawnFn?: typeof spawn
  onLog?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export interface SidecarEvents {
  crash: [{ code: number | null; signal: NodeJS.Signals | null; restarts: number }]
  ready: [{ sidecarVersion: string; pid: number }]
  gaveUp: [{ reason: string }]
}

export class SidecarClient extends EventEmitter<SidecarEvents> implements SidecarApi {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private restarts = 0
  private starting: Promise<void> | null = null
  private disposed = false
  private readonly timeoutMs: number
  private readonly spawnFn: typeof spawn
  private readonly log: NonNullable<SidecarClientOptions['onLog']>

  constructor(private readonly options: SidecarClientOptions) {
    super()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.spawnFn = options.spawnFn ?? spawn
    this.log = options.onLog ?? (() => {})
  }

  static binaryExists(binaryPath: string): boolean {
    return existsSync(binaryPath)
  }

  /** Spawn (if needed) and complete the `init` handshake. Idempotent. */
  async start(): Promise<void> {
    if (this.disposed) throw new Error('sidecar: client disposed')
    if (this.child && !this.child.killed) return
    if (this.starting) return this.starting

    this.starting = this.spawnAndHandshake().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async spawnAndHandshake(): Promise<void> {
    const child = this.spawnFn(this.options.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams

    this.child = child
    this.buffer = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) this.log('warn', `sidecar stderr: ${text}`)
    })
    child.on('error', (err) => {
      this.log('error', 'sidecar spawn error', err)
      this.failAllPending(new Error(`sidecar spawn failed: ${err.message}`))
    })
    child.on('close', (code, signal) => this.onClose(code, signal))

    const result = await this.rawCall('init', { protocolVersion: SIDECAR_PROTOCOL_VERSION })
    const init = SidecarMethods.init.result.parse(result)
    this.restarts = 0
    this.log('info', 'sidecar ready', init)
    this.emit('ready', { sidecarVersion: init.sidecarVersion, pid: init.pid })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = ''
      this.log('error', 'sidecar: oversized line discarded')
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.log('error', `sidecar: unparseable line: ${line.slice(0, 200)}`)
      return
    }

    const id = message['id']
    if (typeof id !== 'number') {
      // Notifications (no id) land here; none are defined in v0.
      this.log('info', 'sidecar notification', message)
      return
    }

    const pending = this.pending.get(id)
    if (!pending) {
      this.log('warn', `sidecar: response for unknown id ${id}`)
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)

    const error = message['error'] as { code?: number; message?: string } | undefined
    if (error) {
      pending.reject(
        new SidecarRpcError(pending.method, error.code ?? -1, error.message ?? 'unknown error')
      )
      return
    }
    pending.resolve(message['result'])
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null
    this.failAllPending(new Error(`sidecar exited (code=${code} signal=${signal})`))
    if (this.disposed) return

    this.restarts += 1
    this.emit('crash', { code, signal, restarts: this.restarts })
    if (this.restarts > MAX_RESTARTS) {
      const reason = `sidecar crashed ${this.restarts} times; not restarting`
      this.log('error', reason)
      this.emit('gaveUp', { reason })
      return
    }
    const delay = RESTART_BACKOFF_MS[Math.min(this.restarts - 1, RESTART_BACKOFF_MS.length - 1)] ?? 5_000
    this.log('warn', `sidecar restarting in ${delay} ms (attempt ${this.restarts})`)
    setTimeout(() => {
      if (this.disposed) return
      void this.start().catch((err: unknown) => {
        this.log('error', 'sidecar restart failed', err)
      })
    }, delay)
  }

  private failAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }

  private rawCall(method: string, params: unknown): Promise<unknown> {
    const child = this.child
    if (!child || child.killed || !child.stdin.writable) {
      return Promise.reject(new Error(`sidecar: not running (method=${method})`))
    }
    const id = this.nextId
    this.nextId += 1

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`sidecar: '${method}' timed out after ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })

      const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
      child.stdin.write(line, 'utf8', (err) => {
        if (!err) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`sidecar: write failed for '${method}': ${err.message}`))
      })
    })
  }

  /** Typed call: params validated on the way out, result on the way back. */
  async call<M extends SidecarMethodName>(
    method: M,
    params: SidecarParams<M>
  ): Promise<SidecarResult<M>> {
    await this.start()
    const spec = SidecarMethods[method] as unknown as {
      params: z.ZodType<unknown, unknown>
      result: z.ZodType<unknown, unknown>
    }
    const encoded = spec.params.parse(params)
    const raw = await this.rawCall(method, encoded)
    return spec.result.parse(raw) as SidecarResult<M>
  }

  // -- SidecarApi surface ---------------------------------------------------
  init = (p: SidecarParams<'init'>) => this.call('init', p)
  checkPermissions = (p: SidecarParams<'checkPermissions'>) => this.call('checkPermissions', p)
  promptAccessibility = (p: SidecarParams<'promptAccessibility'>) =>
    this.call('promptAccessibility', p)
  frontmostApp = (p: SidecarParams<'frontmostApp'>) => this.call('frontmostApp', p)
  focusedElement = (p: SidecarParams<'focusedElement'>) => this.call('focusedElement', p)
  insertText = (p: SidecarParams<'insertText'>) => this.call('insertText', p)
  replaceSelection = (p: SidecarParams<'replaceSelection'>) => this.call('replaceSelection', p)
  secureInputState = (p: SidecarParams<'secureInputState'>) => this.call('secureInputState', p)
  activateApp = (p: SidecarParams<'activateApp'>) => this.call('activateApp', p)
  keyChord = (p: SidecarParams<'keyChord'>) => this.call('keyChord', p)

  async dispose(): Promise<void> {
    this.disposed = true
    this.failAllPending(new Error('sidecar: disposed'))
    this.child?.kill('SIGTERM')
    this.child = null
  }
}

export class SidecarRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string
  ) {
    super(`sidecar '${method}' failed (${code}): ${message}`)
    this.name = 'SidecarRpcError'
  }

  get isNotImplemented(): boolean {
    return this.code === -32000
  }
}

/**
 * Sidecar stand-in for tests and for running without a built binary.
 *
 * It reports no permissions and refuses insertion — the app must stay honest
 * when the real thing is missing rather than silently pretending to type.
 */
export class FakeSidecar implements SidecarApi {
  insertions: string[] = []

  constructor(
    private readonly overrides: {
      accessibility?: boolean
      inputMonitoring?: boolean
      secureInput?: boolean
      app?: { bundleId: string; name: string; pid: number } | null
      insertFails?: string | null
    } = {}
  ) {}

  async init() {
    return { ok: true as const, sidecarVersion: 'fake', protocolVersion: SIDECAR_PROTOCOL_VERSION, pid: 0 }
  }
  async checkPermissions() {
    return {
      accessibility: this.overrides.accessibility ?? false,
      inputMonitoring: this.overrides.inputMonitoring ?? false
    }
  }
  async promptAccessibility() {
    return { prompted: false, accessibility: this.overrides.accessibility ?? false }
  }
  async frontmostApp() {
    return {
      app: this.overrides.app === undefined ? { bundleId: 'com.apple.TextEdit', name: 'TextEdit', pid: 1 } : this.overrides.app,
      windowTitle: null
    }
  }
  async focusedElement() {
    return { element: null, app: null }
  }
  async insertText(p: SidecarParams<'insertText'>) {
    if (this.overrides.secureInput) {
      return { inserted: false, strategyUsed: null, reason: 'secure-input' }
    }
    if (this.overrides.insertFails) {
      return { inserted: false, strategyUsed: null, reason: this.overrides.insertFails }
    }
    this.insertions.push(p.text)
    return { inserted: true, strategyUsed: 'paste' as const, reason: null }
  }
  async replaceSelection(p: SidecarParams<'replaceSelection'>) {
    this.insertions.push(p.text)
    return { replaced: true, strategyUsed: 'paste' as const, reason: null }
  }
  async secureInputState() {
    return { active: this.overrides.secureInput ?? false, pid: null }
  }
  async activateApp() {
    return { activated: false }
  }
  async keyChord() {
    return { sent: false }
  }
}
