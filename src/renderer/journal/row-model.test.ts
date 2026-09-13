import { describe, expect, it } from 'vitest'
import type { JournalEntryView } from '@shared/types'
import { rowKind, rowMeasure, undoAffordance } from './row-model'

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

  it('reads as a command', () => {
    expect(rowKind(send())).toBe('command')
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
