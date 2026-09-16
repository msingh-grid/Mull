import { describe, expect, it, vi } from 'vitest'
import { IDLE_HUD_STATE, type HudState } from '@shared/ipc'
import type { DiffCard, HudCard, PlanCard } from '@shared/hud'
import { ChordScope, type GlobalShortcutLike } from './chords'
import { HudController, type HudPort } from './hud'

const card: DiffCard = { kind: 'diff', app: 'Mail', segments: [], changes: 1 }
const other: DiffCard = { kind: 'diff', app: 'Mail', segments: [], changes: 2 }

function harness(): {
  controller: HudController
  sent: HudState[]
  interactive: boolean[]
  shortcuts: Set<string>
  fire: (accelerator: string) => void
} {
  const sent: HudState[] = []
  const interactive: boolean[] = []
  const shortcuts = new Set<string>()
  const handlers = new Map<string, () => void>()

  const globalShortcut: GlobalShortcutLike = {
    register(accelerator, callback) {
      shortcuts.add(accelerator)
      handlers.set(accelerator, callback)
      return true
    },
    unregister(accelerator) {
      shortcuts.delete(accelerator)
      handlers.delete(accelerator)
    }
  }
  const port: HudPort = {
    send: (state) => sent.push(state),
    setInteractive: (value) => interactive.push(value)
  }

  return {
    controller: new HudController({ port, chords: new ChordScope({ globalShortcut }) }),
    sent,
    interactive,
    shortcuts,
    fire: (accelerator) => handlers.get(accelerator)?.()
  }
}

describe('HudController', () => {
  it('passes pipeline state through untouched when no card is open', () => {
    const h = harness()
    const state: HudState = { ...IDLE_HUD_STATE, phase: 'listening', transcript: 'send the' }
    h.controller.setPipelineState(state)
    expect(h.sent.at(-1)).toEqual(state)
  })

  it('shows the card and takes over the phase while one is open', () => {
    const h = harness()
    h.controller.setPipelineState({ ...IDLE_HUD_STATE, phase: 'thinking' })
    h.controller.openCard(card, () => {})

    expect(h.sent.at(-1)?.phase).toBe('preview')
    expect(h.sent.at(-1)?.card).toBe(card)
  })

  it('does not let a finishing utterance clear a card the user is still reading', () => {
    const h = harness()
    h.controller.openCard(card, () => {})
    // The pipeline returns to idle underneath the open proposal.
    h.controller.setPipelineState({ ...IDLE_HUD_STATE, phase: 'idle' })

    expect(h.controller.hasCard).toBe(true)
    expect(h.sent.at(-1)?.card).toBe(card)
    expect(h.sent.at(-1)?.phase).toBe('preview')
  })

  it('keeps the pipeline’s transcript and app visible under the card', () => {
    const h = harness()
    h.controller.setPipelineState({
      ...IDLE_HUD_STATE,
      phase: 'thinking',
      transcript: 'make this crisp',
      app: { bundleId: 'com.apple.mail', name: 'Mail' }
    })
    h.controller.openCard(card, () => {})

    expect(h.sent.at(-1)?.transcript).toBe('make this crisp')
    expect(h.sent.at(-1)?.app?.name).toBe('Mail')
  })

  it('claims ⏎ and esc only for the life of the card', () => {
    const h = harness()
    expect(h.shortcuts.size).toBe(0)

    h.controller.openCard(card, () => {})
    expect(h.shortcuts).toEqual(new Set(['Return', 'Escape']))

    h.controller.closeCard()
    expect(h.shortcuts.size).toBe(0)
  })

  it('routes the global chords to the card’s handler', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(card, onAction)

    h.fire('Return')
    expect(onAction).toHaveBeenCalledWith('apply')
    expect(h.controller.hasCard).toBe(false)
  })

  it('releases the chords even when the handler throws', () => {
    const h = harness()
    h.controller.openCard(card, () => {
      throw new Error('apply blew up')
    })

    expect(() => h.controller.act('apply')).toThrow('apply blew up')
    expect(h.shortcuts.size).toBe(0)
    expect(h.controller.hasCard).toBe(false)
  })

  it('answers a card exactly once', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(card, onAction)

    h.fire('Return')
    h.fire('Escape') // a stale chord, or a click racing the keypress
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('makes the panel interactive only while a card is open', () => {
    const h = harness()
    h.controller.setPipelineState({ ...IDLE_HUD_STATE, phase: 'listening' })
    expect(h.interactive).toEqual([])

    h.controller.openCard(card, () => {})
    expect(h.interactive).toEqual([true])

    h.controller.updateCard(other) // streaming must not thrash the window flag
    expect(h.interactive).toEqual([true])

    h.controller.closeCard()
    expect(h.interactive).toEqual([true, false])
  })

  it('ignores updates and closes when nothing is open', () => {
    const h = harness()
    h.controller.updateCard(card)
    h.controller.closeCard()
    h.controller.act('apply')
    expect(h.controller.hasCard).toBe(false)
    expect(h.sent).toHaveLength(0)
  })
})

