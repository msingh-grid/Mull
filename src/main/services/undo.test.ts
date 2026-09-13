import { describe, expect, it } from 'vitest'
import type { JournalDraft } from '@shared/types'
import { JournalStore } from '../store/journal'
import { memoryDatabase } from '../store/journal.test-helpers'
import { FakeSidecar, type FakeSidecarOptions } from './sidecar'
import { UndoService } from './undo'

const INSERTED = 'Send the deck today'

function setup(
  sidecarOptions: FakeSidecarOptions = {},
  entry: Partial<JournalDraft> = {}
): { undo: UndoService; sidecar: FakeSidecar; journal: JournalStore; id: string } {
  const sidecar = new FakeSidecar({
    accessibility: true,
    app: { bundleId: 'com.apple.mail', name: 'Mail', pid: 7 },
    text: `Hi there. ${INSERTED}`,
    ...sidecarOptions
  })
  const journal = new JournalStore(memoryDatabase())
  const written = journal.append({
    intent: { kind: 'dictate', text: INSERTED },
    app: { bundleId: 'com.apple.mail', name: 'Mail' },
    before: null,
    after: INSERTED,
    strategyUsed: 'ax',
    status: 'applied',
    summary: `Dictation · Mail · “${INSERTED}”`,
    verified: true,
    caret: `Hi there. ${INSERTED}`.length,
    undoable: true,
    ...entry
  })
  return { undo: new UndoService({ sidecar, journal }), sidecar, journal, id: written.id }
}

describe('UndoService', () => {
  it('removes exactly the characters it inserted', async () => {
    const { undo, sidecar, journal, id } = setup()
    const result = await undo.undoLast()

    expect(result.ok).toBe(true)
    expect(sidecar.text).toBe('Hi there. ')
    expect(journal.get(id)?.status).toBe('undone')
  })

  it('restores the previous text for an edit', async () => {
    const { undo, sidecar } = setup(
      { text: 'Hi there. Send the deck today' },
      { before: 'send it', after: INSERTED }
    )
    const result = await undo.undoLast()

    expect(result.ok).toBe(true)
    expect(sidecar.text).toBe('Hi there. send it')
    expect(result.message).toMatch(/Restored/)
  })

  it('has nothing to undo on a fresh journal', async () => {
    const journal = new JournalStore(memoryDatabase())
    const undo = new UndoService({ sidecar: new FakeSidecar({ accessibility: true }), journal })

    expect((await undo.undoLast()).reason).toBe('nothing-to-undo')
  })

  it('refuses when the user has moved to another app', async () => {
    const { undo, sidecar } = setup({
      app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 9 }
    })
    const result = await undo.undoLast()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('different-app')
    expect(result.message).toContain('Mail')
    expect(sidecar.text).toContain(INSERTED)
  })

  it('refuses when nothing has focus', async () => {
    const { undo } = setup({ noFocus: true })
    expect((await undo.undoLast()).reason).toBe('no-focused-element')
  })

  it('refuses when its own text has been edited', async () => {
    // A word inside the insertion was changed. Neither candidate position
    // holds the characters Mull wrote, so there is nothing it may remove.
    const { undo, sidecar } = setup({ text: 'Hi there. Send the DECK today' })
    const before = sidecar.text
    const result = await undo.undoLast()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('text-changed')
    expect(sidecar.text).toBe(before)
  })

  it('refuses when its text is gone entirely', async () => {
    const { undo, sidecar } = setup({ text: 'Hi there. Something else completely' })
    const before = sidecar.text

    expect((await undo.undoLast()).reason).toBe('text-changed')
    expect(sidecar.text).toBe(before)
  })

  /**
   * The two cases below used to refuse, and now don't.
   *
   * Refusing was over-caution dressed up as safety: in both, Mull's exact
   * characters are still sitting exactly where it put them, and `expect`
   * confirms that inside the sidecar before a single character moves. What had
   * actually changed was only where the *caret* was — and an undo that works
   * solely when you haven't clicked anywhere since is an undo that fails when
   * people reach for it. It is also what makes an applied edit reversible at
   * all, since replacing a selection rarely leaves the caret at the end of the
   * new text.
   */
  it('removes its own text even when you kept typing after it', async () => {
    const { undo, sidecar } = setup({ text: `Hi there. ${INSERTED} and more` })
    const result = await undo.undoLast()

    expect(result.ok).toBe(true)
    // What the user typed afterwards survives; only Mull's words go.
    expect(sidecar.text).toBe('Hi there.  and more')
  })

  it('removes its own text from wherever the caret happens to be', async () => {
    const { undo, sidecar } = setup({ text: `Hi there. ${INSERTED}`, caret: 3 })
    const result = await undo.undoLast()

    expect(result.ok).toBe(true)
    expect(sidecar.text).toBe('Hi there. ')
  })

  it('relies on the sidecar when the element won’t hand over its text', async () => {
    // Web text areas and terminals report a caret but no value, so the local
    // pre-check cannot run at all. `expect` inside the sidecar is the guard
    // that actually gates the write — this proves it, not the pre-check.
    const { undo, sidecar } = setup({
      text: `Hi there. something else entirely`,
      valueUnreadable: true
    })
    sidecar.caret = sidecar.text.length
    const before = sidecar.text
    const result = await undo.undoLast()

    expect(result.reason).toBe('text-changed')
    expect(sidecar.text).toBe(before)
  })

  it('undoes through an element that won’t hand over its text, when the range does match', async () => {
    const { undo, sidecar } = setup({ valueUnreadable: true })
    expect((await undo.undoLast()).ok).toBe(true)
    expect(sidecar.text).toBe('Hi there. ')
  })

  it('refuses to touch a write it could not verify', async () => {
    const { undo, journal, id } = setup({}, { verified: null, undoable: true })
    // The store already refuses to mark it undoable, so this is the belt to the
    // store's braces: a hand-written row must not get undone either.
    journal.append({
      intent: { kind: 'dictate', text: INSERTED },
      app: { bundleId: 'com.apple.mail', name: 'Mail' },
      before: null,
      after: INSERTED,
      strategyUsed: 'paste',
      status: 'applied',
      summary: 'unverified',
      verified: true,
      caret: 29,
      undoable: true
    })
    expect(journal.get(id)?.undoable).toBe(false)
    expect((await undo.undoLast()).entry?.summary).toBe('unverified')
  })

  it('reports secure input rather than silently doing nothing', async () => {
    const { undo } = setup({ secureInput: true })
    const result = await undo.undoLast()

    expect(result.reason).toBe('blocked')
    expect(result.message).toMatch(/Secure input/)
  })

  it('undoes only once', async () => {
    const { undo } = setup()
    expect((await undo.undoLast()).ok).toBe(true)
    expect((await undo.undoLast()).reason).toBe('nothing-to-undo')
  })

  it('peek says what ⌥Z would reverse', async () => {
    const { undo } = setup()
    expect(undo.peek()?.after).toBe(INSERTED)
    await undo.undoLast()
    expect(undo.peek()).toBeNull()
  })
})

