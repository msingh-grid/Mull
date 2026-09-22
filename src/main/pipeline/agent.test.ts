import { describe, expect, it, vi } from 'vitest'
import type { ScreenContext } from '@shared/context'
import type { HudCard, PlanCard } from '@shared/hud'
import type { HudLastAction } from '@shared/ipc'
import type { UiTarget } from '@shared/sidecar-api'
import type { JournalDraft, JournalEntry } from '@shared/types'
import { FakeSidecar } from '../services/sidecar'
import { ChordScope } from '../services/chords'
import { HudController } from '../services/hud'
import type { AnswerRequest, Engine } from '../engine/types'
import type { AgentRunResult } from '../engine/agent-loop'
import type { JournalStore } from '../store/journal'
import type { CaptureStore } from '../store/captures'
import { ActionExecutor } from './actions'
import { AgentLane, endingNote } from './agent'

/**
 * The lane, with the loop faked.
 *
 * The loop itself is tested in `engine/agent-loop.test.ts`; what matters here is
 * everything around it, and it is the same list as `NavigateLane`'s:
 *
 *   nothing happens until Run
 *   the card is the transcript, and it survives the press that starts it
 *   Escape stops it, and a stop is not a decline
 *   `restore` always runs
 *   the answer is a separate turn, in a different voice
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

/** What the model does, as a script the fake loop plays through the handlers. */
type Move =
  | { tool: 'look'; want: 'text' | 'targets' | 'both' }
  | { tool: 'find'; query: string }
  | { tool: 'press'; index: number; title: string }
  | { tool: 'setText'; index: number; title: string; text: string }
  | { tool: 'apps' }
  | { tool: 'switchApp'; bundleId: string; because: string }
  | { tool: 'menus'; query?: string }
  | { tool: 'chooseMenu'; menu: string; name: string; because: string }
  | { tool: 'key'; key: 'down' | 'pageDown'; times?: number }
  | { tool: 'note'; text: string }
  | { tool: 'done'; found: boolean; because: string; stay?: boolean }

