import { describe, expect, it } from 'vitest'
import type { JournalEntryView } from '@shared/types'
import type { JournalGroup } from './row-model'
import {
  groupEntries,
  groupView,
  stepToggleTarget,
  isPlan,
  planMeasure,
  rowElapsed,
  rowKind,
  rowMeasure,
  undoAffordance
} from './row-model'

const entry = (patch: Partial<JournalEntryView> = {}): JournalEntryView => ({
  id: 'e1',
  at: 1_700_000_000_000,
  intent: { kind: 'dictate', text: 'Send the deck today' },
  app: { bundleId: 'com.apple.mail', name: 'Mail' },
  before: null,
  after: 'Send the deck today',
  strategyUsed: 'ax',
  status: 'applied',
  summary: 'Dictation · Mail',
  verified: true,
  caret: 42,
  undoable: true,
  undoneAt: null,
  changes: null,
  ...patch
})

describe('rowKind', () => {
  it('names the intent when the action stuck', () => {
    expect(rowKind(entry())).toBe('dictation')
    expect(
      rowKind(entry({ intent: { kind: 'edit', instruction: 'crisp', target: 'selection', transcript: '' } }))
    ).toBe('edit')
  })

  it('lets the outcome outrank the intent', () => {
    expect(rowKind(entry({ status: 'undone' }))).toBe('undone')
    expect(rowKind(entry({ status: 'failed' }))).toBe('failed')
    expect(rowKind(entry({ status: 'cancelled' }))).toBe('failed')
  })
})

describe('rowMeasure', () => {
  it('counts changes when there were changes to count', () => {
    expect(rowMeasure(entry({ changes: 2 }))).toBe('2 changes')
    expect(rowMeasure(entry({ changes: 1 }))).toBe('1 change')
  })

  it('falls back to characters for plain dictation', () => {
    expect(rowMeasure(entry({ after: 'hello' }))).toBe('5 characters')
  })

  it('says nothing when there is nothing to measure', () => {
    expect(rowMeasure(entry({ after: null }))).toBeNull()
  })
})

describe('undoAffordance', () => {
  it('offers undo for a verified, applied entry', () => {
    expect(undoAffordance(entry())).toEqual({ enabled: true, label: 'Undo', why: null })
  })

  it('always gives a reason when it refuses — never a hidden button', () => {
    const refusals = [
      entry({ status: 'undone' }),
      entry({ status: 'failed' }),
      entry({ verified: null }),
      entry({ verified: false }),
      entry({ undoable: false })
    ]
    for (const candidate of refusals) {
      const affordance = undoAffordance(candidate)
      expect(affordance.enabled).toBe(false)
      expect(affordance.why).toBeTruthy()
    }
  })

  it('points at ⌘Z when the app never confirmed the write', () => {
    expect(undoAffordance(entry({ verified: null })).why).toContain('⌘Z')
  })

  it('says so plainly once an entry has been undone', () => {
    expect(undoAffordance(entry({ status: 'undone' })).label).toBe('Undone')
  })
})

describe('a send row', () => {
  const send = (patch: Partial<JournalEntryView> = {}): JournalEntryView =>
    entry({
      intent: { kind: 'command', verb: 'send', args: {}, transcript: 'reply and send it' },
      before: null,
      after: null,
      strategyUsed: null,
      summary: 'Sent · Slack',
      caret: null,
      undoable: false,
      ...patch
    })

  it('says what it was, not merely that it was a command', () => {
    // "Command" was the badge on every navigation verb and on this — a whole
    // expedition, each of its presses, and an irreversible send all wearing the
    // same word on the part of the row the eye lands on first.
    expect(rowKind(send())).toBe('sent')
  })

  /**
   * The reason matters more than the disabled state. "This app wouldn't
   * confirm the text landed" would send someone hunting for a setting; the
   * true answer is that there is nothing to undo a send with.
   */
  it('says it cannot be unsent, rather than blaming the app', () => {
    expect(undoAffordance(send())).toEqual({
      enabled: false,
      label: 'Undo',
      why: 'Mull can’t unsend a message.'
    })
    // …including the send Mull could not confirm, which `verified: null` would
    // otherwise route into the app-wouldn't-confirm sentence.
    expect(undoAffordance(send({ verified: null })).why).toBe('Mull can’t unsend a message.')
  })

  /**
   * A send that did not go through sent nothing, so the reason is the ordinary
   * one. Telling someone they cannot unsend a message that never left would be
   * the wrong worry entirely.
   */
  it('does not claim a failed send is unsendable', () => {
    expect(undoAffordance(send({ status: 'failed' })).why).toBe(
      'Nothing was changed, so there is nothing to undo.'
    )
  })
})

