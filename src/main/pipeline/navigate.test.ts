import { describe, expect, it, vi } from 'vitest'
import type { HudCard, PlanCard } from '@shared/hud'
import type { NavStep } from '@shared/nav'
import type { UiTarget } from '@shared/sidecar-api'
import { FakeSidecar } from '../services/sidecar'
import type { Engine } from '../engine/types'
import { ActionExecutor } from './actions'
import { NavigateLane } from './navigate'

/**
 * The loop, and the two things about it that are not obvious.
 *
 * 1. **Nothing happens until Run.** `propose` puts a card up and returns. A
 *    plan that pressed anything before the user read it would make the card
 *    decorative, which is the failure the whole design is built to avoid.
 * 2. **`restore` always runs.** Finished, cancelled, out of budget, thrown —
 *    every exit goes back to where the user was.
 */

const targets = (...titles: string[]): UiTarget[] =>
  titles.map((title, index) => ({
    index,
    role: 'AXRow',
    subrole: null,
    title,
    help: null,
    value: null,
    frame: null,
    actions: ['AXPress'],
    enabled: true,
    focused: false,
    kind: 'press' as const
  }))

function harness(steps: NavStep[], listed: UiTarget[] = targets('Search', 'Anil Turaga')) {
  const sidecar = new FakeSidecar({
    accessibility: true,
    targets: listed,
    app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 900 },
    // `read` succeeds only when the window actually says something — an empty
    // one is a failed read, not a successful capture of nothing.
    context: ['Anil: the redlines are with legal', 'Anil: should land Thursday']
  })
  const asked: number[] = []
  const engine = {
    name: 'test',
    model: null,
    ready: async () => ({ kind: 'ready' as const }),
    classify: async () => ({ kind: 'dictate' as const }),
    transform: async () => ({ text: '' }),
    compose: async () => ({ text: '' }),
    navigate: async () => {
      asked.push(asked.length)
      const next = steps[asked.length - 1]
      if (!next) throw new Error('the test ran out of steps')
      return next
    }
  } satisfies Engine

  const cards: PlanCard[] = []
  let act: ((action: 'apply' | 'apply-send' | 'cancel') => void) | null = null
  const lane = new NavigateLane({
    sidecar,
    engine,
    executor: new ActionExecutor({ sidecar, sleep: async () => {} }),
    sleep: async () => {},
    hud: {
      openCard: (card: HudCard, onAction) => {
        cards.push(card as PlanCard)
        act = onAction
      },
      updateCard: (card: HudCard) => cards.push(card as PlanCard),
      closeCard: () => {}
    }
  })
  return {
    sidecar,
    lane,
    cards,
    asked,
    run: () => act?.('apply'),
    cancel: () => act?.('cancel'),
    last: () => cards[cards.length - 1] as PlanCard
  }
}

const request = {
  goal: 'what did Anil say about the terms doc',
  transcript: 'what did Anil say about the terms doc',
  app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' }
}

describe('propose', () => {
  it('puts up a card and presses nothing', async () => {
    const h = harness([{ verb: 'done', because: 'never reached' }])
    await h.lane.propose(request)

    expect(h.cards).toHaveLength(1)
    expect(h.last()).toMatchObject({
      kind: 'plan',
      goal: request.goal,
      app: 'Slack',
      steps: [],
      running: false
    })
    // The card says what it is before the user decides anything.
    expect(h.last().note).toContain('nothing is written or sent')
    expect(h.sidecar.targetActions).toEqual([])
    expect(h.asked).toEqual([])
  })
})

describe('Run', () => {
  it('walks, shows each step as it happens, and comes back', async () => {
    const h = harness([
      { verb: 'press', index: 1, label: 'Anil Turaga' },
      { verb: 'read' }
    ])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    const steps = h.last().steps
    expect(steps.map((step) => step.verb)).toEqual(['press', 'read'])
    expect(steps.every((step) => step.state === 'done')).toBe(true)
    expect(h.sidecar.targetActions[0]).toEqual({ verb: 'press', index: 1 })
    // Back where the user was, on the way out.
    expect(h.sidecar.activated).toContain('com.tinyspeck.slackmacgap')
  })

  /**
   * The budget is not advisory. A navigator that needs seven presses to find a
   * conversation is lost, and the honest end to being lost is a sentence on a
   * card rather than another press.
   */
  it('stops at the step budget rather than pressing on', async () => {
    const many: NavStep[] = Array.from({ length: 20 }, (_, i) => ({
      verb: 'press' as const,
      index: i % 2,
      label: 'Anil Turaga'
    }))
    const h = harness(many)
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))
    expect(h.last().steps.length).toBeLessThanOrEqual(6)
  })

  /**
   * A step the model asked for that could not be parsed, or an engine that
   * refused. The plan ends; it is never repaired. There is no equivalent of
   * "fall back to dictation" once the action is a keystroke in someone's window.
   */
  it('ends the plan when the engine gives it nothing usable', async () => {
    const h = harness([])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))
    expect(h.last().steps).toEqual([])
    // And still went home.
    expect(h.sidecar.activated).toContain('com.tinyspeck.slackmacgap')
  })

  it('reports a refused step on the card rather than swallowing it', async () => {
    const h = harness(
      [{ verb: 'press', index: 0, label: 'Leave channel' }],
      targets('Leave channel', 'Anil Turaga')
    )
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    const [step] = h.last().steps
    expect(step?.state).toBe('failed')
    expect(step?.object).toContain('won’t press')
    expect(h.sidecar.targetActions).toEqual([])
  })
})

describe('Escape', () => {
  it('stops before the card is run, and never starts', async () => {
    const h = harness([{ verb: 'press', index: 1, label: 'Anil Turaga' }])
    await h.lane.propose(request)
    h.cancel()
    expect(h.sidecar.targetActions).toEqual([])
    expect(h.asked).toEqual([])
  })
})
