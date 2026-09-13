import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { SIDECAR_PROTOCOL_VERSION } from '@shared/sidecar-api'
import { SidecarClient, SidecarRpcError, FakeSidecar } from './sidecar'

/**
 * A stand-in for the spawned Swift process: we drive its stdout by hand so the
 * framing, id-matching and error paths are exercised without a binary.
 */
class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false

  /** Requests the client has written, parsed. */
  readonly requests: Array<{ id: number; method: string; params: unknown }> = []

  constructor(
    private readonly respond: (
      req: { id: number; method: string; params: unknown },
      child: FakeChild
    ) => void
  ) {
    super()
    let buffer = ''
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.trim()) {
          const req = JSON.parse(line) as { id: number; method: string; params: unknown }
          this.requests.push(req)
          this.respond(req, this)
        }
        nl = buffer.indexOf('\n')
      }
    })
  }

  reply(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }
  replyError(id: number, code: number, message: string): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
  }
  kill(): boolean {
    this.killed = true
    return true
  }
}

function clientWith(
  respond: (req: { id: number; method: string; params: unknown }, child: FakeChild) => void
): { client: SidecarClient; child: FakeChild } {
  const child = new FakeChild(respond)
  const client = new SidecarClient({
    binaryPath: '/nonexistent/mull-mac',
    timeoutMs: 500,
    spawnFn: (() => child) as never
  })
  return { client, child }
}

const initResult = {
  ok: true,
  sidecarVersion: '0.1.0',
  protocolVersion: SIDECAR_PROTOCOL_VERSION,
  pid: 4242
}

describe('SidecarClient', () => {
  it('handshakes on start and sends the protocol version', async () => {
    const { client, child } = clientWith((req, c) => {
      if (req.method === 'init') c.reply(req.id, initResult)
    })
    await client.start()
    expect(child.requests[0]?.method).toBe('init')
    expect(child.requests[0]?.params).toEqual({ protocolVersion: SIDECAR_PROTOCOL_VERSION })
    await client.dispose()
  })

  it('matches responses to their own request, out of order', async () => {
    const pendingIds: number[] = []
    const { client, child } = clientWith((req, c) => {
      if (req.method === 'init') return c.reply(req.id, initResult)
      pendingIds.push(req.id)
    })
    await client.start()

    const first = client.frontmostApp({})
    const second = client.secureInputState({})
    await new Promise((r) => setTimeout(r, 10))

    // Answer them backwards.
    child.reply(pendingIds[1] as number, { active: true, pid: null })
    child.reply(pendingIds[0] as number, {
      app: { bundleId: 'com.apple.Mail', name: 'Mail', pid: 7 },
      windowTitle: null
    })

    await expect(second).resolves.toEqual({ active: true, pid: null })
    await expect(first).resolves.toMatchObject({ app: { name: 'Mail' } })
    await client.dispose()
  })

  it('handles multiple messages arriving in one chunk', async () => {
    const ids: number[] = []
    const { client, child } = clientWith((req, c) => {
      if (req.method === 'init') return c.reply(req.id, initResult)
      ids.push(req.id)
    })
    await client.start()
    const a = client.secureInputState({})
    const b = client.secureInputState({})
    await new Promise((r) => setTimeout(r, 10))
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: ids[0], result: { active: false, pid: null } })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: ids[1], result: { active: true, pid: 9 } })}\n`
    )
    await expect(a).resolves.toEqual({ active: false, pid: null })
    await expect(b).resolves.toEqual({ active: true, pid: 9 })
    await client.dispose()
  })

  it('surfaces JSON-RPC errors as typed rejections', async () => {
    const { client } = clientWith((req, c) => {
      if (req.method === 'init') return c.reply(req.id, initResult)
      c.replyError(req.id, -32000, 'NotImplemented: focusedElement lands in M2')
    })
    await client.start()
    await expect(client.focusedElement({ contextBytes: 256 })).rejects.toBeInstanceOf(SidecarRpcError)
    await client
      .focusedElement({ contextBytes: 256 })
      .catch((err: SidecarRpcError) => expect(err.isNotImplemented).toBe(true))
    await client.dispose()
  })

  it('rejects when the sidecar goes silent', async () => {
    const { client } = clientWith((req, c) => {
      if (req.method === 'init') c.reply(req.id, initResult)
      // everything else is dropped on the floor
    })
    await client.start()
    await expect(client.secureInputState({})).rejects.toThrow(/timed out/)
    await client.dispose()
  })

  it('fails pending calls when the process dies', async () => {
    const { client, child } = clientWith((req, c) => {
      if (req.method === 'init') c.reply(req.id, initResult)
    })
    await client.start()
    const call = client.secureInputState({})
    await new Promise((r) => setTimeout(r, 10))
    child.emit('close', 1, null)
    await expect(call).rejects.toThrow(/sidecar exited/)
    await client.dispose()
  })

  it('validates results against the contract', async () => {
    const { client } = clientWith((req, c) => {
      if (req.method === 'init') return c.reply(req.id, initResult)
      c.reply(req.id, { active: 'yes please' }) // wrong type
    })
    await client.start()
    await expect(client.secureInputState({})).rejects.toThrow()
    await client.dispose()
  })
})

describe('FakeSidecar', () => {
  it('refuses insertion when secure input is on', async () => {
    const fake = new FakeSidecar({ secureInput: true })
    const result = await fake.insertText({ text: 'hello' })
    expect(result).toMatchObject({ inserted: false, reason: 'secure-input' })
    expect(fake.insertions).toHaveLength(0)
  })

  it('records what it was asked to insert', async () => {
    const fake = new FakeSidecar({ accessibility: true })
    await fake.insertText({ text: 'hello' })
    expect(fake.insertions).toEqual(['hello'])
  })
})
