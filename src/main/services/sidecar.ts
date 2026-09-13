import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { z } from 'zod'
import {
  SIDECAR_PROTOCOL_VERSION,
  SidecarMethods,
  SidecarNotifications,
  type SidecarNotification,
  type SidecarNotificationName,
  type ContextBlock,
  type InsertionStrategy,
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
  /** The push-to-talk key, from the sidecar's event tap (protocol 3). */
  hotkey: [SidecarNotification<'hotkey'>]
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
      this.onNotification(message)
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
  selectedText = (p: SidecarParams<'selectedText'>) => this.call('selectedText', p)
  windowContext = (p: SidecarParams<'windowContext'>) => this.call('windowContext', p)
  promptScreenRecording = (p: SidecarParams<'promptScreenRecording'>) =>
    this.call('promptScreenRecording', p)
  insertText = (p: SidecarParams<'insertText'>) => this.call('insertText', p)
  replaceSelection = (p: SidecarParams<'replaceSelection'>) => this.call('replaceSelection', p)
  replaceRange = (p: SidecarParams<'replaceRange'>) => this.call('replaceRange', p)
  secureInputState = (p: SidecarParams<'secureInputState'>) => this.call('secureInputState', p)
  activateApp = (p: SidecarParams<'activateApp'>) => this.call('activateApp', p)
  keyChord = (p: SidecarParams<'keyChord'>) => this.call('keyChord', p)
  startHotkeyTap = (p: SidecarParams<'startHotkeyTap'>) => this.call('startHotkeyTap', p)
  stopHotkeyTap = (p: SidecarParams<'stopHotkeyTap'>) => this.call('stopHotkeyTap', p)

  /**
   * A message the host never asked for.
   *
   * Validated like any result: an unprompted message is the easiest place for
   * a drifting sidecar to go unnoticed, because nothing is waiting on it. An
   * unknown method or a bad shape is logged loudly rather than dropped.
   */
  private onNotification(message: Record<string, unknown>): void {
    const method = message['method']
    if (typeof method !== 'string') {
      this.log('warn', 'sidecar: notification without a method', message)
      return
    }
    if (!(method in SidecarNotifications)) {
      this.log('warn', `sidecar: unknown notification "${method}"`, message)
      return
    }

    const name = method as SidecarNotificationName
    const parsed = SidecarNotifications[name].safeParse(message['params'])
    if (!parsed.success) {
      this.log('error', `sidecar: notification "${method}" failed validation`, parsed.error.issues)
      return
    }

    if (name === 'hotkey') {
      this.emit('hotkey', parsed.data as SidecarNotification<'hotkey'>)
    }
  }

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

export interface FakeSidecarOptions {
  accessibility?: boolean
  inputMonitoring?: boolean
  secureInput?: boolean
  app?: { bundleId: string; name: string; pid: number } | null
  /** Force every insertion to fail with this reason code. */
  insertFails?: string | null
  /** Which strategies this pretend app implements. Default: all three. */
  supports?: Partial<Record<InsertionStrategy, boolean>>
  /**
   * Accept an AX write and then quietly drop it — the behaviour that makes
   * read-back verification necessary in the first place. Some real apps do
   * exactly this.
   */
  axLies?: boolean
  /** Pretend the target won't report its text (verified comes back null). */
  unreadable?: boolean
  /** Refuse the hotkey tap, as a Mac without Input Monitoring would. */
  hotkeyTap?: boolean
  /**
   * What the pretend app does with a chord (M5a, for the send read-back).
   *
   * `clears` is an app that sent the message and emptied the composer;
   * `ignores` is the default and models the chord landing on nothing, which is
   * exactly the case the read-back exists to catch. `refuses` is the window
   * server declining the event.
   */
  chordEffect?: 'clears' | 'ignores' | 'refuses'
  /** Start with a document and caret, for undo/replaceRange tests. */
  text?: string
  caret?: number
  selectionLength?: number
  /** No text element has focus. */
  noFocus?: boolean
  /**
   * Where the pretend app's selection was found: 'focused' | 'tree' | 'copy'.
   * The host only allows an in-place replace through the paste chain for
   * 'focused', so this is the switch that exercises that rule.
   */
  selectionSource?: string
  /** False models read-only text — a sent message, a web page. */
  selectionEditable?: boolean
  /** What a ⌘C probe would return when AX finds nothing. */
  copyable?: string
  /**
   * Focus exists and reports a caret, but refuses to hand over its value —
   * web text areas and terminals do this. Callers then have no local copy to
   * check against and must rely on the sidecar's own `expect` guard.
   */
  valueUnreadable?: boolean
  /** Screen Recording, for the picture half of `windowContext`. */
  screenRecording?: boolean
  /**
   * What the pretend window reads as, in order. Given as plain strings for the
   * common case; a test that cares about roles, focus or selection can pass
   * whole blocks.
   */
  context?: Array<string | ContextBlock>
  /** Stop the pretend harvest early, as a budget would. */
  contextStoppedBy?: string
  /** A pretend JPEG on disk. Absent means the picture was not taken. */
  screenshotPath?: string
}

/**
 * Sidecar stand-in for tests and for running without a built binary.
 *
 * It models a single text field — value, caret, selection — so the whole write
 * path (chain walking, verification, undo's read-then-replace) can be exercised
 * without macOS in the loop. Without a document it would only be able to prove
 * that we *called* the right methods, which is the part that was never in doubt.
 *
 * Defaults are deliberately pessimistic: no permissions, insertion refused. The
 * app must stay honest when the real sidecar is missing rather than silently
 * pretending to type.
 */
export class FakeSidecar implements SidecarApi {
  insertions: string[] = []
  /** Every (strategy, text) pair the service asked for, in order. */
  calls: Array<{ method: string; strategy?: string; text?: string; settleMs?: number }> = []
  text: string
  caret: number
  selectionLength: number

  /** Which chords the pretend tap is watching. Empty when it is stopped. */
  hotkeyTapChords: Array<'opt-space' | 'fn'> = []
  /** Every chord that was actually posted into the pretend app, in order. */
  chords: Array<{ key: string; modifiers: string[] }> = []

  constructor(private readonly overrides: FakeSidecarOptions = {}) {
    this.text = overrides.text ?? ''
    this.caret = overrides.caret ?? this.text.length
    this.selectionLength = overrides.selectionLength ?? 0
  }

  private supports(strategy: InsertionStrategy): boolean {
    return this.overrides.supports?.[strategy] ?? true
  }

  private guard(): { reason: string } | null {
    if (this.overrides.secureInput) return { reason: 'secure-input' }
    if (this.overrides.accessibility === false || this.overrides.accessibility === undefined) {
      // Permission defaults to absent, matching the real "nothing granted yet".
      return { reason: 'no-accessibility' }
    }
    return null
  }

  async init() {
    return {
      ok: true as const,
      sidecarVersion: 'fake',
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      pid: 0
    }
  }
  async checkPermissions() {
    return {
      accessibility: this.overrides.accessibility ?? false,
      inputMonitoring: this.overrides.inputMonitoring ?? false,
      screenRecording: this.overrides.screenRecording ?? false
    }
  }
  async promptAccessibility() {
    return { prompted: false, accessibility: this.overrides.accessibility ?? false }
  }
  async promptScreenRecording() {
    return { prompted: false, screenRecording: this.overrides.screenRecording ?? false }
  }

  /**
   * What the pretend window reads as.
   *
   * Refuses on exactly the two grounds the real verb does, and in the same
   * order: secure input first (reading a password field is its own harm, quite
   * apart from typing into one), then Accessibility.
   */
  async windowContext(p: SidecarParams<'windowContext'>) {
    const app = (await this.frontmostApp()).app
    const empty = (reason: string) => ({
      app,
      windowTitle: null,
      blocks: [],
      truncated: false,
      stoppedBy: reason,
      harvestMs: 0,
      screenshot: null,
      screenshotReason: reason
    })
    if (this.overrides.secureInput) return empty('secure-input')
    if (!this.overrides.accessibility) return empty('no-accessibility')

    const blocks: ContextBlock[] = (this.overrides.context ?? []).map((block) =>
      typeof block === 'string'
        ? { role: 'AXStaticText', text: block, label: null, focused: false, selected: false }
        : block
    )
    const stoppedBy = this.overrides.contextStoppedBy ?? 'complete'
    const wanted = p?.screenshot === true
    const path = this.overrides.screenshotPath
    return {
      app,
      windowTitle: null,
      blocks,
      truncated: stoppedBy !== 'complete',
      stoppedBy,
      harvestMs: 1,
      screenshot:
        wanted && path
          ? { path, width: 1400, height: 900, bytes: 180_000, elapsedMs: 40 }
          : null,
      screenshotReason: !wanted
        ? 'not-requested'
        : path
          ? null
          : this.overrides.screenRecording
            ? 'capture-failed'
            : 'no-screen-recording'
    }
  }
  async frontmostApp() {
    return {
      app:
        this.overrides.app === undefined
          ? { bundleId: 'com.apple.TextEdit', name: 'TextEdit', pid: 1 }
          : this.overrides.app,
      windowTitle: null
    }
  }

  /**
   * The selection, as the real sidecar reports it.
   *
   * `selectionSource` lets a test say where it was found, because the host
   * treats the three differently: only a selection in the focused element may
   * be written back through the paste chain.
   */
  async selectedText(p: SidecarParams<'selectedText'>) {
    if (this.overrides.accessibility === false || this.overrides.accessibility === undefined) {
      return { text: null, editable: false, source: null, reason: 'no-accessibility' }
    }
    const text = this.text.slice(this.caret, this.caret + this.selectionLength)
    if (text.trim()) {
      return {
        text,
        editable: this.overrides.selectionEditable ?? true,
        source: this.overrides.selectionSource ?? 'focused',
        reason: null
      }
    }
    if (p?.allowCopy && this.overrides.copyable) {
      return { text: this.overrides.copyable, editable: false, source: 'copy', reason: null }
    }
    return { text: null, editable: false, source: null, reason: 'no-selection' }
  }

  async focusedElement(p: SidecarParams<'focusedElement'>) {
    const app = (await this.frontmostApp()).app
    if (this.overrides.noFocus) {
      return { element: null, app, reason: 'no-focused-element' }
    }
    if (this.overrides.accessibility === false) {
      return { element: null, app, reason: 'no-accessibility' }
    }
    const context = p?.contextBytes ?? 2048
    if (this.overrides.valueUnreadable) {
      return {
        element: {
          role: 'AXTextArea',
          editable: true,
          text: '',
          textStart: this.caret,
          truncated: true,
          selection: { start: this.caret, length: this.selectionLength, text: '' }
        },
        app,
        reason: null
      }
    }
    const start = Math.max(0, this.caret - context)
    const end = Math.min(this.text.length, this.caret + context)
    return {
      element: {
        role: 'AXTextArea',
        editable: true,
        text: this.text.slice(start, end),
        textStart: start,
        truncated: start > 0 || end < this.text.length,
        selection: {
          start: this.caret,
          length: this.selectionLength,
          text: this.text.slice(this.caret, this.caret + this.selectionLength)
        }
      },
      app,
      reason: null
    }
  }

  async insertText(p: SidecarParams<'insertText'>) {
    this.calls.push({
      method: 'insertText',
      strategy: p.strategy,
      text: p.text,
      settleMs: p.settleMs
    })
    const blocked = this.guard()
    if (blocked) {
      return { inserted: false, strategyUsed: null, reason: blocked.reason, verified: null, caret: null }
    }
    if (this.overrides.insertFails) {
      return {
        inserted: false,
        strategyUsed: null,
        reason: this.overrides.insertFails,
        verified: null,
        caret: null
      }
    }
    const strategy = (p.strategy ?? 'paste') as InsertionStrategy
    if (!this.supports(strategy)) {
      return {
        inserted: false,
        strategyUsed: null,
        reason: strategy === 'ax' ? 'ax-unsupported' : 'strategy-unsupported',
        verified: null,
        caret: null
      }
    }
    if (strategy === 'ax' && this.overrides.axLies) {
      return {
        inserted: false,
        strategyUsed: null,
        reason: 'ax-verify-failed',
        verified: false,
        caret: null
      }
    }

    this.apply(this.caret, this.selectionLength, p.text)
    this.insertions.push(p.text)
    return {
      inserted: true,
      strategyUsed: strategy,
      reason: null,
      verified: this.overrides.unreadable ? null : true,
      caret: this.overrides.unreadable ? null : this.caret
    }
  }

  async replaceSelection(p: SidecarParams<'replaceSelection'>) {
    const previous = this.text.slice(this.caret, this.caret + this.selectionLength)
    const result = await this.insertText(p)
    return {
      replaced: result.inserted,
      strategyUsed: result.strategyUsed,
      reason: result.reason,
      verified: result.verified,
      caret: result.caret,
      replacedText: result.inserted ? previous : null
    }
  }

  async replaceRange(p: SidecarParams<'replaceRange'>) {
    this.calls.push({ method: 'replaceRange', text: p.text })
    const blocked = this.guard()
    if (blocked) return { replaced: false, reason: blocked.reason, verified: null }
    if (this.overrides.noFocus) {
      return { replaced: false, reason: 'no-focused-element', verified: null }
    }
    if (!this.supports('ax')) {
      return { replaced: false, reason: 'ax-unsupported', verified: null }
    }
    const actual = this.text.slice(p.start, p.start + p.length)
    if (p.expect !== undefined && actual !== p.expect) {
      return { replaced: false, reason: 'expect-mismatch', verified: null }
    }
    this.apply(p.start, p.length, p.text)
    return { replaced: true, reason: null, verified: true }
  }

  async secureInputState() {
    return { active: this.overrides.secureInput ?? false, pid: null }
  }
  async activateApp() {
    return { activated: false, reason: 'not-running' }
  }
  async keyChord(p: SidecarParams<'keyChord'>) {
    this.chords.push({ key: p.key, modifiers: [...(p.modifiers ?? [])] })
    this.calls.push({ method: 'keyChord', text: p.key })
    const blocked = this.guard()
    if (blocked) return { sent: false, reason: blocked.reason }
    if (this.overrides.chordEffect === 'refuses') return { sent: false, reason: 'event-refused' }
    // An app that acted on it: the composer is now empty, which is what the
    // read-back looks for.
    if (this.overrides.chordEffect === 'clears') {
      this.text = ''
      this.caret = 0
      this.selectionLength = 0
    }
    return { sent: true, reason: null }
  }

  async startHotkeyTap(params: { chords: Array<'opt-space' | 'fn'>; swallow?: boolean }) {
    if (this.overrides.hotkeyTap === false) {
      return { started: false, reason: 'no-input-monitoring', swallowing: false }
    }
    this.hotkeyTapChords = [...params.chords]
    return {
      started: true,
      reason: null,
      swallowing: params.chords.includes('opt-space') && params.swallow !== false
    }
  }

  async stopHotkeyTap() {
    const was = this.hotkeyTapChords.length > 0
    this.hotkeyTapChords = []
    return { stopped: was }
  }

  private apply(start: number, length: number, text: string): void {
    this.text = this.text.slice(0, start) + text + this.text.slice(start + length)
    this.caret = start + text.length
    this.selectionLength = 0
  }
}
