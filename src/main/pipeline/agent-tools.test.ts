import { describe, expect, it } from 'vitest'
import type { UiTarget } from '@shared/sidecar-api'
import type { JournalDraft, JournalEntry } from '@shared/types'
import { FakeSidecar } from '../services/sidecar'
import { ActionExecutor } from './actions'
import {
  STOPPED_MESSAGE,
  find,
  findTargets,
  look,
  note,
  press,
  setText,
  type ToolContext
} from './agent-tools'

/**
 * The five things the agent can actually do, and the one thing it cannot do
 * once the user has said stop.
 */

const target = (index: number, title: string, kind: 'press' | 'type' = 'press'): UiTarget => ({
  index,
  role: kind === 'press' ? 'AXRow' : 'AXTextField',
  subrole: null,
  title,
  help: null,
  value: null,
  frame: null,
  actions: kind === 'press' ? ['AXPress'] : [],
  enabled: true,
  focused: false,
  kind
})

const sleep = async (): Promise<void> => {}

function harness(
  titles: string[] = ['Search', 'Anil Turaga', 'Priya Sharma'],
  options: { stopped?: boolean } = {}
): {
  context: ToolContext
  sidecar: FakeSidecar
  rows: JournalDraft[]
  amendments: Array<{ entryId: string; evidence: string }>
} {
  const sidecar = new FakeSidecar({
    accessibility: true,
    targets: titles.map((title, index) => target(index, title)),
    app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 900 },
    context: ['Anil: the redlines are with legal']
  })
  const rows: JournalDraft[] = []
  const amendments: Array<{ entryId: string; evidence: string }> = []
  const journal = {
    append: (draft: JournalDraft) => {
      rows.push(draft)
      return { ...draft, id: `row-${rows.length}`, at: 0 } as unknown as JournalEntry
    }
  }
  return {
    sidecar,
    rows,
    amendments,
    context: {
      sidecar,
      executor: new ActionExecutor({ sidecar, sleep: async () => {}, journal }),
      plan: {
        app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
        goal: 'what did Anil say',
        groupId: 'plan-1'
      },
      stopped: () => options.stopped === true,
      scan: null,
      pressed: null,
      read: null,
      steps: 0,
      amend: (entryId, evidence) => amendments.push({ entryId, evidence })
    }
  }
}

describe('look', () => {
  it('reads the window’s words, and remembers them for the answer', async () => {
    const h = harness()
    const out = await look(h.context, { want: 'text' }, sleep)

    expect(out.text).toContain('redlines')
    expect(h.context.read?.chars).toBeGreaterThan(0)
    // A text-only look does not scan: the numbers cost a walk of the tree.
    expect(h.context.scan).toBeNull()
  })

  it('numbers what can be pressed', async () => {
    const h = harness()
    const out = await look(h.context, { want: 'targets' }, sleep)

    expect(out.text).toContain('Anil Turaga')
    expect(h.context.scan?.targets).toHaveLength(3)
  })

  // The saving that made `both` worth having: the questionnaire paid two round
  // trips per step for exactly this.
  it('does both in one call', async () => {
    const h = harness()
    const out = await look(h.context, { want: 'both' }, sleep)

    expect(out.text).toContain('redlines')
    expect(out.text).toContain('Anil Turaga')
    expect(out.detail).toMatch(/3 targets/)
  })

  /**
   * An empty read must not overwrite a good one. The answer is written from
   * whatever `read` holds at the end, and a window Mull has already left saying
   * nothing is not a reason to forget what the right window said.
   */
  it('does not forget a good read because a later window was empty', async () => {
    const h = harness()
    await look(h.context, { want: 'text' }, sleep)
    const first = h.context.read

    // The window Mull walked on to says nothing. `FakeSidecar` reads its
    // blocks straight off the options it was built with, so emptying those is
    // the fake's way of moving to a blank window.
    ;(h.sidecar as unknown as { overrides: { context?: string[] } }).overrides.context = []
    await look(h.context, { want: 'text' }, sleep)
    expect(h.context.read).toBe(first)
  })
})

describe('find', () => {
  it('scans by itself rather than making the model call look first', async () => {
    const h = harness()
    const out = await find(h.context, { query: 'Anil' }, sleep)

    expect(out.text).toContain('Anil Turaga')
    expect(h.context.scan).not.toBeNull()
  })

  it('says so plainly when nothing matches, and how much it looked at', async () => {
    const h = harness()
    const out = await find(h.context, { query: 'Bartholomew' }, sleep)

    expect(out.text).toMatch(/nothing here matches/)
    expect(out.text).toMatch(/3 things/)
  })
})