function harness(
  script: Move[],
  options: { ended?: AgentRunResult['ended']; listed?: UiTarget[]; autoRun?: boolean } = {}
) {
  const sidecar = new FakeSidecar({
    accessibility: true,
    targets: options.listed ?? targets('Search', 'Anil Turaga'),
    app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 900 },
    context: ['Anil: the redlines are with legal', 'Anil: should land Thursday']
  })

  const answers: AnswerRequest[] = []
  const engine = {
    name: 'test',
    model: null,
    ready: async () => ({ kind: 'ready' as const }),
    classify: async () => ({ kind: 'dictate' as const }),
    transform: async () => ({ text: '' }),
    compose: async () => ({ text: '' }),
    navigate: async () => ({ verb: 'done' as const, because: 'not this test' }),
    answer: async (request: AnswerRequest, onPartial?: (text: string) => void) => {
      answers.push(request)
      onPartial?.('The redlines')
      return { text: 'The redlines are with legal; Anil expects them Thursday.' }
    }
  } satisfies Engine

  const cards: PlanCard[] = []
  const rows: JournalDraft[] = []
  const notices: string[] = []
  const lastActions: Array<HudLastAction | undefined> = []
  const journal = {
    append: (draft: JournalDraft) => {
      const entry = { ...draft, id: draft.id ?? `row-${rows.length}`, at: 0 }
      rows.push(entry)
      return entry as unknown as JournalEntry
    },
    amend: () => {}
  }

  const chosen: string[] = []
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

  /** Every move the fake loop actually got to make. */
  const played: string[] = []

  const lane = new AgentLane({
    sidecar,
    engine,
    autoRun: () => options.autoRun === true,
    executor: new ActionExecutor({ sidecar, sleep: async () => {}, journal }),
    sleep: async () => {},
    journal: journal as unknown as JournalStore,
    captures: {
      save: (_id: string, context: ScreenContext | null | undefined) =>
        context ? ({ imageFile: 'x.jpg', chars: context.chars } as never) : null
    } as unknown as CaptureStore,
    hud: {
      openCard: (card: HudCard, onAction) => controller.openCard(card, onAction),
      updateCard: (card: HudCard) => controller.updateCard(card),
      closeCard: () => controller.closeCard(),
      announce: (_phase, notice, lastAction) => {
        notices.push(notice)
        lastActions.push(lastAction)
      }
    },
    apps: {
      list: async () => [
        { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', front: true },
        { bundleId: 'com.apple.iCal', name: 'Calendar', front: false }
      ]
    },
    menus: {
      list: async () => [
        { menu: 'File', name: 'New Event\u2026', enabled: true, submenu: false },
        { menu: 'Message', name: 'Send', enabled: true, submenu: false }
      ],
      choose: async (process: string, menu: string, name: string) => {
        chosen.push(`${process}: ${menu} \u25b8 ${name}`)
      }
    },
    // The loop, faked: it plays the script, asking the stop before each move
    // exactly where `canUseTool` would.
    run: async (request) => {
      for (const move of script) {
        if (request.stopped()) break
        played.push(move.tool)
        if (move.tool === 'look') await request.handlers.look({ want: move.want })
        else if (move.tool === 'find') await request.handlers.find({ query: move.query })
        else if (move.tool === 'press')
          await request.handlers.press({ index: move.index, expectTitle: move.title })
        else if (move.tool === 'setText')
          await request.handlers.setText({
            index: move.index,
            expectTitle: move.title,
            text: move.text
          })
        else if (move.tool === 'apps') await request.handlers.apps({})
        else if (move.tool === 'menus')
          await request.handlers.menus(move.query === undefined ? {} : { query: move.query })
        else if (move.tool === 'chooseMenu')
          await request.handlers.chooseMenu({
            menu: move.menu,
            name: move.name,
            because: move.because
          })
        else if (move.tool === 'switchApp')
          await request.handlers.switchApp({ bundleId: move.bundleId, because: move.because })
        else if (move.tool === 'key')
          await request.handlers.key({ key: move.key, ...(move.times ? { times: move.times } : {}) })
        else if (move.tool === 'note') await request.handlers.note({ text: move.text })
        else
          await request.handlers.done({
            found: move.found,
            because: move.because,
            ...(move.stay === undefined ? {} : { stay: move.stay })
          })
      }
      return { ended: options.ended ?? 'done', turns: played.length, costUsd: 0.01 }
    }
  })

  return {
    lane,
    sidecar,
    chosen,
    cards,
    rows,
    notices,
    lastActions,
    played,
    answers,
    shortcuts,
    fire: (accelerator: string) => handlers.get(accelerator)?.(),
    run: () => controller.act('apply'),
    cancel: () => controller.act('cancel'),
    runRow: () =>
      rows.find((row) => row.intent.kind === 'command' && row.intent.verb === 'agent.run'),
    stepRows: () =>
      rows.filter((row) => row.intent.kind === 'command' && row.intent.verb.startsWith('nav.')),
    last: () => cards[cards.length - 1] as PlanCard
  }
}

const request = {
  goal: 'what did Anil say about the terms doc',
  transcript: 'what did Anil say about the terms doc',
  app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' }
}

describe('propose', () => {
  it('puts up a card and touches nothing', async () => {
    const h = harness([{ tool: 'look', want: 'both' }])
    await h.lane.propose(request)

    expect(h.last().goal).toBe(request.goal)
    expect(h.last().running).toBeFalsy()
    expect(h.played).toEqual([])
    expect(h.sidecar.targetActions).toEqual([])
  })

  // Without this the card closes on the press and the run is invisible.
  it('says the card starts something, so it survives Run', async () => {
    const h = harness([{ tool: 'done', found: false, because: 'nothing to do' }])
    await h.lane.propose(request)
    expect(h.last().startsRun).toBe(true)
  })
})