describe('a navigation row', () => {
  const nav = (verb: string, patch: Partial<JournalEntryView> = {}): JournalEntryView =>
    entry({
      intent: { kind: 'command', verb, args: {}, transcript: 'open Anil’s DM' },
      undoable: false,
      ...patch
    })

  it('names the verb instead of calling everything a command', () => {
    expect(rowKind(nav('nav.plan'))).toBe('looked')
    expect(rowKind(nav('nav.press'))).toBe('pressed')
    expect(rowKind(nav('nav.type'))).toBe('typed')
    expect(rowKind(nav('nav.read'))).toBe('read')
    expect(rowKind(nav('nav.navKey'))).toBe('key')
  })

  it('still says Failed first — what happened outranks what it was', () => {
    expect(rowKind(nav('nav.press', { status: 'failed' }))).toBe('failed')
  })

  it('falls back to Command for a verb nobody has taught it', () => {
    expect(rowKind(nav('nav.somethingNew'))).toBe('command')
  })

  it('knows an expedition from one of its steps', () => {
    expect(isPlan(nav('nav.plan'))).toBe(true)
    expect(isPlan(nav('nav.press'))).toBe(false)
    expect(isPlan(entry())).toBe(false)
  })

  /**
   * "441 characters" was the measure on a row whose entire point was the
   * answer — the same mistake the navigation lane made when it reported "51
   * blocks · 6023 chars" to somebody who had asked what a conversation said.
   */
  it('measures an expedition in work done, not characters returned', () => {
    expect(planMeasure(nav('nav.plan', { ms: 17_795 }), 4)).toBe('4 steps · 17.8s')
    expect(planMeasure(nav('nav.plan', { ms: 430 }), 1)).toBe('1 step · 430ms')
    expect(planMeasure(nav('nav.plan', { ms: null }), 2)).toBe('2 steps')
  })

  it('says nothing about elapsed time when nobody measured it', () => {
    expect(rowElapsed(null)).toBeNull()
    expect(rowElapsed(undefined)).toBeNull()
  })
})

const nav = (id: string, verb: string, groupId: string | null): JournalEntryView =>
  entry({
    id,
    groupId,
    intent: { kind: 'command', verb, args: {}, transcript: 'open Anil’s DM' },
    undoable: false
  })

describe('groupEntries', () => {

  /**
   * The list arrives newest-first and the plan's own row is written *last*, so
   * a plan sits above its own steps and cannot be grouped by adjacency.
   */
  it('gathers an expedition and its steps, whatever order they arrive in', () => {
    const groups = groupEntries([
      nav('plan', 'nav.plan', 'plan'),
      nav('s3', 'nav.read', 'plan'),
      nav('s2', 'nav.press', 'plan'),
      nav('s1', 'nav.press', 'plan'),
      entry({ id: 'dict' })
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]?.head.id).toBe('plan')
    // Read in the order it was walked, not the order it was listed.
    expect(groups[0]?.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(groups[1]?.head.id).toBe('dict')
    expect(groups[1]?.steps).toEqual([])
  })

  it('lets the plan take the head even when it sorts below a step', () => {
    // Two rows inside one millisecond order by rowid, and the plan can lose.
    const groups = groupEntries([nav('s1', 'nav.press', 'plan'), nav('plan', 'nav.plan', 'plan')])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.head.id).toBe('plan')
    expect(groups[0]?.steps.map((s) => s.id)).toEqual(['s1'])
  })

  it('keeps an orphaned step visible rather than swallowing it', () => {
    // A plan that threw before recording itself still pressed things, and the
    // journal's promise is that everything Mull did is visible.
    const groups = groupEntries([nav('s1', 'nav.press', 'gone')])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.head.id).toBe('s1')
  })

  it('leaves every ungrouped row exactly as it was', () => {
    const rows = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })]
    expect(groupEntries(rows).map((g) => g.head.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('opening a group', () => {
  const group = (): JournalGroup => ({
    head: nav('plan', 'nav.plan', 'plan'),
    steps: [nav('s1', 'nav.press', 'plan'), nav('s2', 'nav.press', 'plan')]
  })

  it('shows nothing until the plan is opened', () => {
    expect(groupView(group(), null)).toEqual({ open: false, headOpen: false })
  })

  it('lists the steps once the plan is open', () => {
    expect(groupView(group(), 'plan')).toEqual({ open: true, headOpen: true })
  })

  /**
   * The regression. Disclosure used to be derived from the head alone, so
   * clicking a step moved the expansion off the head, closed the group, and
   * unmounted the list the step was in — the row vanished under the cursor and
   * the click looked dead.
   */
  it('stays open when a step is the thing expanded', () => {
    expect(groupView(group(), 's2')).toEqual({ open: true, headOpen: false })
  })

  it('is unaffected by a row in some other group', () => {
    expect(groupView(group(), 'somebody-else')).toEqual({ open: false, headOpen: false })
  })

  it('hands a closing step back to its plan, not to nothing', () => {
    // Otherwise folding one step folds the whole expedition.
    expect(stepToggleTarget(group(), 's1', 's1')).toBe('plan')
    expect(stepToggleTarget(group(), 's2', 's1')).toBe('s2')
    expect(stepToggleTarget(group(), 's1', 'plan')).toBe('s1')
  })
})
