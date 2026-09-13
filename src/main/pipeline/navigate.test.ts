import { describe, expect, it, vi } from 'vitest'
import type { ScreenContext } from '@shared/context'
import type { HudCard, PlanCard } from '@shared/hud'
import type { NavStep } from '@shared/nav'
import type { UiTarget } from '@shared/sidecar-api'
import type { JournalDraft, JournalEntry } from '@shared/types'
import { FakeSidecar } from '../services/sidecar'
import type { AnswerRequest, Engine } from '../engine/types'
import type { JournalStore } from '../store/journal'
import type { CaptureStore } from '../store/captures'
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
  /** Every `answer` call, so a test can assert what the last turn was shown. */
  const answers: AnswerRequest[] = []
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
    },
    answer: async (request: AnswerRequest, onPartial?: (text: string) => void) => {
      answers.push(request)
      onPartial?.('The redlines')
      return { text: 'The redlines are with legal; Anil expects them Thursday.' }
    }
  } satisfies Engine

  const cards: PlanCard[] = []
  /** Rows the *lane* wrote. The executor's per-step rows go to its own store. */
  const rows: JournalDraft[] = []
  /** What the picture store was asked to file, and under which row id. */
  const filed: Array<{ id: string; context: ScreenContext | null | undefined }> = []
  const notices: string[] = []
  let act: ((action: 'apply' | 'apply-send' | 'cancel') => void) | null = null
  const lane = new NavigateLane({
    sidecar,
    engine,
    executor: new ActionExecutor({ sidecar, sleep: async () => {} }),
    sleep: async () => {},
    journal: {
      append: (draft: JournalDraft) => {
        rows.push(draft)
        return { ...draft, at: 0 } as unknown as JournalEntry
      }
    } as unknown as JournalStore,
    captures: {
      save: (id: string, context: ScreenContext | null | undefined) => {
        filed.push({ id, context })
        return context ? ({ imageFile: `${id}.jpg`, chars: context.chars } as never) : null
      }
    } as unknown as CaptureStore,
    hud: {
      openCard: (card: HudCard, onAction) => {
        cards.push(card as PlanCard)
        act = onAction
      },
      updateCard: (card: HudCard) => cards.push(card as PlanCard),
      closeCard: () => {},
      announce: (_phase, notice) => notices.push(notice)
    }
  })
  return {
    sidecar,
    lane,
    cards,
    asked,
    answers,
    rows,
    filed,
    notices,
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

/**
 * The last step, and the one the whole expedition is for.
 *
 * This lane shipped without it. It would walk to the right conversation,
 * capture it, walk back, and put `51 blocks · 6023 chars` on the card — a
 * receipt for work, handed to someone who had asked what a conversation said.
 * Every mechanical assertion above passed the entire time.
 */
describe('the answer', () => {
  it('turns what it read into something a person can read', async () => {
    const h = harness([
      { verb: 'press', index: 1, label: 'Anil Turaga' },
      { verb: 'read' }
    ])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.last().answer).toBe('The redlines are with legal; Anil expects them Thursday.')
    // And never a byte count where the answer goes.
    expect(h.last().answer).not.toMatch(/\bblocks\b|\bchars\b/u)
  })

  /**
   * The answer turn is shown the window it walked TO, not the one the user was
   * looking at when they spoke. Getting this backwards would answer every
   * question from the conversation the user could already see, which is both
   * wrong and impossible to notice — the sentences would look fine.
   */
  it('is asked about the window it arrived at, not the one it left', async () => {
    const h = harness([
      { verb: 'press', index: 1, label: 'Anil Turaga' },
      { verb: 'read' }
    ])
    await h.lane.propose({
      ...request,
      context: {
        app: request.app,
        windowTitle: 'somewhere else entirely',
        blocks: [{ role: 'AXStaticText', text: 'the window they were looking at' }],
        truncated: false,
        image: null,
        imageReason: 'not-requested',
        chars: 31,
        harvestMs: 1
      } as ScreenContext
    })
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.answers).toHaveLength(1)
    expect(h.answers[0]?.goal).toBe(request.goal)
    const seen = h.answers[0]?.context?.blocks.map((block) => block.text).join(' ') ?? ''
    expect(seen).toContain('redlines are with legal')
    expect(seen).not.toContain('the window they were looking at')
  })

  it('does not ask when there was nothing to read', async () => {
    const h = harness([{ verb: 'done', because: 'no such conversation here' }])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.answers).toEqual([])
    expect(h.last().answer ?? null).toBeNull()
    // The model's own reason survives to the card, rather than being replaced
    // by a cheerier one.
    expect(h.last().note).toContain('no such conversation here')
  })

  /**
   * The walk worked and only the last turn failed. Saying "51 blocks" here
   * would be the original bug wearing a different hat; saying nothing would be
   * worse. It reports getting there and not being able to say what it saw —
   * and still goes home.
   */
  it('stays honest when it cannot say what it found', async () => {
    const h = harness([
      { verb: 'press', index: 1, label: 'Anil Turaga' },
      { verb: 'read' }
    ])
    h.answers.length = 0
    const lane = h.lane as unknown as { deps: { engine: Engine } }
    lane.deps.engine.answer = async () => {
      throw new Error('the engine is offline')
    }

    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.last().answer ?? null).toBeNull()
    expect(h.last().note).toMatch(/couldn’t summarise/u)
    expect(h.sidecar.activated).toContain('com.tinyspeck.slackmacgap')
  })
})

