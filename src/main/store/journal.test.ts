import { describe, expect, it } from 'vitest'
import type { JournalDraft } from '@shared/types'
import { JournalStore } from './journal'
import { memoryDatabase } from './journal.test-helpers'

function store(now = () => 1_000): JournalStore {
  return new JournalStore(memoryDatabase(), now)
}

function draft(over: Partial<JournalDraft> = {}): JournalDraft {
  return {
    intent: { kind: 'dictate', text: 'send the deck today' },
    app: { bundleId: 'com.apple.mail', name: 'Mail' },
    before: null,
    after: 'Send the deck today',
    strategyUsed: 'ax',
    status: 'applied',
    summary: 'Dictation · Mail · “Send the deck today”',
    verified: true,
    caret: 42,
    undoable: true,
    ...over
  }
}

describe('JournalStore', () => {
  it('round-trips an entry', () => {
    const journal = store()
    const written = journal.append(draft())
    const read = journal.get(written.id)

    expect(read).toEqual(written)
    expect(read?.app?.name).toBe('Mail')
    expect(read?.intent).toEqual({ kind: 'dictate', text: 'send the deck today' })
    expect(read?.at).toBe(1_000)
  })

  it('returns entries newest first', () => {
    let clock = 1_000
    const journal = store(() => clock)
    journal.append(draft({ summary: 'first' }))
    clock = 2_000
    journal.append(draft({ summary: 'second' }))

    expect(journal.recent().map((e) => e.summary)).toEqual(['second', 'first'])
    expect(journal.recent(1)).toHaveLength(1)
  })

  it('records failures too — a journal of only successes teaches distrust', () => {
    const journal = store()
    journal.append(draft({ status: 'failed', after: null, undoable: false, verified: null }))

    const [entry] = journal.recent()
    expect(entry?.status).toBe('failed')
    expect(entry?.verified).toBeNull()
    expect(journal.lastUndoable()).toBeNull()
  })

  it('refuses to mark an unverified write undoable', () => {
    const journal = store()
    const entry = journal.append(draft({ verified: null, undoable: true }))

    expect(entry.undoable).toBe(false)
    expect(journal.lastUndoable()).toBeNull()
  })

  it('refuses to mark a write with no caret undoable', () => {
    const journal = store()
    expect(journal.append(draft({ caret: null })).undoable).toBe(false)
  })

  it('finds the newest undoable entry, optionally scoped to an app', () => {
    let clock = 1_000
    const journal = store(() => clock)
    journal.append(draft({ summary: 'mail one' }))
    clock = 2_000
    journal.append(
      draft({ summary: 'notes one', app: { bundleId: 'com.apple.Notes', name: 'Notes' } })
    )

    expect(journal.lastUndoable()?.summary).toBe('notes one')
    expect(journal.lastUndoable('com.apple.mail')?.summary).toBe('mail one')
    expect(journal.lastUndoable('com.example.nothing')).toBeNull()
  })

  it('stops offering an entry once it is undone', () => {
    const journal = store()
    const entry = journal.append(draft())
    journal.markUndone(entry.id, 5_000)

    const read = journal.get(entry.id)
    expect(read?.status).toBe('undone')
    expect(read?.undoable).toBe(false)
    expect(read?.undoneAt).toBe(5_000)
    expect(journal.lastUndoable()).toBeNull()
  })

  it('can retire an entry without claiming it was undone', () => {
    const journal = store()
    const entry = journal.append(draft())
    journal.markNotUndoable(entry.id)

    expect(journal.get(entry.id)?.status).toBe('applied')
    expect(journal.lastUndoable()).toBeNull()
  })

  it('prunes to the newest N, since every row holds what was said', () => {
    let clock = 0
    const journal = store(() => (clock += 1_000))
    for (let i = 0; i < 10; i += 1) journal.append(draft({ summary: `entry ${i}` }))

    expect(journal.prune(4)).toBe(6)
    expect(journal.count()).toBe(4)
    expect(journal.recent()[0]?.summary).toBe('entry 9')
  })

  it('survives an entry whose intent JSON is unreadable', () => {
    const journal = store()
    const entry = journal.append(draft())
    // Simulate corruption from an older schema.
    const db = memoryDatabase()
    const corrupted = new JournalStore(db)
    corrupted.append({ ...draft(), id: entry.id })
    db.prepare('UPDATE entries SET intent = ? WHERE id = ?').run('{not json', entry.id)

    const read = corrupted.get(entry.id)
    expect(read?.intent.kind).toBe('dictate')
  })

  it('round-trips the group, the timing and the detail', () => {
    const journal = store()
    const written = journal.append(
      draft({
        groupId: 'plan-1',
        ms: 430,
        detail: { step: 2, because: 'the sidebar row', scan: { targets: 300, press: 299, type: 1, stoppedBy: 'targets' } }
      })
    )
    expect(journal.get(written.id)).toEqual(written)
    expect(journal.get(written.id)?.detail?.scan?.stoppedBy).toBe('targets')
  })

  it('leaves them null on a row that carries none', () => {
    const journal = store()
    const written = journal.append(draft())
    expect(written.groupId).toBeNull()
    expect(written.ms).toBeNull()
    expect(written.detail).toBeNull()
    expect(journal.get(written.id)).toEqual(written)
  })

  describe('amend', () => {
    it('fills in what was not knowable when the row was written', () => {
      // A press is journalled the moment it happens; whether it moved anything
      // is only visible from the next look at the window.
      const journal = store()
      const entry = journal.append(draft({ detail: { step: 1 } }))
      journal.amend(entry.id, { detail: { evidence: 'the window changed: 300 became 6' }, ms: 412 })

      const read = journal.get(entry.id)
      expect(read?.detail).toEqual({ step: 1, evidence: 'the window changed: 300 became 6' })
      expect(read?.ms).toBe(412)
    })

    /**
     * The line this must not cross. Every field below is what makes the row a
     * record rather than a note, and `undoable`/`verified`/`after` are what
     * undo reads before it removes someone's text.
     */
    it('cannot rewrite the verdict, the text, or the receipt', () => {
      const journal = store()
      const entry = journal.append(draft())
      // Anything beyond detail/ms is not in the signature; this proves it is
      // also ignored at runtime rather than merely unspeakable in TypeScript.
      const smuggled = {
        detail: { evidence: 'x' },
        status: 'failed',
        after: 'tampered',
        undoable: false,
        verified: false
      } as unknown as Parameters<typeof journal.amend>[1]
      journal.amend(entry.id, smuggled)

      const read = journal.get(entry.id)
      expect(read?.status).toBe('applied')
      expect(read?.after).toBe('Send the deck today')
      expect(read?.undoable).toBe(true)
      expect(read?.verified).toBe(true)
    })

    it('is a no-op on a row that is not there', () => {
      const journal = store()
      expect(() => journal.amend('nobody', { ms: 1 })).not.toThrow()
    })

    it('clamps model-authored strings rather than storing a paragraph', () => {
      const journal = store()
      const entry = journal.append(draft())
      journal.amend(entry.id, { detail: { because: 'x'.repeat(5_000) } })
      const because = journal.get(entry.id)?.detail?.because ?? ''
      expect(because.length).toBeLessThan(500)
      expect(because.endsWith('…')).toBe(true)
    })
  })
})