describe('HudController — the second commit', () => {
  const sendable: DiffCard = {
    kind: 'diff',
    app: 'Slack',
    segments: [],
    changes: 1,
    commit: { label: 'Apply & send', hint: '⌘⏎', warning: 'sending can’t be undone' }
  }

  it('claims ⌘⏎ only for a card that carries one', () => {
    const plain = harness()
    plain.controller.openCard(card, () => {})
    expect(plain.shortcuts.has('CommandOrControl+Return')).toBe(false)

    const h = harness()
    h.controller.openCard(sendable, () => {})
    expect(h.shortcuts.has('CommandOrControl+Return')).toBe(true)
  })

  it('delivers apply-send and closes, giving ⌘⏎ back', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(sendable, onAction)

    h.fire('CommandOrControl+Return')
    expect(onAction).toHaveBeenCalledWith('apply-send')
    expect(h.controller.hasCard).toBe(false)
    expect(h.shortcuts.size).toBe(0)
  })

  /**
   * The renderer is data-driven and cannot show a button the card does not
   * carry — but `act()` is also reachable over IPC, and a send that only the
   * card may authorise must be authorised by the card, not by the caller.
   */
  it('downgrades apply-send to apply on a card with no commit', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(card, onAction)

    h.controller.act('apply-send')
    expect(onAction).toHaveBeenCalledWith('apply')
    expect(onAction).not.toHaveBeenCalledWith('apply-send')
  })
})

describe('HudController — the bare-send card', () => {
  const sendCard = {
    kind: 'send' as const,
    app: 'Slack',
    text: 'I will get the code done in 2 days.',
    commit: { label: 'Send', hint: '⏎', warning: 'sending can’t be undone' }
  }

  it('claims ⌘⏎ for it', () => {
    const h = harness()
    h.controller.openCard(sendCard, () => {})
    expect(h.shortcuts.has('CommandOrControl+Return')).toBe(true)
  })

  /**
   * Mull holds Return globally while a card is open. On this card ⏎ means
   * nothing — but releasing it would let the press reach Slack and send the
   * very message the card is still asking about, so it stays claimed and is
   * swallowed.
   */
  it('swallows ⏎ rather than letting it through or closing the card', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(sendCard, onAction)

    h.fire('Return')
    expect(onAction).not.toHaveBeenCalled()
    expect(h.controller.hasCard).toBe(true)
    expect(h.shortcuts.has('Return')).toBe(true)

    // esc and ⌘⏎ still work.
    h.fire('CommandOrControl+Return')
    expect(onAction).toHaveBeenCalledWith('apply-send')
  })
})

/**
 * The card that proposes nothing.
 *
 * "Summarize all my tasks which I need to complete" used to arrive as a diff
 * card with Apply, offering to write the summary into the notes it had just
 * read — and ⏎ means Apply on every other card, so the keystroke that dismisses
 * a card would have pasted it in. There is nothing here to apply, and unlike
 * the send card there is nothing at risk either, so ⏎ is free to mean "done".
 */