describe('Run', () => {
  it('shows each act as it happens, then the answer, then puts the window back', async () => {
    const h = harness([
      { tool: 'find', query: 'Anil' },
      { tool: 'press', index: 1, title: 'Anil Turaga' },
      { tool: 'look', want: 'text' },
      { tool: 'done', found: true, because: 'the conversation is open' }
    ])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.played).toEqual(['find', 'press', 'look', 'done'])
    // Every act got a row on the card, in order, and none is left running.
    expect(h.last().steps.map((step) => step.verb)).toEqual(['find', 'press', 'look'])
    expect(h.last().steps.every((step) => step.state !== 'running')).toBe(true)
    expect(h.last().answer).toMatch(/redlines/)
    expect(h.sidecar.activated).toContain('com.tinyspeck.slackmacgap')
  })

  /**
   * The answer is its own turn, in its own voice. `done` carries no text, so a
   * run that arrives is followed by `engine.answer` reading what the last look
   * captured — not the window as it is now, which has been put back.
   */
  it('answers from what it read, not from where it ended up', async () => {
    const h = harness([
      { tool: 'look', want: 'text' },
      { tool: 'done', found: true, because: 'arrived' }
    ])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.answers).toHaveLength(1)
    expect(h.answers[0]?.goal).toBe(request.goal)
    expect(h.answers[0]?.context?.blocks.map((b) => b.text).join(' ')).toMatch(/redlines/)
  })

  it('does not ask for an answer when it never got there', async () => {
    const h = harness([
      { tool: 'look', want: 'both' },
      { tool: 'done', found: false, because: 'no Anil in this workspace' }
    ])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.answers).toEqual([])
    expect(h.last().note).toMatch(/no Anil/)
    expect(h.runRow()?.status).toBe('failed')
  })

  /**
   * Filling a form and stopping short of the button. The run that M-A could not
   * do at all, and the one the vocabulary was widened for.
   */
  it('fills in a field and says so on the card, without submitting anything', async () => {
    const h = harness(
      [
        { tool: 'look', want: 'targets' },
        { tool: 'setText', index: 1, title: 'Title', text: 'Q3 review' },
        { tool: 'done', found: false, because: 'filled in the title; the rest is yours to save' }
      ],
      { listed: [...targets('Save'), { ...targets('Title')[0]!, index: 1, kind: 'type' }] }
    )
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.sidecar.insertions).toEqual(['Q3 review'])
    // The text on the card, not just the field name: a write is the one act
    // where what went in matters more than where it went.
    const typed = h.last().steps.find((step) => step.verb === 'type')
    expect(typed?.object).toContain('Q3 review')
    expect(typed?.state).toBe('done')
    expect(h.sidecar.chords).toEqual([])
  })

  it('still puts the window back when the loop throws', async () => {
    const h = harness([{ tool: 'look', want: 'both' }])
    ;(h.lane as unknown as { deps: { run: () => Promise<never> } }).deps.run = async () => {
      throw new Error('the subprocess died')
    }
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.sidecar.activated).toContain('com.tinyspeck.slackmacgap')
    expect(h.runRow()).toBeTruthy()
    expect(h.last().note).toMatch(/the subprocess died/)
  })
})

/**
 * `settings.autoRun` — the press the card asks for, spent in advance.
 *
 * What is being checked here is that it is the *same* start: one walker, the
 * same card, the same journal row, and esc still meaning stop rather than
 * decline. The only thing that moved is who began it.
 */
describe('auto-run', () => {
  it('goes without a press, and says on the card that nobody pressed anything', async () => {
    const h = harness(
      [
        { tool: 'find', query: 'Anil' },
        { tool: 'press', index: 1, title: 'Anil Turaga' },
        { tool: 'look', want: 'text' },
        { tool: 'done', found: true, because: 'the conversation is open' }
      ],
      { autoRun: true }
    )
    await h.lane.propose(request)
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.played).toEqual(['find', 'press', 'look', 'done'])
    expect(h.last().auto).toBe(true)
    expect(h.runRow()?.status).toBe('applied')
  })

  it('starts exactly one walk, however many applies arrive after it', async () => {
    const h = harness([{ tool: 'look', want: 'both' }, { tool: 'done', found: true, because: 'read it' }], {
      autoRun: true
    })
    await h.lane.propose(request)
    h.run()
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.played).toEqual(['look', 'done'])
  })

  it('esc is a stop rather than a decline, because the run already began', async () => {
    const h = harness([{ tool: 'look', want: 'both' }, { tool: 'done', found: true, because: 'read it' }], {
      autoRun: true
    })
    await h.lane.propose(request)
    h.cancel()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.rows.some((row) => row.summary.startsWith('Declined ·'))).toBe(false)
  })

  /**
   * The doubt outranks the switch. `unsure` is set when whisper's mean token
   * probability came in under `LOW_CONFIDENCE`, and the HUD has just told the
   * user to check before running — which is not a thing they can do if it has
   * already gone.
   */
  it('still waits for Run when whisper was not sure what it heard', async () => {
    const h = harness([{ tool: 'press', index: 1, title: 'Anil Turaga' }, { tool: 'done', found: true, because: 'open' }], {
      autoRun: true
    })
    await h.lane.propose({ ...request, unsure: true })

    expect(h.played).toEqual([])
    expect(h.last().auto).toBe(false)

    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))
    expect(h.played).toEqual(['press', 'done'])
  })

  it('leaves the card waiting when the switch is off', async () => {
    const h = harness([{ tool: 'look', want: 'both' }])
    await h.lane.propose(request)

    expect(h.played).toEqual([])
    expect(h.last().auto).toBe(false)
  })
})

