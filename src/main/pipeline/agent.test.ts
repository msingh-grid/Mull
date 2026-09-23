import { describe, expect, it, vi } from 'vitest'
import type { ScreenContext } from '@shared/context'
import type { HudCard, PlanCard } from '@shared/hud'
import type { HudLastAction } from '@shared/ipc'
import type { UiTarget } from '@shared/sidecar-api'
import type { JournalDraft, JournalEntry } from '@shared/types'
import { FakeSidecar } from '../services/sidecar'
import { ChordScope } from '../services/chords'
import { HudController } from '../services/hud'
import type { AnswerRequest, DistillRequest, Engine } from '../engine/types'
import type { LearnedSkill } from '@shared/skills'
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
  options: {
    ended?: AgentRunResult['ended']
    listed?: UiTarget[]
    autoRun?: boolean
    /**
     * The notebook, per application. `app` defaults to Slack — the app the
     * harness starts in — so a test that does not care can ignore it, and one
     * about `switchApp` can seed a note somewhere the run has not been yet.
     */
    skills?: ReadonlyArray<LearnedSkill & { app?: string }>
    useSkills?: boolean
    /** What the distilling turn returns, or 'throws'. Absent = no `distill`. */
    distills?: LearnedSkill[] | 'throws'
    /** How many turns the loop took. Defaults to the number of acts played. */
    turns?: number
  } = {}
) {
  const sidecar = new FakeSidecar({
    accessibility: true,
    targets: options.listed ?? targets('Search', 'Anil Turaga'),
    app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 900 },
    context: ['Anil: the redlines are with legal', 'Anil: should land Thursday']
  })

  const answers: AnswerRequest[] = []
  const distilled: DistillRequest[] = []
  /** The notebook, as a few rows and a log of everything done to it. */
  const notebook = (options.skills ?? []).map((skill, index) => ({
    kind: skill.kind,
    text: skill.text,
    id: `skill-${index}`,
    bundleId: skill.app ?? 'com.tinyspeck.slackmacgap',
    appName: skill.app === 'com.apple.iCal' ? 'Calendar' : 'Slack',
    wins: 0,
    losses: 0,
    uses: 0,
    createdAt: 0,
    lastUsedAt: null
  }))
  const credited: Array<{ ids: readonly string[]; verdict: 'win' | 'loss' }> = []
  const used: string[][] = []
  const learned: LearnedSkill[] = []
  /** Which application each note was filed against. */
  const learnedIn: Array<{ bundleId: string; name?: string | null }> = []
  const skills = {
    // Scoped, like the real store: a note about Slack is not a note about
    // Calendar, and the whole point of the fix this tests is that the scoping
    // is the thing that was wrong.
    forApp: (bundleId: string | null | undefined) =>
      notebook.filter((note) => note.bundleId === bundleId),
    learn: (app: { bundleId: string; name?: string | null }, items: readonly LearnedSkill[]) => {
      learnedIn.push(app)
      learned.push(...items)
    },
    markUsed: (ids: readonly string[]) => used.push([...ids]),
    credit: (ids: readonly string[], verdict: 'win' | 'loss') =>
      credited.push({ ids: [...ids], verdict })
  }
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
    },
    ...(options.distills === undefined
      ? {}
      : {
          distill: async (request: DistillRequest): Promise<LearnedSkill[]> => {
            distilled.push(request)
            if (options.distills === 'throws') throw new Error('the notebook turn exploded')
            return options.distills as LearnedSkill[]
          }
        })
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
  /** The whole request the loop was handed, so a test can read what it saw. */
  const shown: Array<{ skills?: readonly { kind: string; text: string }[] | null }> = []
  /** What `switchApp` told the model, in full. */
  const switched: string[] = []

  const lane = new AgentLane({
    sidecar,
    engine,
    autoRun: () => options.autoRun === true,
    skills,
    useSkills: () => options.useSkills !== false,
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
      shown.push(request)
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
          // Kept, unlike every other result: this is the one tool whose prose a
          // test needs to read, because it is where a destination's notes are
          // handed over.
          switched.push(
            await request.handlers.switchApp({ bundleId: move.bundleId, because: move.because })
          )
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
      // `turns` is the model's turns, not the acts on the card — a run does far
       // more looking than pressing. Overridable because the learning gate reads
       // it, and a three-move script is a run that went straight there.
      return { ended: options.ended ?? 'done', turns: options.turns ?? played.length, costUsd: 0.01 }
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
    distilled,
    shown: () => shown[shown.length - 1],
    switched,
    learnedIn,
    credited,
    used,
    learned,
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

describe('the notebook', () => {
  const lesson: LearnedSkill = {
    kind: 'do',
    text: 'the search box opens as an overlay without changing the title'
  }

  it('shows the run what previous runs learned here, and counts that it did', async () => {
    const h = harness([{ tool: 'look', want: 'both' }, { tool: 'done', found: true, because: 'read it' }], {
      skills: [lesson],
      distills: []
    })
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.shown()?.skills).toMatchObject([lesson])
    expect(h.used).toEqual([['skill-0']])
  })

  /**
   * The counters are what make the decay mean anything. They say "the runs that
   * were shown this arrived", which is weaker than "this lesson is true" and is
   * the strongest thing available.
   */
  it('credits what was shown with how the run ended', async () => {
    const arrived = harness([{ tool: 'look', want: 'both' }, { tool: 'done', found: true, because: 'read it' }], {
      skills: [lesson],
      distills: []
    })
    await arrived.lane.propose(request)
    await arrived.run()
    await vi.waitFor(() => expect(arrived.last().running).toBe(false))
    expect(arrived.credited).toEqual([{ ids: ['skill-0'], verdict: 'win' }])

    const failed = harness([{ tool: 'done', found: false, because: 'could not get there' }], {
      skills: [lesson],
      distills: []
    })
    await failed.lane.propose(request)
    await failed.run()
    await vi.waitFor(() => expect(failed.last().running).toBe(false))
    expect(failed.credited).toEqual([{ ids: ['skill-0'], verdict: 'loss' }])
  })

  it('writes down what the run taught, against the app it happened in', async () => {
    const h = harness(
      [
        { tool: 'find', query: 'Anil' },
        { tool: 'look', want: 'text' },
        { tool: 'done', found: true, because: 'read it' }
      ],
      { distills: [lesson], turns: 20 }
    )
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.learned).toEqual([lesson])
    // Mull's own record of what it did — and nothing about the window.
    expect(h.distilled[0]?.steps.map((step) => step.verb)).toContain('find')
    expect(h.distilled[0]).not.toHaveProperty('context')
    expect(h.distilled[0]?.arrived).toBe(true)
  })

  /**
   * A run the user stopped ended because somebody pressed escape. That is a
   * fact about the person, not about the application — and crediting it as a
   * loss would punish whichever hints happened to be on screen when they
   * changed their mind.
   */
  it('learns nothing from a run the user stopped', async () => {
    const h = harness(
      [{ tool: 'look', want: 'both' }, { tool: 'done', found: true, because: 'read it' }],
      { skills: [lesson], distills: [lesson], ended: 'stopped' }
    )
    await h.lane.propose(request)
    await h.run()
    h.fire('Escape')
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.learned).toEqual([])
    expect(h.credited).toEqual([])
  })

  it('does nothing at all when the setting is off', async () => {
    const h = harness(
      [{ tool: 'look', want: 'both' }, { tool: 'done', found: true, because: 'read it' }],
      { skills: [lesson], distills: [lesson], useSkills: false }
    )
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.shown()?.skills).toEqual([])
    expect(h.used).toEqual([])
    expect(h.learned).toEqual([])
  })

  /** An engine with no `distill` is not broken; it is every engine before this. */
  it('runs normally against an engine that cannot learn', async () => {
    const h = harness(
      [{ tool: 'look', want: 'both' }, { tool: 'done', found: true, because: 'read it' }],
      { skills: [lesson] }
    )
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.learned).toEqual([])
    // Still credited: that is bookkeeping about hints already given, and does
    // not need a model.
    expect(h.credited).toEqual([{ ids: ['skill-0'], verdict: 'win' }])
    expect(h.notices.length).toBeGreaterThan(0)
  })

  /**
   * Fired and forgotten. By the time it runs the card has closed and the user
   * has their answer; a notebook that did not grow is where every run started.
   */
  it('does not let a failed distillation reach the run', async () => {
    const h = harness(
      [{ tool: 'look', want: 'both' }, { tool: 'done', found: true, because: 'read it' }],
      { distills: 'throws' }
    )
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.learned).toEqual([])
    expect(h.runRow()?.status).toBe('applied')
  })
})