describe('HudController — the answer card', () => {
  const answerCard = {
    kind: 'answer' as const,
    app: 'Notes',
    text: 'Three tasks: the ACT agent, the rag→mcp conversion, and wiring real config.'
  }

  it('never delivers an apply, whatever asks for one', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(answerCard, onAction)

    h.fire('Return')
    expect(onAction).not.toHaveBeenCalledWith('apply')
    expect(onAction).not.toHaveBeenCalledWith('apply-send')
  })

  /** ⏎ closes it. A Done button whose hint did nothing would be a printed lie. */
  it('reads ⏎ as done', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(answerCard, onAction)

    h.fire('Return')
    expect(onAction).toHaveBeenCalledWith('cancel')
    expect(h.controller.hasCard).toBe(false)
  })

  it('cannot be talked into a commit it does not have', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(answerCard, onAction)

    // The downgrade path: apply-send becomes apply, which becomes cancel here.
    h.controller.act('apply-send')
    expect(onAction).toHaveBeenCalledWith('cancel')
    expect(onAction).not.toHaveBeenCalledWith('apply-send')
  })
})

/**
 * The card that outlives its own Apply.
 *
 * Every other card is a question: the press is the answer and the card is done.
 * A plan's Run is not an answer, it is a start — the card becomes the transcript
 * of what the run is doing, and esc becomes the only way to stop it. Closing it
 * on the press, as `act` did for every card alike, made every later
 * `updateCard` a silent no-op and gave Escape back to the app being driven, so
 * the step list never appeared and Stop could not be pressed.
 */