describe('Escape', () => {
  it('declines before Run, and never starts', async () => {
    const h = harness([{ tool: 'press', index: 1, title: 'Anil Turaga' }])
    await h.lane.propose(request)
    h.cancel()

    expect(h.played).toEqual([])
    expect(h.rows.some((row) => row.summary.startsWith('Declined ·'))).toBe(true)
  })

  /**
   * The guarantee, at the lane's own layer: once the flag is set, the loop's
   * next move does not happen. The card stays up so the stop is readable, and
   * the window still goes back.
   */
  it('stops a run that has started, and nothing more happens', async () => {
    const h = harness([
      { tool: 'look', want: 'both' },
      { tool: 'press', index: 1, title: 'Anil Turaga' },
      { tool: 'done', found: true, because: 'arrived' }
    ])
    await h.lane.propose(request)
    expect(h.shortcuts).toEqual(new Set(['Return', 'Escape']))
    h.sidecar.onTargetAction = () => h.fire('Escape')
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    // The press it was already making landed; the `done` after it did not.
    expect(h.played).toEqual(['look', 'press'])
    expect(h.sidecar.activated).toContain('com.tinyspeck.slackmacgap')
  })

  it('files a stop as the run’s own row, never as a decline', async () => {
    const h = harness(
      [
        { tool: 'look', want: 'both' },
        { tool: 'press', index: 1, title: 'Anil Turaga' },
        { tool: 'done', found: true, because: 'arrived' }
      ],
      { ended: 'stopped' }
    )
    await h.lane.propose(request)
    h.sidecar.onTargetAction = () => h.fire('Escape')
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.rows.some((row) => row.summary.startsWith('Declined ·'))).toBe(false)
    expect(h.runRow()?.status).toBe('cancelled')
    expect(h.last().note).toMatch(/stays pressed/)
    expect(h.notices.join(' ')).not.toMatch(/nothing was pressed/)
  })
})

describe('the journal', () => {
  it('ties every act to the run that took it', async () => {
    const h = harness([
      { tool: 'look', want: 'targets' },
      { tool: 'press', index: 1, title: 'Anil Turaga' },
      { tool: 'look', want: 'text' },
      { tool: 'done', found: true, because: 'arrived' }
    ])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    const run = h.runRow()
    expect(run?.groupId).toBe(run?.id)
    expect(h.stepRows().map((row) => row.groupId)).toEqual([run?.id])
  })

  /**
   * A loop is the first thing in Mull whose cost is not a fixed number of
   * turns. "It got expensive" is only visible if somebody wrote it down.
   */
  it('records what the run cost and how many turns it took', async () => {
    const h = harness([{ tool: 'done', found: false, because: 'nothing here' }])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.runRow()?.detail).toMatchObject({ costUsd: 0.01 })
  })

  it('leaves behind the answer, not the question', async () => {
    const h = harness([
      { tool: 'look', want: 'text' },
      { tool: 'done', found: true, because: 'arrived' }
    ])
    await h.lane.propose(request)
    h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.lastActions.at(-1)?.result).toMatch(/redlines/)
    expect(h.lastActions.at(-1)?.undoable).toBe(false)
  })
})