describe('press', () => {
  it('refuses before anything has been looked at', async () => {
    const h = harness()
    const out = await press(h.context, { index: 1, expectTitle: 'Anil Turaga' })

    expect(out.ok).toBe(false)
    expect(out.text).toMatch(/look or find first/)
    expect(h.sidecar.targetActions).toEqual([])
  })

  it('presses, journals, and says what happened', async () => {
    const h = harness()
    await look(h.context, { want: 'targets' }, sleep)
    const out = await press(h.context, { index: 1, expectTitle: 'Anil Turaga' })

    expect(out.ok).toBe(true)
    expect(h.sidecar.targetActions).toEqual([{ verb: 'press', index: 1 }])
    expect(h.rows).toHaveLength(1)
    expect(out.entryId).toBeTruthy()
  })

  /**
   * The numbers die with the press. Pressing Slack's Search replaces the entire
   * list — measured at 138 entries before and 6 after — so an index decided
   * against the old window refers to nothing, and the model has to be told so
   * rather than left to find out by pressing the wrong thing.
   */
  it('throws the scan away afterwards, and says why', async () => {
    const h = harness()
    await look(h.context, { want: 'targets' }, sleep)
    const out = await press(h.context, { index: 1, expectTitle: 'Anil Turaga' })

    expect(h.context.scan).toBeNull()
    expect(out.text).toMatch(/no longer mean anything/)
  })

  /**
   * `AXPress` reports that an action was accepted, not that it did anything —
   * which is how the questionnaire got stuck pressing the same row twice. The
   * honest answer only exists on the next look, so the question has to survive
   * that far.
   */
  it('tells the next look whether the press moved the window', async () => {
    const h = harness()
    await look(h.context, { want: 'targets' }, sleep)
    h.sidecar.onTargetAction = () => h.sidecar.retarget(['Cancel', 'Clear'])
    const pressed = await press(h.context, { index: 1, expectTitle: 'Anil Turaga' })

    const after = await look(h.context, { want: 'targets' }, sleep)
    expect(after.text).toMatch(/the window changed/)
    // …and onto the row the press already wrote, because the evidence arrives
    // one turn after the row does.
    expect(h.amendments).toEqual([
      { entryId: pressed.entryId, evidence: expect.stringMatching(/the window changed/) }
    ])
  })

  it('says plainly when a press changed nothing, so it is not tried again', async () => {
    const h = harness()
    await look(h.context, { want: 'targets' }, sleep)
    await press(h.context, { index: 1, expectTitle: 'Anil Turaga' })

    const after = await look(h.context, { want: 'targets' }, sleep)
    expect(after.text).toMatch(/the window did not change/)
  })

  it('reports a refusal rather than pretending it worked', async () => {
    const h = harness()
    await look(h.context, { want: 'targets' }, sleep)
    const out = await press(h.context, { index: 9, expectTitle: 'nowhere' })

    expect(out.ok).toBe(false)
    expect(out.text).toMatch(/no target 9/)
  })
})