/**
 * The receipt.
 *
 * The executor writes a row per press, and none of them can carry a picture:
 * each is written the moment its step happens, and the photograph was taken at
 * key-down before there was a plan. So a session spent navigating produced a
 * journal with no "What Mull saw" on any row — indistinguishable, from the
 * outside, from Mull never having looked at the screen at all.
 */
describe('the journal row', () => {
  const withPicture = {
    ...request,
    context: {
      app: request.app,
      windowTitle: 'Slack',
      blocks: [{ role: 'AXStaticText', text: 'what was on screen' }],
      truncated: false,
      image: { mediaType: 'image/jpeg', dataBase64: 'x', width: 10, height: 10, bytes: 4 },
      imageReason: null,
      chars: 18,
      harvestMs: 3
    } as ScreenContext
  }

  it('files the picture the model was actually shown', async () => {
    const h = harness([
      { verb: 'press', index: 1, label: 'Anil Turaga' },
      { verb: 'read' }
    ])
    await h.lane.propose(withPicture)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.rows).toHaveLength(1)
    const [row] = h.rows
    expect(row?.capture).not.toBeNull()
    expect(row?.after).toContain('redlines')
    expect(row?.status).toBe('applied')
    expect(row?.undoable).toBe(false)
    // Filed under the row's own id, or the picture is of nothing in particular.
    expect(h.filed[0]?.id).toBe(row?.id)
    expect(h.filed[0]?.context).toBe(withPicture.context)
  })

  /**
   * Declining the plan is exactly when somebody checking up on Mull would look,
   * and it is the case where a capture with no row would otherwise happen: the
   * window was read during the hold whether or not the user pressed Run.
   */
  it('is written even when the user declines', async () => {
    const h = harness([{ verb: 'press', index: 1, label: 'Anil Turaga' }])
    await h.lane.propose(withPicture)
    h.cancel()

    expect(h.rows).toHaveLength(1)
    expect(h.rows[0]?.status).toBe('cancelled')
    expect(h.rows[0]?.capture).not.toBeNull()
    expect(h.sidecar.targetActions).toEqual([])
  })

  it('says plainly that it found nothing, rather than claiming it did', async () => {
    const h = harness([{ verb: 'done', because: 'no such conversation here' }])
    await h.lane.propose(withPicture)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.rows[0]?.status).toBe('failed')
    expect(h.rows[0]?.after ?? null).toBeNull()
    expect(h.rows[0]?.verified).toBe(false)
  })
})
