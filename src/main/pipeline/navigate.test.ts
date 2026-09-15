import { describe, expect, it, vi } from 'vitest'
import type { ScreenContext } from '@shared/context'
import type { HudCard, PlanCard } from '@shared/hud'
import type { NavStep } from '@shared/nav'
import type { UiTarget } from '@shared/sidecar-api'
import type { HudLastAction } from '@shared/ipc'
import type { JournalDraft, JournalEntry } from '@shared/types'
import { FakeSidecar } from '../services/sidecar'
import type { AnswerRequest, Engine, NavigateRequest } from '../engine/types'
import type { JournalStore } from '../store/journal'
import type { CaptureStore } from '../store/captures'
import { ActionExecutor } from './actions'
import { ChordScope } from '../services/chords'
import { HudController } from '../services/hud'
import { NavigateLane, describeChange } from './navigate'

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
  /** Every `navigate` call, so a test can assert what history said. */
  const navRequests: NavigateRequest[] = []
  const engine = {
    name: 'test',
    model: null,
    ready: async () => ({ kind: 'ready' as const }),
    classify: async () => ({ kind: 'dictate' as const }),
    transform: async () => ({ text: '' }),
    compose: async () => ({ text: '' }),
    navigate: async (req: NavigateRequest) => {
      asked.push(asked.length)
      navRequests.push(req)
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
  /** Every row written through this store — the lane's and the executor's. */
  const rows: JournalDraft[] = []
  /** Annotations added after the fact, once a step's effect became visible. */
  const amendments: Array<{ id: string; patch: { detail?: object; ms?: number } }> = []
  /** What the picture store was asked to file, and under which row id. */
  const filed: Array<{ id: string; context: ScreenContext | null | undefined }> = []
  const notices: string[] = []
  /** The row the lane leaves for the idle panel. */
  const lastActions: Array<HudLastAction | undefined> = []

  /**
   * A real `HudController`, not a stub.
   *
   * The stub it replaces had a no-op `closeCard` and an `updateCard` that always
   * appended, which meant no test in this file could observe the card's actual
   * lifetime — and the card was in fact being closed the instant Run was
   * pressed, so every later `draw()` was swallowed and Escape went back to the
   * app being driven. A fake that cannot fail is worse than no fake, because it
   * is budgeted for.
   *
   * `cards` is collected from the port rather than from the calls, so it holds
   * what the renderer would actually have been sent.
   */
  const shortcuts = new Set<string>()
  const handlers = new Map<string, () => void>()
  const controller = new HudController({
    port: {
      send: (state) => {
        if (state.card) cards.push(state.card as PlanCard)
      },
      setInteractive: () => {}
    },
    chords: new ChordScope({
      globalShortcut: {
        register: (accelerator, callback) => {
          shortcuts.add(accelerator)
          handlers.set(accelerator, callback)
          return true
        },
        unregister: (accelerator) => {
          shortcuts.delete(accelerator)
          handlers.delete(accelerator)
        }
      }
    })
  })

  // One store behind both writers, as in production: the executor files a row
  // per step and the lane files one for the whole expedition, and the grouping
  // only means anything if they land in the same place.
  const journal = {
    append: (draft: JournalDraft) => {
      const entry = { ...draft, id: draft.id ?? `row-${rows.length}`, at: 0 }
      rows.push(entry)
      return entry as unknown as JournalEntry
    },
    amend: (id: string, patch: { detail?: object; ms?: number }) => {
      amendments.push({ id, patch })
      const row = rows.find((r) => r.id === id)
      if (row) row.detail = { ...(row.detail ?? {}), ...(patch.detail ?? {}) }
    }
  }

  const lane = new NavigateLane({
    sidecar,
    engine,
    executor: new ActionExecutor({ sidecar, sleep: async () => {}, journal }),
    sleep: async () => {},
    journal: journal as unknown as JournalStore,
    captures: {
      save: (id: string, context: ScreenContext | null | undefined) => {
        filed.push({ id, context })
        return context ? ({ imageFile: `${id}.jpg`, chars: context.chars } as never) : null
      }
    } as unknown as CaptureStore,
    hud: {
      openCard: (card: HudCard, onAction) => controller.openCard(card, onAction),
      updateCard: (card: HudCard) => controller.updateCard(card),
      closeCard: () => controller.closeCard(),
      announce: (_phase, notice, lastAction) => {
        notices.push(notice)
        lastActions.push(lastAction)
      }
    }
  })
  return {
    sidecar,
    lane,
    cards,
    asked,
    answers,
    navRequests,
    rows,
    filed,
    notices,
    amendments,
    /** The expedition's own row, as opposed to the executor's per-step ones. */
    planRow: () =>
      rows.find(
        (row) => row.intent.kind === 'command' && row.intent.verb === 'nav.plan'
      ),
    /** The rows the executor wrote, in the order the steps happened. */
    stepRows: () =>
      rows.filter(
        (row) => row.intent.kind === 'command' && row.intent.verb.startsWith('nav.')
          && row.intent.verb !== 'nav.plan'
      ),
    lastActions,
    controller,
    /** Which global chords the card is holding right now. */
    shortcuts,
    /** Press one, exactly as `globalShortcut` would. */
    fire: (accelerator: string) => handlers.get(accelerator)?.(),
    run: () => controller.act('apply'),
    cancel: () => controller.act('cancel'),
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

/**
 * The evidence a step leaves behind.
 *
 * This is the trace that prompted the work: a press opened Slack's search
 * overlay, the target list went from 300 entries to 6, the window title did not
 * move — and history said "the window is still …", so the model gave up one
 * step from the answer.
 */
describe('did that step do anything', () => {
  it('reads a replaced target list as movement, whatever the title says', () => {
    const before = { harvestId: 'a', targets: targets(...Array.from({ length: 300 }, (_, i) => `row ${i}`)) }
    const after = { harvestId: 'b', targets: targets('row 0', 'Cancel', 'Go', 'Recent', 'Filter', 'Clear') }
    const change = describeChange(before, after)
    expect(change.moved).toBe(true)
    expect(change.detail).toContain('300 things to press became 6')
  })

  it('does not call a message arriving mid-plan a change', () => {
    // The false-positive this threshold exists for: Slack gains a row on its
    // own, and calling that "the press worked" is the confidence being removed.
    const before = { harvestId: 'a', targets: targets(...Array.from({ length: 40 }, (_, i) => `row ${i}`)) }
    const after = {
      harvestId: 'b',
      targets: targets(...Array.from({ length: 41 }, (_, i) => `row ${i}`))
    }
    const change = describeChange(before, after)
    expect(change.moved).toBe(false)
    expect(change.detail).toContain('did not change')
  })

  it('tells the next turn what the last press actually did', async () => {
    const h = harness(
      [
        { verb: 'press', index: 0, label: 'Search' },
        { verb: 'read' }
      ],
      targets('Search', 'Anil Turaga', 'Prahastha', 'General', 'Random')
    )
    // Pressing Search replaces the window, exactly as Slack does.
    h.sidecar.onTargetAction = () => h.sidecar.retarget(['Cancel', 'Clear'])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    const second = h.navRequests[1]
    expect(second?.history[0]?.detail).toContain('the window changed')
    expect(second?.history[0]?.detail).toContain('5 things to press became 2')
  })
})

/**
 * Giving up is a different outcome from arriving, and used to be recorded as
 * the same one: a run that pressed four things and found nothing was filed as
 * `applied` with the excuse as its answer.
 */
describe('giving up', () => {
  it('tries once more when it surrenders with budget to spare', async () => {
    const h = harness([
      { verb: 'done', found: false, because: 'I cannot find that conversation' },
      { verb: 'press', index: 1, label: 'Anil Turaga' },
      { verb: 'read' }
    ])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    // It was asked again, and the surrender was fed back as something to
    // answer for. (`history` is one array shared by reference across every
    // request, so this asserts on content rather than on a position in it.)
    expect(h.asked.length).toBeGreaterThanOrEqual(2)
    const fedBack = h.navRequests[1]?.history.filter((a) =>
      a.detail.includes('done(found:false)')
    )
    expect(fedBack).toHaveLength(1)
    // And having tried again, it got there.
    expect(h.last().answer).toContain('redlines')
  })

  it('accepts the second refusal rather than arguing with itself', async () => {
    const h = harness([
      { verb: 'done', found: false, because: 'not here' },
      { verb: 'done', found: false, because: 'still not here' }
    ])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.asked.length).toBe(2)
    expect(h.planRow()?.status).toBe('failed')
  })

  it('does not re-ask when there is no budget left to use', async () => {
    const h = harness([{ verb: 'done', found: false, because: 'nope' }], targets('Search'))
    // One step of budget: a retry could only produce the same answer again.
    ;(h.lane as unknown as { maxSteps: number }).maxSteps = 1
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))
    expect(h.asked.length).toBe(1)
  })

  it('files a surrender as failed, and hands the panel the reason', async () => {
    const h = harness([
      { verb: 'done', found: false, because: 'not here' },
      { verb: 'done', found: false, because: 'still not here' }
    ])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.planRow()?.status).toBe('failed')
    expect(h.lastActions.at(-1)?.result).toContain('still not here')
  })
})