describe('UndoService.undo(entryId)', () => {
  it('reverses a specific entry, not merely the newest one', async () => {
    const { undo, sidecar, journal, id } = setup()
    // A later entry that is not undoable — ⌥Z would stop at the older one
    // anyway, but the journal window points at this id directly.
    journal.append({
      intent: { kind: 'dictate', text: 'later' },
      app: { bundleId: 'com.apple.mail', name: 'Mail' },
      before: null,
      after: 'later',
      strategyUsed: 'paste',
      status: 'applied',
      summary: 'Dictation · Mail · “later”',
      verified: null,
      caret: null,
      undoable: true
    })

    const result = await undo.undo(id)
    expect(result.ok).toBe(true)
    expect(sidecar.text).toBe('Hi there. ')
    expect(journal.get(id)?.status).toBe('undone')
  })

  it('refuses an entry it has already undone', async () => {
    const { undo, id } = setup()
    expect((await undo.undo(id)).ok).toBe(true)

    const again = await undo.undo(id)
    expect(again.ok).toBe(false)
    expect(again.reason).toBe('nothing-to-undo')
    expect(again.message).toMatch(/already been undone/)
  })

  it('refuses an entry the store never considered undoable', async () => {
    const { undo, journal } = setup()
    const unverified = journal.append({
      intent: { kind: 'dictate', text: 'pasted' },
      app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
      before: null,
      after: 'pasted',
      strategyUsed: 'paste',
      status: 'applied',
      summary: 'Dictation · Slack',
      verified: null,
      caret: null,
      undoable: true // the store overrides this: verified is not true
    })

    const result = await undo.undo(unverified.id)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-verified')
  })

  it('refuses an id that is not in the journal', async () => {
    const { undo } = setup()
    const result = await undo.undo('no-such-entry')
    expect(result.ok).toBe(false)
    expect(result.entry).toBeNull()
  })

  it('applies the same app gate as ⌥Z', async () => {
    const { undo, id, sidecar } = setup({
      app: { bundleId: 'com.apple.Notes', name: 'Notes', pid: 9 }
    })
    const result = await undo.undo(id)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('different-app')
    expect(sidecar.text).toContain(INSERTED)
  })

  it('applies the same changed-text gate as ⌥Z', async () => {
    const { undo, id, sidecar } = setup({ text: 'Hi there. Send the DECK today' })
    const result = await undo.undo(id)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('text-changed')
    expect(sidecar.text).toBe('Hi there. Send the DECK today')
  })
})

describe('UndoService — a sent message', () => {
  /**
   * The send row is `undoable: false` like several others, but for a reason
   * nothing else shares: there is no reverse operation at all. "Mull couldn't
   * confirm that text when it was inserted" would send someone looking for a
   * way to make it confirm; this answer is the true one.
   */
  it('refuses by name rather than with the generic not-verified sentence', async () => {
    const { undo, id } = setup(
      {},
      {
        intent: {
          kind: 'command',
          verb: 'send',
          args: { app: 'com.tinyspeck.slackmacgap', chord: '⏎' },
          transcript: 'reply and send it'
        },
        before: null,
        after: null,
        status: 'applied',
        summary: 'Sent · Slack',
        verified: true,
        caret: null,
        undoable: false
      }
    )

    const result = await undo.undo(id)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('irreversible')
    expect(result.message).toContain('unsend')
  })

  it('is never what ⌥Z reaches for', async () => {
    const { undo } = setup(
      {},
      {
        intent: { kind: 'command', verb: 'send', args: {}, transcript: 'send it' },
        after: null,
        undoable: false
      }
    )
    const result = await undo.undoLast()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('nothing-to-undo')
  })
})

describe('UndoService — a send that did not go', () => {
  it('does not warn about unsending a message that never left', async () => {
    const { undo, id } = setup(
      {},
      {
        intent: { kind: 'command', verb: 'send', args: {}, transcript: 'reply and send it' },
        before: null,
        after: null,
        status: 'failed',
        summary: 'Send failed · Slack · unchanged',
        verified: false,
        caret: null,
        undoable: false
      }
    )

    const result = await undo.undo(id)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-verified')
    expect(result.message).not.toContain('unsend')
  })
})