describe('endingNote', () => {
  const ran = (ended: AgentRunResult['ended'], detail?: string): AgentRunResult => ({
    ended,
    turns: 3,
    costUsd: 0,
    ...(detail ? { detail } : {})
  })

  it('prefers the model’s own words when it has any', () => {
    expect(endingNote(ran('done'), { found: true, because: 'found the thread' }, 3)).toBe(
      'found the thread'
    )
  })

  // "Ran out of turns" and "ran out of money" want different responses from
  // whoever is reading, so the note says which.
  it('says which budget stopped it', () => {
    expect(endingNote(ran('budget'), null, 3)).toMatch(/expensive/)
    expect(endingNote(ran('turns'), null, 3)).toMatch(/ran out of steps/)
    expect(endingNote(ran('deadline'), null, 3)).toMatch(/gave up waiting/)
  })

  it('never lets a stop read as “nothing happened”', () => {
    expect(endingNote(ran('stopped'), null, 0)).toMatch(/before anything was pressed/)
    expect(endingNote(ran('stopped'), null, 4)).toMatch(/stays pressed/)
  })
})

describe('going to another application', () => {
  /**
   * The claim this whole milestone rests on, asserted rather than asserted-in-a
   * -comment.
   *
   * `AGENT-V2.md` §11 says the screen moving under somebody is the thing most
   * likely to make a working feature feel like a malfunction, and the mitigation
   * is that the card says where it is going and *why* before it goes. That is
   * only true because `act` draws the row and then awaits the handler — so this
   * checks the card as it stood at the moment the switch was still in flight,
   * not the one left behind afterwards.
   */
  it('puts the reason on the card before the screen moves', async () => {
    const h = harness([
      { tool: 'apps' },
      { tool: 'switchApp', bundleId: 'com.apple.iCal', because: 'to check Thursday' },
      { tool: 'done', found: true, because: 'Thursday is free' }
    ])
    /**
     * Read at the instant the screen actually moves, not afterwards.
     *
     * The lane copies the step *array* into each card but not the steps
     * themselves, so a snapshot taken earlier is retroactively mutated when a
     * row resolves — which makes "what did the card say before" unanswerable
     * from the list of cards. It is answerable here, because `activateApp` is
     * the call that moves the screen, and whatever the card says at that moment
     * is what a user looking up would have read.
     *
     * (Harmless in the running app, where every draw re-renders from the live
     * objects. It only bites a test that tries to look backwards.)
     */
    let asTheScreenMoved: { verb: string; object: string; state: string } | null = null
    const realActivate = h.sidecar.activateApp.bind(h.sidecar)
    h.sidecar.activateApp = async (params) => {
      const row = h.last().steps.find((step) => step.verb === 'go to')
      if (row && !asTheScreenMoved) {
        asTheScreenMoved = { verb: row.verb, object: row.object, state: row.state }
      }
      return realActivate(params)
    }

    await h.lane.propose({ goal: 'is Thursday free', transcript: 'is Thursday free', app: null })
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(asTheScreenMoved).toEqual({
      verb: 'go to',
      object: 'to check Thursday',
      state: 'running'
    })
    // And it is still the reason once the run has settled — a destination would
    // have overwritten it.
    expect(h.last().steps.find((step) => step.verb === 'go to')?.object).toBe('to check Thursday')
  })

  /**
   * The window the user was in comes back however the run ended — and after a
   * cross-app run that is no longer a formality, because the app in front at
   * the end is genuinely somewhere else.
   */
  it('comes back to where the user was', async () => {
    const h = harness([
      { tool: 'apps' },
      { tool: 'switchApp', bundleId: 'com.apple.iCal', because: 'to check Thursday' },
      { tool: 'look', want: 'text' },
      { tool: 'done', found: true, because: 'Thursday is free' }
    ])
    await h.lane.propose({ goal: 'is Thursday free', transcript: 'is Thursday free', app: null })
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    // Calendar on the way out, Slack on the way back, in that order.
    expect(h.sidecar.activated).toEqual(['com.apple.iCal', 'com.tinyspeck.slackmacgap'])
  })

  /**
   * A press that happened in Calendar must not be written down as a press in
   * Slack. The journal is the record of what Mull did on somebody's machine, and
   * a row naming the wrong application is worse than no row at all.
   */
  it('files each step against the application it actually happened in', async () => {
    const h = harness([
      { tool: 'look', want: 'targets' },
      { tool: 'press', index: 1, title: 'Anil Turaga' },
      { tool: 'apps' },
      { tool: 'switchApp', bundleId: 'com.apple.iCal', because: 'to check Thursday' },
      { tool: 'look', want: 'targets' },
      { tool: 'press', index: 1, title: 'Anil Turaga' },
      { tool: 'done', found: true, because: 'Thursday is free' }
    ])
    await h.lane.propose({ goal: 'is Thursday free', transcript: 'is Thursday free', app: null })
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    const apps = h.stepRows().map((row) => row.app?.name)
    expect(apps).toEqual(['Slack', 'Calendar'])
  })

  /**
   * Escape has to work in the middle of a cross-app run, which is the moment it
   * matters most: the user is looking at an application they did not open.
   */
  it('stops mid-errand and still puts the window back', async () => {
    const h = harness(
      [
        { tool: 'apps' },
        { tool: 'switchApp', bundleId: 'com.apple.iCal', because: 'to check Thursday' },
        { tool: 'press', index: 1, title: 'Anil Turaga' },
        { tool: 'done', found: true, because: 'never reached' }
      ],
      { ended: 'stopped' }
    )
    await h.lane.propose({ goal: 'is Thursday free', transcript: 'is Thursday free', app: null })
    await h.run()
    h.cancel()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.played).not.toContain('done')
    expect(h.sidecar.activated).toContain('com.tinyspeck.slackmacgap')
    expect(h.runRow()?.status).toBe('cancelled')
  })
})