/**
 * The panel used to go on showing the previous *dictation* after a plan, because
 * this lane announced with two arguments and never passed a row of its own.
 */
describe('what the panel says afterwards', () => {
  it('leaves behind the answer, not the question', async () => {
    const h = harness([{ verb: 'press', index: 1, label: 'Anil Turaga' }, { verb: 'read' }])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    const row = h.lastActions.at(-1)
    expect(row?.result).toContain('redlines are with legal')
    expect(row?.summary).toContain('Slack')
    expect(row?.entryId).toBe(h.planRow()?.id)
    // Nothing was written anywhere, so nothing is offered as undoable.
    expect(row?.undoable).toBe(false)
  })
})

/**
 * The journal used to record an expedition as five unrelated COMMAND rows that
 * happened to share a minute — a plan, and its presses, with nothing tying them
 * together and no way to tell where seventeen seconds went.
 */
describe('what the journal keeps', () => {
  it('ties every step to the expedition that took it', async () => {
    const h = harness([
      { verb: 'press', index: 1, label: 'Anil Turaga' },
      { verb: 'read' }
    ])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    const plan = h.planRow()
    expect(plan?.groupId).toBe(plan?.id)
    // Every step points at the plan, including the ones written before the
    // plan's own row existed — which is why the id is made up front.
    expect(h.stepRows().map((row) => row.groupId)).toEqual([plan?.id, plan?.id])
    expect(h.stepRows().map((row) => row.detail?.step)).toEqual([1, 2])
  })

  it('records how long each step took and what it was choosing from', async () => {
    const h = harness(
      [{ verb: 'press', index: 1, label: 'Anil Turaga' }, { verb: 'read' }],
      targets('Search', 'Anil Turaga', 'Prahastha')
    )
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    const [first] = h.stepRows()
    expect(first?.ms).toBeGreaterThanOrEqual(0)
    expect(first?.detail?.scan).toMatchObject({ targets: 3, press: 3, stoppedBy: 'complete' })
    expect(h.planRow()?.ms).toBeGreaterThanOrEqual(0)
  })

  it('goes back and writes down what a press turned out to do', async () => {
    // The evidence does not exist when the row is written — it takes the next
    // look at the window to find out — so the row is annotated afterwards.
    const h = harness(
      [{ verb: 'press', index: 0, label: 'Search' }, { verb: 'read' }],
      targets('Search', 'Anil Turaga', 'Prahastha', 'General', 'Random')
    )
    h.sidecar.onTargetAction = () => h.sidecar.retarget(['Cancel', 'Clear'])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.amendments).toHaveLength(1)
    expect(h.amendments[0]?.id).toBe(h.stepRows()[0]?.id)
    expect(h.stepRows()[0]?.detail?.evidence).toContain('5 things to press became 2')
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

  /**
   * The other Escape, which until now could not happen at all: the card was
   * closed the instant Run was pressed, so the chord was released and nothing
   * could deliver a cancel to a walk in flight.
   */
  it('stops a walk that has started, and still puts the window back', async () => {
    const h = harness([
      { verb: 'press', index: 1, label: 'Anil Turaga' },
      { verb: 'press', index: 0, label: 'Search' },
      { verb: 'read' }
    ])
    await h.lane.propose(request)
    // The card is holding the chords for the whole run — that is the stop.
    expect(h.shortcuts).toEqual(new Set(['Return', 'Escape']))
    // As soon as the first press lands, the user hits esc.
    h.sidecar.onTargetAction = () => h.fire('Escape')
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    // One press, not three: the loop checked between steps and stopped.
    expect(h.sidecar.targetActions.filter((a) => a.verb === 'press')).toHaveLength(1)
    expect(h.sidecar.activated).toContain('com.tinyspeck.slackmacgap')
  })

  /**
   * A stop is not a decline, and the difference is the whole reason this has
   * its own branch. Declining files "nothing was pressed"; said after a press
   * has landed that is the journal lying about the one thing it exists to
   * record, because a press already dispatched cannot be un-pressed.
   */
  it('files a stop as the plan’s own row, never as a decline', async () => {
    const h = harness([
      { verb: 'press', index: 1, label: 'Anil Turaga' },
      { verb: 'read' }
    ])
    await h.lane.propose(request)
    h.sidecar.onTargetAction = () => h.fire('Escape')
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.rows.some((row) => row.summary.startsWith('Declined ·'))).toBe(false)
    const plan = h.planRow()
    expect(plan?.status).toBe('failed')
    expect(h.stepRows().length).toBeGreaterThan(0)
    // And the card says so, rather than implying nothing happened.
    expect(h.last().note).toMatch(/stays pressed/)
    expect(h.notices.join(' ')).not.toMatch(/nothing was pressed/)
  })

  it('leaves ⏎ claimed and inert while the walk is running', async () => {
    const h = harness([
      { verb: 'press', index: 1, label: 'Anil Turaga' },
      { verb: 'read' }
    ])
    await h.lane.propose(request)
    // Mull holds Return globally, and the window underneath is Slack — a press
    // that got through would land in whatever the walk has just opened.
    h.sidecar.onTargetAction = () => h.fire('Return')
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    // The walk was neither restarted nor cut short: it read, and it answered.
    expect(h.answers).toHaveLength(1)
    expect(h.last().answer).toMatch(/redlines/)
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

    // One expedition row, plus the executor's row per step.
    expect(h.stepRows()).toHaveLength(2)
    const row = h.planRow()
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
    expect(h.planRow()?.status).toBe('cancelled')
    expect(h.planRow()?.capture).not.toBeNull()
    expect(h.sidecar.targetActions).toEqual([])
  })

  it('says plainly that it found nothing, rather than claiming it did', async () => {
    const h = harness([{ verb: 'done', because: 'no such conversation here' }])
    await h.lane.propose(withPicture)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.planRow()?.status).toBe('failed')
    expect(h.planRow()?.after ?? null).toBeNull()
    expect(h.planRow()?.verified).toBe(false)
  })
})