describe('HudController — a run', () => {
  const plan: PlanCard = {
    kind: 'plan',
    steps: [],
    context: null,
    goal: 'what did Anil say about the terms doc',
    app: 'Slack',
    limit: 40,
    running: false,
    startsRun: true
  }
  /** The tray's demo: a plan card that proposes nothing and runs nothing. */
  const demoPlan: PlanCard = { kind: 'plan', steps: [], context: 'demo — nothing runs' }
  const walking: PlanCard = {
    ...plan,
    running: true,
    steps: [{ id: 'nav-0', verb: 'press', object: '“Search”', state: 'running' }]
  }

  it('keeps the card, and the chords, when Run starts something', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(plan, onAction)

    h.fire('Return')
    expect(onAction).toHaveBeenCalledWith('apply')
    expect(h.controller.hasCard).toBe(true)
    expect(h.shortcuts).toEqual(new Set(['Return', 'Escape']))
    // No close-and-reopen: the window flag must not thrash under the user.
    expect(h.interactive).toEqual([true])
  })

  // The regression test. On the old `act` this card was already gone, so the
  // update was swallowed by `updateCard`'s `if (!this.card) return`.
  it('lets the run write onto the card that started it', () => {
    const h = harness()
    h.controller.openCard(plan, () => {})
    h.controller.act('apply')

    h.controller.updateCard(walking)
    expect(h.sent.at(-1)?.card).toBe(walking)
  })

  it('closes anyway when the handler throws on its way to starting', () => {
    const h = harness()
    h.controller.openCard(plan, () => {
      throw new Error('the run never began')
    })

    expect(() => h.controller.act('apply')).toThrow('the run never began')
    expect(h.controller.hasCard).toBe(false)
    expect(h.shortcuts.size).toBe(0)
  })

  it('closes when the handler starts nothing and shuts the card itself', () => {
    const h = harness()
    const onAction = vi.fn(() => h.controller.closeCard())
    h.controller.openCard(plan, onAction)

    h.controller.act('apply')
    expect(h.controller.hasCard).toBe(false)
    expect(h.shortcuts.size).toBe(0)

    h.controller.act('apply')
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('swallows ⏎ once the run is under way', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(plan, onAction)
    h.controller.act('apply')
    h.controller.updateCard(walking)

    h.fire('Return')
    h.controller.act('apply-send')
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(h.controller.hasCard).toBe(true)
    // Claimed, not released — the app underneath is one the run is driving.
    expect(h.shortcuts.has('Return')).toBe(true)
  })

  /**
   * The gap this exists for: between Run being delivered and the lane's first
   * draw, the card still says `running: false`. A lane that starts a subprocess
   * spends several hundred milliseconds there, and Return auto-repeats.
   */
  it('swallows ⏎ before the run has drawn its first frame', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(plan, onAction)

    h.fire('Return')
    h.fire('Return')
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('keeps the card up when esc stops a run, so the stop is readable', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(plan, onAction)
    h.controller.act('apply')
    h.controller.updateCard(walking)

    h.fire('Escape')
    expect(onAction).toHaveBeenCalledWith('cancel')
    expect(h.controller.hasCard).toBe(true)
  })

  it('answers esc normally again once the run says it is over', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(plan, onAction)
    h.controller.act('apply')
    h.controller.updateCard(walking)
    h.controller.updateCard({ ...walking, running: false })

    h.fire('Escape')
    expect(onAction).toHaveBeenLastCalledWith('cancel')
    expect(h.controller.hasCard).toBe(false)
    expect(h.shortcuts.size).toBe(0)
  })

  /**
   * A new utterance takes the panel. Escape can afford to wait for the run's
   * ending to appear on the card; this cannot — the user is already speaking.
   */
  it('hands the panel over when a new utterance arrives mid-run', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(plan, onAction)
    h.controller.act('apply')
    h.controller.updateCard(walking)

    h.controller.cancelOpen()
    expect(onAction).toHaveBeenLastCalledWith('cancel')
    expect(h.controller.hasCard).toBe(false)
    expect(h.shortcuts.size).toBe(0)
  })

  /**
   * Keyed on the card's own field rather than on `kind`, so the tray's demo —
   * whose handler only logs — closes like anything else instead of holding ⏎
   * and esc for the rest of the session.
   */
  it('a plan that runs nothing closes like any other card', () => {
    const h = harness()
    h.controller.openCard(demoPlan, () => {})

    h.fire('Return')
    expect(h.controller.hasCard).toBe(false)
    expect(h.shortcuts.size).toBe(0)
  })

  /**
   * The blast radius, asserted directly.
   *
   * `startsRun` is declared on `PlanCard` alone, so no other kind can reach the
   * keep-open branch even in principle — but that is a fact about the types, and
   * this is the behaviour anyone changing `act` will actually break.
   */
  it.each([
    ['a diff card', card],
    [
      'a diff card with a commit',
      {
        kind: 'diff',
        app: 'Slack',
        segments: [],
        changes: 1,
        commit: { label: 'Apply & send', hint: '⌘⏎', warning: 'sending can’t be undone' }
      } satisfies HudCard
    ],
    [
      'a send card',
      {
        kind: 'send',
        app: 'Slack',
        text: 'on my way',
        commit: { label: 'Send', hint: '⏎', warning: 'sending can’t be undone' }
      } satisfies HudCard
    ],
    ['an answer card', { kind: 'answer', app: 'Notes', text: 'three tasks' } satisfies HudCard],
    ['a plan card that runs nothing', demoPlan]
  ])('still answers %s once and gives the chords straight back', (_name, subject) => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(subject, onAction)

    h.controller.act(subject.kind === 'send' ? 'apply-send' : 'apply')
    expect(h.controller.hasCard).toBe(false)
    expect(h.shortcuts.size).toBe(0)
  })
})

/**
 * A finished plan, and the bug the card family closes.
 *
 * `running` going false put the **Run** button straight back on a card that had
 * already walked, so ⏎ on a finished navigation started the whole thing again —
 * in somebody else's window. The family says the card is a report now, and both
 * the button and the key follow it.
 */
describe('HudController — a plan that has finished walking', () => {
  const walked = {
    kind: 'plan' as const,
    steps: [{ id: 'a', verb: 'press', object: 'Anil Turaga', state: 'done' as const }],
    context: null,
    goal: 'open the conversation with Anil Turaga',
    app: 'Slack',
    limit: 6,
    running: false,
    answer: 'The redlines are with legal.'
  }

  it('never runs it a second time', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(walked, onAction)

    h.fire('Return')
    expect(onAction).not.toHaveBeenCalledWith('apply')
    expect(onAction).toHaveBeenCalledWith('cancel')
    expect(h.controller.hasCard).toBe(false)
  })

  /** A plan still waiting on Run is untouched: ⏎ is how you start it. */
  it('leaves an unrun plan alone', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard({ ...walked, steps: [], answer: null }, onAction)

    h.fire('Return')
    expect(onAction).toHaveBeenCalledWith('apply')
  })
})