describe('where the user is left', () => {
  /**
   * The bug this fixes, stated as a test.
   *
   * "Open Slack" opened Slack and then put Zed back, which is the only thing the
   * user asked for, undone, while the screen flickered twice. `restore` being
   * unconditional was right for as long as every run was an errand; `switchApp`
   * ended that.
   */
  it('stays where it went when being there was the point', async () => {
    const h = harness([
      { tool: 'apps' },
      { tool: 'switchApp', bundleId: 'com.apple.iCal', because: 'the user asked for it' },
      { tool: 'done', found: true, because: 'Calendar is in front', stay: true }
    ])
    await h.lane.propose({ goal: 'open my calendar', transcript: 'open my calendar', app: null })
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    // Went there, and stayed. No second activation putting Slack back.
    expect(h.sidecar.activated).toEqual(['com.apple.iCal'])
    expect(h.last().note).toContain('left in Calendar')
  })

  /** An errand is still an errand: the answer goes to the user where the user was. */
  it('comes back when it went to fetch something', async () => {
    const h = harness([
      { tool: 'apps' },
      { tool: 'switchApp', bundleId: 'com.apple.iCal', because: 'to check Thursday' },
      { tool: 'look', want: 'text' },
      { tool: 'done', found: true, because: 'Thursday is free' }
    ])
    await h.lane.propose({ goal: 'is Thursday free', transcript: 'is Thursday free', app: null })
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.sidecar.activated).toEqual(['com.apple.iCal', 'com.tinyspeck.slackmacgap'])
  })

  /**
   * The guess, for when the model does not say. A run that moved and has
   * nothing to tell you was a destination; one with an answer was a question.
   */
  it('guesses from what happened when the model did not say', async () => {
    const h = harness([
      { tool: 'apps' },
      { tool: 'switchApp', bundleId: 'com.apple.iCal', because: 'the user asked for it' },
      { tool: 'done', found: true, because: 'Calendar is in front' }
    ])
    await h.lane.propose({ goal: 'open my calendar', transcript: 'open my calendar', app: null })
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.sidecar.activated).toEqual(['com.apple.iCal'])
  })

  /**
   * Rule one, and it outranks the model. A run the user stopped did not get
   * them what they asked for, so leaving them somewhere they did not choose
   * adds insult — and a half-finished run has no standing to say where anybody
   * should be.
   */
  it('puts the window back when the run did not finish, whatever it asked for', async () => {
    const h = harness(
      [
        { tool: 'apps' },
        { tool: 'switchApp', bundleId: 'com.apple.iCal', because: 'the user asked for it' },
        { tool: 'press', index: 1, title: 'Anil Turaga' },
        { tool: 'done', found: true, because: 'never reached', stay: true }
      ],
      { ended: 'stopped' }
    )
    await h.lane.propose({ goal: 'open my calendar', transcript: 'open my calendar', app: null })
    await h.run()
    h.cancel()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.sidecar.activated).toContain('com.tinyspeck.slackmacgap')
  })

  /**
   * The second bug `switchApp` exposed: `arrived` required prose, so a run that
   * opened Slack, said so, and had no question to answer was filed as **failed**
   * and announced as an **error**. An errand arrives by having something to say;
   * a destination arrives by being there.
   */
  it('counts a destination as done even though it has nothing to say', async () => {
    const h = harness([
      { tool: 'apps' },
      { tool: 'switchApp', bundleId: 'com.apple.iCal', because: 'the user asked for it' },
      { tool: 'done', found: true, because: 'Calendar is in front', stay: true }
    ])
    await h.lane.propose({ goal: 'open my calendar', transcript: 'open my calendar', app: null })
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.runRow()?.status).toBe('applied')
    expect(h.runRow()?.summary).toContain('Opened')
    // And the user is not told their own request went wrong.
    expect(h.lastActions[h.lastActions.length - 1]?.summary).toContain('Opened')
  })

  /**
   * A run that never left the window restores as it always did — `restore` also
   * puts the *conversation* back, not only the application, and that is worth
   * nothing changing for the many runs that only ever pressed things.
   */
  it('leaves single-window runs exactly as they were', async () => {
    const h = harness([
      { tool: 'look', want: 'both' },
      { tool: 'press', index: 1, title: 'Anil Turaga' },
      { tool: 'done', found: true, because: 'found it' }
    ])
    await h.lane.propose({ goal: 'what did Anil say', transcript: 'what did Anil say', app: null })
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.sidecar.activated).toEqual(['com.tinyspeck.slackmacgap'])
  })
})

