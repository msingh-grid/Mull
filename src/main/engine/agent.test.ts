import { describe, expect, it, vi } from 'vitest'
import type {
  Options,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { AgentEngine } from './agent'

/**
 * A warm `AgentSession`'s subprocess, faked one generation at a time.
 *
 * Every call to `start` is one (re)spawn — `AgentEngine.answerer` builds a new
 * one whenever `ensure()` decides the live session no longer matches what was
 * asked for (the thinking-mismatch restart this file exists to cover). Each
 * generation gets its own controllable `initializationResult()` (so a test can
 * hold a "handshake" pending, resolve it, or reject it) and a spied `close()`,
 * mirroring the two SDK primitives the fix in `agent.ts` actually calls.
 *
 * The generator itself answers one push with one `stream_event` + `result`
 * pair and then loops back to wait for the next one — a session is reused
 * across many turns in production, and ending after the first would hide
 * exactly the restart behaviour under test.
 */
function fakeSession(): {
  start: (options: Options, prompt: AsyncIterable<SDKUserMessage>) => Query
  generations: Array<{
    options: Options
    close: ReturnType<typeof vi.fn>
    resolveInit: () => void
    rejectInit: (err: Error) => void
    pushed: SDKUserMessage[]
  }>
} {
  const generations: Array<{
    options: Options
    close: ReturnType<typeof vi.fn>
    resolveInit: () => void
    rejectInit: (err: Error) => void
    pushed: SDKUserMessage[]
  }> = []

  const start = (options: Options, prompt: AsyncIterable<SDKUserMessage>): Query => {
    let killed = false
    let onKilled!: () => void
    const killed$ = new Promise<void>((resolve) => {
      onKilled = resolve
    })

    let resolveInit!: () => void
    let rejectInit!: (err: Error) => void
    const init$ = new Promise<SDKControlInitializeResponse>((resolve, reject) => {
      resolveInit = () => resolve({} as SDKControlInitializeResponse)
      rejectInit = reject
    })

    const pushed: SDKUserMessage[] = []
    const close = vi.fn(() => {
      if (killed) return
      killed = true
      onKilled()
    })

    async function* run(): AsyncGenerator<SDKMessage, void> {
      const it = prompt[Symbol.asyncIterator]()
      while (!killed) {
        const next = await Promise.race([
          it.next().then((r) => ({ kind: 'msg' as const, r })),
          killed$.then(() => ({ kind: 'killed' as const, r: undefined }))
        ])
        if (next.kind === 'killed' || next.r?.done) return
        pushed.push(next.r.value)
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }
        } as unknown as SDKMessage
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ok'
        } as unknown as SDKMessage
      }
    }

    const generator = run()
    const query = Object.assign(generator, {
      close,
      initializationResult: () => init$,
      interrupt: async () => undefined,
      setPermissionMode: async () => {},
      setModel: async () => {}
    }) as unknown as Query

    generations.push({ options, close, resolveInit, rejectInit, pushed })
    return query
  }

  return { start, generations }
}

describe('AgentSession — the restart race between an old subprocess and a new one', () => {
  it('does not write the turn until the (re)spawned session proves it is alive', async () => {
    const fake = fakeSession()
    const engine = new AgentEngine({ model: 'claude-sonnet-5', start: fake.start, log: () => {} })

    const promise = engine.answer({ goal: 'first' })
    // Still in the same synchronous continuation `ensure()` ran in — nothing
    // should have been pushed into the subprocess's input yet.
    expect(fake.generations[0]?.pushed).toHaveLength(0)

    fake.generations[0]?.resolveInit()
    const result = await promise

    expect(result.text).toBe('ok')
    expect(fake.generations[0]?.pushed).toHaveLength(1)
  })

  it('restarting for a thinking-mode change closes the old subprocess before the new one answers', async () => {
    const fake = fakeSession()
    let thinking = false
    const engine = new AgentEngine({
      model: 'claude-sonnet-5',
      start: fake.start,
      log: () => {},
      thinking: () => thinking
    })

    const first = engine.answer({ goal: 'one' })
    fake.generations[0]?.resolveInit()
    await first
    expect(fake.generations[0]?.options.thinking).toEqual({ type: 'disabled' })

    thinking = true
    const second = engine.answer({ goal: 'two' })
    fake.generations[1]?.resolveInit()
    const result = await second

    expect(result.text).toBe('ok')
    expect(fake.generations[1]?.options.thinking).toEqual({ type: 'adaptive' })
    // The bug this guards: `reset()` used to only close Mull's own input
    // iterable and never touch the old subprocess at all.
    expect(fake.generations[0]?.close).toHaveBeenCalled()
  })

  it('a session that dies right after a restart rejects with its own error, and logs its stderr', async () => {
    const fake = fakeSession()
    const logs: Array<[string, string]> = []
    let thinking = false
    const engine = new AgentEngine({
      model: 'claude-sonnet-5',
      start: fake.start,
      log: (level, message) => logs.push([level, message]),
      thinking: () => thinking
    })

    const first = engine.answer({ goal: 'one' })
    fake.generations[0]?.resolveInit()
    await first

    thinking = true
    const second = engine.answer({ goal: 'two' })
    const boom = new Error('spawn ENOTDIR')
    fake.generations[1]?.rejectInit(boom)

    // The specific failure, not `pump`'s generic "ended unexpectedly" fallback.
    await expect(second).rejects.toThrow('spawn ENOTDIR')

    fake.generations[1]?.options.stderr?.('the CLI printed this before dying\n')
    expect(
      logs.some(
        ([level, message]) =>
          level === 'warn' && message.includes('stderr') && message.includes('before dying')
      )
    ).toBe(true)
  })

  it('the existing 60s watchdog still owns a handshake that never resolves, and a later resolve is a no-op', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeSession()
      const engine = new AgentEngine({ model: 'claude-sonnet-5', start: fake.start, log: () => {} })

      const promise = engine.answer({ goal: 'x' })
      const assertion = expect(promise).rejects.toThrow(/stopped responding after 60s/)
      await vi.advanceTimersByTimeAsync(60_100)
      await assertion

      // The handshake finally resolving after the watchdog already gave up
      // must not retroactively push the turn.
      expect(() => fake.generations[0]?.resolveInit()).not.toThrow()
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.generations[0]?.pushed).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('warm() stays synchronous and non-blocking even when the handshake never resolves', () => {
    const fake = fakeSession()
    const engine = new AgentEngine({ model: 'claude-sonnet-5', start: fake.start, log: () => {} })

    expect(() => engine.warm()).not.toThrow()
    // edit + classifier, per `AgentEngine.warm()` — the composer, navigator
    // and answerer are deliberately not warmed.
    expect(fake.generations).toHaveLength(2)
  })
})