describe('setText', () => {
  const form = [
    target(0, 'Save'),
    target(1, 'Title', 'type'),
    target(2, 'Add guests', 'type')
  ]

  it('puts text in, and says what it replaced', async () => {
    const h = harness()
    ;(h.sidecar as unknown as { overrides: { targets?: UiTarget[] } }).overrides.targets = [
      ...form.slice(0, 1),
      { ...(form[1] as UiTarget), value: 'Untitled event' },
      ...form.slice(2)
    ]
    await look(h.context, { want: 'targets' }, sleep)
    const out = await setText(h.context, { index: 1, expectTitle: 'Title', text: 'Q3 review' })

    expect(out.ok).toBe(true)
    expect(h.sidecar.insertions).toEqual(['Q3 review'])
    expect(out.text).toContain('replacing “Untitled event”')
    // Said out loud, because a model that has filled a form will otherwise go
    // looking for a way to submit it — and there isn't one.
    expect(out.text).toMatch(/Nothing has been submitted/)
  })

  it('refuses before anything has been looked at', async () => {
    const h = harness()
    const out = await setText(h.context, { index: 1, expectTitle: 'Title', text: 'x' })
    expect(out.ok).toBe(false)
    expect(h.sidecar.insertions).toEqual([])
  })

  /**
   * A button is not a field, and saying which it is beats saying "no" — the
   * model's next move should be `press`, and it will only get there if told.
   */
  it('will not type into something that does not take text', async () => {
    const h = harness()
    ;(h.sidecar as unknown as { overrides: { targets?: UiTarget[] } }).overrides.targets = form
    await look(h.context, { want: 'targets' }, sleep)
    const out = await setText(h.context, { index: 0, expectTitle: 'Save', text: 'x' })

    expect(out.ok).toBe(false)
    expect(out.text).toMatch(/does not take text/)
    expect(out.text).toMatch(/Press it instead/)
    expect(h.sidecar.insertions).toEqual([])
  })

  /**
   * Unlike a press, which replaces the window. A run filling in four fields
   * should not have to re-read the list four times.
   */
  it('keeps the scan, so a form can be filled in without re-reading it', async () => {
    const h = harness()
    ;(h.sidecar as unknown as { overrides: { targets?: UiTarget[] } }).overrides.targets = form
    await look(h.context, { want: 'targets' }, sleep)
    await setText(h.context, { index: 1, expectTitle: 'Title', text: 'Q3 review' })
    expect(h.context.scan).not.toBeNull()

    const second = await setText(h.context, {
      index: 2,
      expectTitle: 'Add guests',
      text: 'priya@example.com'
    })
    expect(second.ok).toBe(true)
  })
})

/**
 * The stop, at the layer that can be tested without an SDK anywhere near it.
 *
 * `canUseTool` refuses first and its refusal is synchronous, so nothing should
 * ever reach these — but a handler that was already running when Escape landed
 * is about to take its second round trip, and this is what stops that one.
 */
describe('once the user has stopped it', () => {
  it('every tool refuses, and touches nothing', async () => {
    const h = harness(['Search', 'Anil Turaga'], { stopped: true })
    // A scan from before the stop, so `press` has something it could have used.
    h.context.scan = { harvestId: 'h1', targets: [target(0, 'Search')] }

    const outcomes = [
      await look(h.context, { want: 'both' }, sleep),
      await find(h.context, { query: 'Anil' }, sleep),
      await press(h.context, { index: 0, expectTitle: 'Search' }),
      note(h.context, { text: 'still going' })
    ]

    for (const out of outcomes) {
      expect(out.ok).toBe(false)
      expect(out.text).toBe(STOPPED_MESSAGE)
    }
    expect(h.sidecar.targetActions).toEqual([])
    expect(h.rows).toEqual([])
  })
})

describe('findTargets', () => {
  const list = [
    target(0, 'Search'),
    target(1, 'Anil Turaga'),
    target(2, 'Anil Turaga (away, notifications snoozed)'),
    target(3, 'Search messages from Priya Sharma and 4 others'),
    target(4, 'Priya Sharma'),
    target(5, 'Jump to', 'type')
  ]

  it('puts an exact title first, then a prefix, then a mention', () => {
    const hits = findTargets(list, 'Anil Turaga')
    expect(hits[0]?.index).toBe(1)
    expect(hits[1]?.index).toBe(2)
  })

  /**
   * The ranking that matters most in practice: a short precise label beats a
   * long one that merely contains the word.
   */
  it('prefers the label that is mostly the thing you asked for', () => {
    const hits = findTargets(list, 'Priya')
    expect(hits[0]?.index).toBe(4)
  })

  it('needs every word of a multi-word query to appear somewhere', () => {
    expect(findTargets(list, 'Anil Sharma')).toEqual([])
  })

  it('filters by kind when asked', () => {
    expect(findTargets(list, 'jump', 'press')).toEqual([])
    expect(findTargets(list, 'jump', 'type').map((t) => t.index)).toEqual([5])
  })

  it('finds nothing for nothing', () => {
    expect(findTargets(list, '   ')).toEqual([])
    expect(findTargets(list, 'Bartholomew')).toEqual([])
  })

  // Ten, not everything: enough that the right one is almost always among them,
  // few enough that asking twice beats reading the whole scan once.
  it('never returns more than ten', () => {
    const many = Array.from({ length: 40 }, (_, i) => target(i, `message ${i}`))
    expect(findTargets(many, 'message')).toHaveLength(10)
  })
})
