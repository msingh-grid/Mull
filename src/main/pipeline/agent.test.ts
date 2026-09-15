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
  | { tool: 'note'; text: string }
  | { tool: 'done'; found: boolean; because: string }

function harness(
  script: Move[],
  options: { ended?: AgentRunResult['ended']; listed?: UiTarget[] } = {}
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
        else if (move.tool === 'note') await request.handlers.note({ text: move.text })
        else await request.handlers.done({ found: move.found, because: move.because })
      }
      return { ended: options.ended ?? 'done', turns: played.length, costUsd: 0.01 }
    }
  })

  return {
    lane,
    sidecar,
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