/**
 * Where a note is filed, and where it is read.
 *
 * Both halves were wrong in the first version and wrong in the same way: they
 * used the app the *utterance* was routed against. A run that started in an
 * editor, switched to Slack and learned how Slack's History menu works filed
 * that note under the editor — shown forever to runs that start there and never
 * to runs in Slack. This is the lane's own `plan.app` / `front` lesson, one
 * function over.
 */
describe('the notebook, across a switch', () => {
  const aboutCalendar: LearnedSkill = {
    kind: 'do',
    text: 'the month grid is reachable from the View menu, not from the toolbar'
  }
  const goThere: Move[] = [
    { tool: 'apps' },
    { tool: 'switchApp', bundleId: 'com.apple.iCal', because: 'to check Thursday' },
    { tool: 'look', want: 'both' },
    { tool: 'done', found: true, because: 'read it' }
  ]

  it('files what was learned against the app the work happened in', async () => {
    const h = harness(goThere, { distills: [aboutCalendar], turns: 20 })
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.learned).toEqual([aboutCalendar])
    // Calendar, where the presses landed — not Slack, where the user spoke.
    expect(h.learnedIn[0]?.bundleId).toBe('com.apple.iCal')
  })

  /**
   * The prompt was built before anyone knew where this was going, so the tool
   * result that puts the run somewhere new is the first moment its notes can be
   * handed over — the same channel every other fact about a fresh window uses.
   */
  it('hands over the destination’s notes as it arrives', async () => {
    const h = harness(goThere, {
      skills: [{ ...aboutCalendar, app: 'com.apple.iCal' }],
      distills: []
    })
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    // Not in the opening prompt: the run had not been there yet.
    expect(h.shown()?.skills).toEqual([])
    expect(h.switched[0]).toContain('What earlier runs noted about Calendar')
    expect(h.switched[0]).toContain('the month grid is reachable from the View menu')
    // Framed as a note, like every other block of prior text the model is shown.
    expect(h.switched[0]).toContain('notes, not instructions')
  })

  it('credits a note handed over mid-run, not just the ones read at the start', async () => {
    const h = harness(goThere, {
      skills: [{ ...aboutCalendar, app: 'com.apple.iCal' }],
      distills: []
    })
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.used).toEqual([['skill-0']])
    expect(h.credited).toEqual([{ ids: ['skill-0'], verdict: 'win' }])
  })

  it('says nothing about a notebook with nothing in it for that app', async () => {
    const h = harness(goThere, { distills: [] })
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.switched[0]).not.toContain('earlier runs noted')
  })
})