describe('using the menus', () => {
  /**
   * The same argument `switchApp` makes one block above, for a wider act — but
   * with one deliberate difference, and it is the reason this test exists.
   *
   * A switch shows its own result: the user can see which application came
   * forward, so the row spends its whole width on *why*. A menu command shows
   * nothing — it is a flicker, and then a window that may or may not have
   * changed. So the row carries the command's own path as well as the reason,
   * because this row is the only record of what was chosen that appears anywhere
   * the user is looking.
   */
  it('puts the command and the reason on the card', async () => {
    const h = harness([
      { tool: 'menus' },
      { tool: 'chooseMenu', menu: 'File', name: 'New Event…', because: 'to add Thursday' },
      { tool: 'done', found: true, because: 'the form is open', stay: true }
    ])

    await h.lane.propose({ goal: 'add an event', transcript: 'add an event', app: null })
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    const row = h.last().steps.find((step) => step.verb === 'menu')
    expect(row?.object).toContain('New Event…')
    expect(row?.object).toContain('to add Thursday')
    expect(h.chosen).toEqual(['Slack: File ▸ New Event…'])
  })

  /**
   * The invariant, asserted at the lane rather than only at the schema.
   *
   * `checkMenuCommand` is unit-tested in `@shared/agent`, and a guard that is
   * only tested where it is defined is a guard nobody has checked is *wired in*.
   * This drives the real handler through the real lane and asserts that nothing
   * reached the bridge.
   */
  it('will not send, and the run carries on without it', async () => {
    const h = harness([
      { tool: 'menus' },
      { tool: 'chooseMenu', menu: 'Message', name: 'Send', because: 'to send it' },
      { tool: 'done', found: false, because: 'Mull does not send' }
    ])

    await h.lane.propose({ goal: 'send it', transcript: 'send it', app: null })
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.chosen).toEqual([])
    const row = h.last().steps.find((step) => step.verb === 'menu')
    expect(row?.state).toBe('failed')
  })

  /** A read is not an act, so its row says what was asked rather than why. */
  it('shows what the menus were asked for', async () => {
    const h = harness([
      { tool: 'menus', query: 'event' },
      { tool: 'done', found: true, because: 'found it' }
    ])

    await h.lane.propose({ goal: 'what can it do', transcript: 'what can it do', app: null })
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    const row = h.last().steps.find((step) => step.verb === 'menus')
    expect(row?.object).toContain('event')
    expect(row?.state).toBe('done')
  })
})
