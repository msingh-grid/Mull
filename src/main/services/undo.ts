import type { SidecarApi } from '@shared/sidecar-api'
import type { JournalEntry } from '@shared/types'
import type { JournalStore } from '../store/journal'

/**
 * ⌥Z — take back the last thing Mull did.
 *
 * The design constraint is severity-asymmetric. Failing to undo is a small
 * annoyance: the user selects the text and deletes it themselves. Undoing the
 * *wrong* text is the worst thing this app can do — it silently destroys
 * something a person wrote. So every check here is a refusal by default, and
 * the service only ever removes text it has just confirmed, character for
 * character, is still sitting where it left it:
 *
 *   1. the entry was verified when it was written (we read it back then),
 *   2. the same app is frontmost now,
 *   3. a text element has focus and reports a caret,
 *   4. the range ending at that caret still holds exactly the inserted text —
 *      checked locally against the element's own text, then again inside the
 *      sidecar via `expect`, which is the check that actually gates the write.
 *
 * Any doubt ends as a refusal with a sentence explaining which check failed.
 */

export type UndoReason =
  | 'nothing-to-undo'
  | 'different-app'
  | 'no-focused-element'
  | 'no-caret'
  | 'text-changed'
  | 'not-verified'
  | 'blocked'
  | 'failed'

export interface UndoOutcome {
  ok: boolean
  entry: JournalEntry | null
  reason: UndoReason | null
  /** One sentence, for the HUD. Always set — including on success. */
  message: string
}

export interface UndoDeps {
  sidecar: SidecarApi
  journal: JournalStore
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  now?: () => number
}

export class UndoService {
  private readonly now: () => number
  private readonly log: NonNullable<UndoDeps['log']>

  constructor(private readonly deps: UndoDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? ((): void => {})
  }

  /** What ⌥Z would reverse right now, for the HUD's undo affordance. */
  peek(): JournalEntry | null {
    return this.deps.journal.lastUndoable()
  }

  /** ⌥Z: reverse the most recent entry that can still be reversed. */
  async undoLast(): Promise<UndoOutcome> {
    const entry = this.deps.journal.lastUndoable()
    if (!entry) {
      return {
        ok: false,
        entry: null,
        reason: 'nothing-to-undo',
        message: 'Nothing to undo.'
      }
    }
    return this.undoEntry(entry)
  }

  /**
   * Undo one specific entry — what the journal window's per-row button does.
   *
   * Every gate below is the same one ⌥Z passes through, which is the point: a
   * journal row whose Undo button took a shortcut the keyboard path doesn't
   * would be a button that lies about what it does. The only thing this adds
   * is the lookup, and it refuses an entry the store no longer considers
   * undoable rather than re-deciding that question here.
   */
  async undo(entryId: string): Promise<UndoOutcome> {
    const entry = this.deps.journal.get(entryId)
    if (!entry) {
      return { ok: false, entry: null, reason: 'nothing-to-undo', message: 'That entry is gone.' }
    }
    if (entry.status === 'undone') {
      return {
        ok: false,
        entry,
        reason: 'nothing-to-undo',
        message: 'That one has already been undone.'
      }
    }
    if (!entry.undoable) {
      return {
        ok: false,
        entry,
        reason: 'not-verified',
        message: 'Mull couldn’t confirm that text when it was inserted, so it won’t remove it now.'
      }
    }
    return this.undoEntry(entry)
  }

  private async undoEntry(entry: JournalEntry): Promise<UndoOutcome> {
    const inserted = entry.after ?? ''
    const restore = entry.before ?? ''
    if (!inserted) {
      this.deps.journal.markNotUndoable(entry.id)
      return {
        ok: false,
        entry,
        reason: 'nothing-to-undo',
        message: 'That entry didn’t change any text.'
      }
    }
    if (entry.verified !== true) {
      // Belt and braces — the store shouldn't have marked this undoable.
      this.deps.journal.markNotUndoable(entry.id)
      return {
        ok: false,
        entry,
        reason: 'not-verified',
        message: 'Mull couldn’t confirm that text when it was inserted, so it won’t remove it now.'
      }
    }

    const { app } = await this.deps.sidecar.frontmostApp({})
    if (entry.app && app?.bundleId !== entry.app.bundleId) {
      return {
        ok: false,
        entry,
        reason: 'different-app',
        message: `That text went into ${entry.app.name} — switch back and press ⌥Z there.`
      }
    }

    const focused = await this.deps.sidecar.focusedElement({ contextBytes: 2048 })
    if (!focused.element) {
      return {
        ok: false,
        entry,
        reason: 'no-focused-element',
        message: 'Click back into the text field first, then press ⌥Z.'
      }
    }
    const caret = focused.element.selection?.start
    if (caret === undefined || caret < 0) {
      return {
        ok: false,
        entry,
        reason: 'no-caret',
        message: 'This field doesn’t report where the caret is, so Mull can’t undo here.'
      }
    }

    const length = utf16Length(inserted)
    const start = caret - length
    if (start < 0) {
      return {
        ok: false,
        entry,
        reason: 'text-changed',
        message: 'The text has changed since Mull inserted it — nothing was undone.'
      }
    }

    // Local pre-check, when the element handed us a window that covers the
    // range. It cannot replace the sidecar's `expect` (the document can change
    // between these two calls) but it produces the better error message.
    const local = sliceIfCovered(
      focused.element.text,
      focused.element.textStart,
      start,
      length
    )
    if (local !== null && local !== inserted) {
      return {
        ok: false,
        entry,
        reason: 'text-changed',
        message: 'The text has changed since Mull inserted it — nothing was undone.'
      }
    }

    const result = await this.deps.sidecar.replaceRange({
      start,
      length,
      text: restore,
      expect: inserted
    })

    if (!result.replaced) {
      const reason: UndoReason =
        result.reason === 'expect-mismatch'
          ? 'text-changed'
          : result.reason === 'secure-input' || result.reason === 'no-accessibility'
            ? 'blocked'
            : 'failed'
      this.log('warn', 'undo refused', { entry: entry.id, reason: result.reason })
      return { ok: false, entry, reason, message: describeUndoFailure(result.reason) }
    }

    this.deps.journal.markUndone(entry.id, this.now())
    this.log('info', 'undo applied', { entry: entry.id, chars: length })
    return {
      ok: true,
      entry,
      reason: null,
      message: restore ? 'Restored the previous text.' : `Removed “${preview(inserted)}”.`
    }
  }
}

function utf16Length(text: string): number {
  return text.length
}

/**
 * The element's text is a window starting at `textStart`. Return the slice for
 * an absolute range, or null when the window doesn't cover it.
 */
function sliceIfCovered(
  windowText: string,
  textStart: number,
  start: number,
  length: number
): string | null {
  const relative = start - textStart
  if (relative < 0) return null
  if (relative + length > windowText.length) return null
  return windowText.slice(relative, relative + length)
}

function preview(text: string, max = 32): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function describeUndoFailure(reason: string | null): string {
  switch (reason) {
    case 'expect-mismatch':
      return 'The text has changed since Mull inserted it — nothing was undone.'
    case 'secure-input':
      return 'Secure input is on — Mull paused. Nothing was undone.'
    case 'no-accessibility':
      return 'Mull needs Accessibility access to undo. Grant it in System Settings → Privacy & Security → Accessibility.'
    case 'ax-unsupported':
      return 'This app doesn’t let Mull edit text directly, so undo isn’t available here. ⌘Z should work.'
    case 'no-focused-element':
      return 'Click back into the text field first, then press ⌥Z.'
    default:
      return `Couldn’t undo${reason ? ` (${reason})` : ''}.`
  }
}