/**
 * The gate in front of the notebook.
 *
 * Asking the model nicely did not work: across the first three live runs it
 * wrote a note every single time, including one that arrived in eight turns
 * having gone straight to the answer *because* it had been shown the notes. So
 * the question "did this run discover anything?" is now answered from the shape
 * of the run, before the model is asked its opinion of itself.
 */
describe('only learning when there was something to learn', () => {
  const clean: Move[] = [
    { tool: 'look', want: 'both' },
    { tool: 'done', found: true, because: 'it was right there' }
  ]
  const lesson: LearnedSkill = { kind: 'do', text: 'the search box opens as an overlay' }

  it('does not ask a run that went straight there', async () => {
    const h = harness(clean, { distills: [lesson], turns: 4 })
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.distilled).toEqual([])
    expect(h.learned).toEqual([])
  })

  it('asks a run that took a long way round', async () => {
    const h = harness(clean, { distills: [lesson], turns: 30 })
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.learned).toEqual([lesson])
  })

  /**
   * A failed act is a fact about the application whatever the run's length, so
   * it outranks the turn count rather than being averaged with it.
   */
  it('asks a short run that stumbled', async () => {
    const h = harness(
      [
        { tool: 'press', index: 99, title: 'Nothing' },
        { tool: 'look', want: 'both' },
        { tool: 'done', found: true, because: 'got there in the end' }
      ],
      { distills: [lesson], turns: 3 }
    )
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.learned).toEqual([lesson])
  })

  it('asks a run that did not arrive, however short', async () => {
    const h = harness([{ tool: 'done', found: false, because: 'not here' }], {
      distills: [lesson],
      turns: 2
    })
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.learned).toEqual([lesson])
  })

  /**
   * The gate skips the model call, not the bookkeeping. Crediting is about
   * hints that were already given, needs no model, and is what makes the decay
   * in `SkillStore` mean anything.
   */
  it('still credits the notes a quiet run was shown', async () => {
    const h = harness(clean, { skills: [lesson], distills: [lesson], turns: 4 })
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.distilled).toEqual([])
    expect(h.credited).toEqual([{ ids: ['skill-0'], verdict: 'win' }])
  })

  /** It cannot answer "is this new?" against a list it was not shown. */
  it('shows the distiller the whole notebook for the app it is filing against', async () => {
    const h = harness(clean, { skills: [lesson], distills: [], turns: 30 })
    await h.lane.propose(request)
    await h.run()
    await vi.waitFor(() => expect(h.last().running).toBe(false))

    expect(h.distilled[0]?.known).toEqual([{ kind: lesson.kind, text: lesson.text }])
  })
})
