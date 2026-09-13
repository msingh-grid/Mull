import type { SidecarApi } from '@shared/sidecar-api'

/**
 * What is in front of the caret, read once and remembered.
 *
 * An edit is a promise about a specific piece of text: *this* is what I read,
 * *these* are the marks, and applying will put the result exactly there. The
 * snapshot is what makes that promise checkable. It is taken while the user is
 * still holding the key — before they have finished speaking, let alone before
 * any engine is involved — and checked again immediately before the write.
 *
 * Between those two moments the user can click somewhere else, switch apps, or
 * type over the text. Every one of those has to end in a refusal rather than a
 * write, for the same reason `UndoService` refuses: replacing text the user has
 * moved on from is how an assistant destroys someone's writing.
 *
 * There are three things an edit can act on:
 *
 *   selection  what is highlighted, in a place Mull can write to. Through the
 *              M2 insertion chain when the selection is in the focused element
 *              (so it degrades to paste and works in Electron apps), AX-only
 *              when it is somewhere else — a keystroke always lands on the
 *              focused element, so pasting over a selection held elsewhere
 *              would overwrite the wrong text.
 *   document   the whole focused field, when nothing is highlighted. AX-only,
 *              because a whole-field rewrite has to be exact.
 *   reference  text the user can point at but Mull cannot rewrite: a sent
 *              message, a web page, someone else's document. The rewrite is
 *              **inserted at the caret** instead of replacing anything. This is
 *              the case that produced the second bug report — selecting a sent
 *              Slack message and asking for it to be made less apologetic.
 */

export interface FocusSnapshot {
  app: { bundleId: string; name: string } | null
  /**
   * What is highlighted right now, anywhere in the frontmost app — not only in
   * the focused element. `source` says where it was found and `editable`
   * whether it can be written back to; together they decide which of the three
   * targets an edit gets.
   */
  selection: { text: string; editable: boolean; source: string } | null
  /** The focused field itself, or null when nothing readable has focus. */
  field: {
    /** Absolute UTF-16 offset where `text` begins. */
    start: number
    text: string
    /** True when `text` is a window onto something longer. */
    truncated: boolean
    /** AX reports the value as settable — a whole-field write has a chance. */
    editable: boolean
  } | null
}

export interface EditTarget {
  kind: 'selection' | 'document' | 'reference'
  app: { bundleId: string; name: string } | null
  /** Meaningful for `document` only; the other two write by selection. */
  start: number
  length: number
  /** Never empty — an edit with nothing to act on is not a target. */
  text: string
  /**
   * May a keystroke strategy (paste, type) be used to write this?
   *
   * Only when the selection is in the focused element. Keystrokes go where the
   * caret is, so pasting over a selection held in some other element would
   * replace whatever the caret happens to be sitting in instead.
   */
  keystrokesSafe: boolean
}

export type EditTargetResult =
  | { ok: true; target: EditTarget }
  | { ok: false; message: string }

/** Why the text Mull read is no longer the text it would be replacing. */
export type TargetCheck =
  | { ok: true }
  | { ok: false; reason: 'different-app' | 'no-selection' | 'text-changed' | 'unreadable' }

/**
 * How much of a field Mull is willing to read.
 *
 * Generous — the point is to cover whole composers and notes — but finite. A
 * truncated read cannot become a document edit, because rewriting a window onto
 * a longer document would silently discard everything outside the window.
 */
const CONTEXT_CHARS = 8_192

/**
 * Read what has focus, or return an empty snapshot.
 *
 * Called off the critical path during the hold, so every failure is simply
 * "there is nothing to edit" — an app that cannot be read through AX is not an
 * error here, it just means this utterance is dictation.
 */
export async function captureFocus(
  sidecar: SidecarApi,
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
): Promise<FocusSnapshot> {
  const empty: FocusSnapshot = { app: null, selection: null, field: null }

  // Two questions, and they are genuinely different: "what is the caret in"
  // and "what has the user highlighted". Asked together and in parallel, both
  // during the hold, so neither costs the utterance anything.
  const [focused, selected] = await Promise.all([
    sidecar.focusedElement({ contextBytes: CONTEXT_CHARS }).catch((err: unknown) => {
      log?.('warn', 'focus: focusedElement failed', err)
      return null
    }),
    sidecar.selectedText({}).catch((err: unknown) => {
      log?.('warn', 'focus: selectedText failed', err)
      return null
    })
  ])

  const app = focused?.app ? { bundleId: focused.app.bundleId, name: focused.app.name } : null
  return {
    app,
    selection:
      selected?.text && selected.text.trim()
        ? {
            text: selected.text,
            editable: selected.editable,
            source: selected.source ?? 'focused'
          }
        : null,
    field: focused?.element
      ? {
          start: focused.element.textStart,
          text: focused.element.text,
          truncated: focused.element.truncated,
          editable: focused.element.editable
        }
      : null
  }
}

/**
 * A last look for a selection, using ⌘C.
 *
 * Reached only when AX found nothing *and* the words already look like an
 * instruction — it presses a key in someone else's app, and that is not a thing
 * to do on every utterance. The sidecar saves and restores the pasteboard
 * around it, and refuses outright while secure input is on.
 *
 * Whatever comes back is a `reference`: a copy says nothing about whether its
 * source can be written to, and assuming it can is how you try to overwrite a
 * web page.
 */
export async function probeSelectionByCopy(
  sidecar: SidecarApi,
  snapshot: FocusSnapshot,
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
): Promise<FocusSnapshot> {
  if (snapshot.selection) return snapshot
  try {
    const found = await sidecar.selectedText({ allowCopy: true })
    if (!found.text || !found.text.trim()) return snapshot
    log?.('info', 'focus: selection found by copy', { chars: found.text.length })
    return {
      ...snapshot,
      selection: { text: found.text, editable: false, source: found.source ?? 'copy' }
    }
  } catch (err) {
    log?.('warn', 'focus: the copy probe failed', err)
    return snapshot
  }
}

/** The classifier only ever sees what is actually there. */
export function classifierContext(snapshot: FocusSnapshot): {
  selection: string | null
  fieldText: string | null
  fieldTruncated: boolean
} {
  return {
    selection: snapshot.selection?.text ?? null,
    fieldText: snapshot.field?.text ?? null,
    fieldTruncated: snapshot.field?.truncated ?? false
  }
}

/** Is there anything an edit could act on? Drives the router's fast path. */
export function hasEditableText(snapshot: FocusSnapshot): {
  hasSelection: boolean
  hasFieldText: boolean
} {
  return {
    hasSelection: (snapshot.selection?.text.trim().length ?? 0) > 0,
    hasFieldText: (snapshot.field?.text.trim().length ?? 0) > 0
  }
}

/**
 * Turn the snapshot into the thing an edit will actually rewrite, or say why
 * it cannot. Every refusal here is a sentence the user can act on.
 */
export function editTarget(
  snapshot: FocusSnapshot,
  kind: 'selection' | 'document'
): EditTargetResult {
  if (kind === 'selection') {
    const selection = snapshot.selection
    if (!selection?.text) {
      return { ok: false, message: 'Nothing was selected — select the text and try again.' }
    }
    // Read-only text becomes a `reference`: the rewrite goes to the caret
    // rather than nowhere. Refusing instead would be technically correct and
    // useless — "select your own sent message and improve it" is a thing people
    // want, and the composer is right there.
    return {
      ok: true,
      target: {
        kind: selection.editable ? 'selection' : 'reference',
        app: snapshot.app,
        start: 0,
        length: selection.text.length,
        text: selection.text,
        keystrokesSafe: selection.source === 'focused'
      }
    }
  }

  const field = snapshot.field
  if (!field || !field.text.trim()) {
    return { ok: false, message: 'There’s no text here to edit yet.' }
  }
  if (field.truncated) {
    // Rewriting a window onto a longer document would quietly drop everything
    // outside it. Better to ask for a smaller bite than to lose the rest.
    return {
      ok: false,
      message: 'That’s too long for Mull to rewrite whole — select the part you mean.'
    }
  }
  if (!field.editable) {
    return { ok: false, message: 'This app won’t let Mull rewrite that field directly.' }
  }
  return {
    ok: true,
    target: {
      kind: 'document',
      app: snapshot.app,
      start: field.start,
      length: field.text.length,
      text: field.text,
      keystrokesSafe: false
    }
  }
}

/**
 * Is the target still what an apply would overwrite?
 *
 * Compared by *text*, not by offset: an edit further up the document shifts
 * every offset below it, and refusing in that case would be pedantry. What
 * must not have changed is the characters themselves.
 */
export async function stillMatches(
  sidecar: SidecarApi,
  target: EditTarget
): Promise<TargetCheck> {
  let live: Awaited<ReturnType<SidecarApi['focusedElement']>>
  try {
    live = await sidecar.focusedElement({ contextBytes: CONTEXT_CHARS })
  } catch {
    return { ok: false, reason: 'unreadable' }
  }

  if (target.app && live.app && live.app.bundleId !== target.app.bundleId) {
    return { ok: false, reason: 'different-app' }
  }
  if (!live.element) return { ok: false, reason: 'unreadable' }

  if (target.kind !== 'document') {
    // Re-read the same way it was found, so a selection held outside the
    // focused element is still checkable.
    const selection = await sidecar.selectedText({}).catch(() => null)
    if (!selection?.text) return { ok: false, reason: 'no-selection' }
    return selection.text === target.text ? { ok: true } : { ok: false, reason: 'text-changed' }
  }

  // A document edit rewrites the field's whole value, so the whole value is
  // what has to be unchanged — including anything typed after the caret.
  if (live.element.truncated) return { ok: false, reason: 'text-changed' }
  return live.element.text === target.text ? { ok: true } : { ok: false, reason: 'text-changed' }
}

/** Sentence for the HUD when an apply is refused. */
export function describeTargetCheck(
  reason: Exclude<TargetCheck, { ok: true }>['reason']
): string {
  switch (reason) {
    case 'different-app':
      return 'You’ve switched apps since Mull read that text — nothing was changed.'
    case 'no-selection':
      return 'The selection is gone — select the text again and Mull will redo the edit.'
    case 'text-changed':
      return 'That text has changed since Mull read it — nothing was changed.'
    case 'unreadable':
      return 'Mull couldn’t re-read the text, so it didn’t change anything.'
  }
}

/** Word count for the "42 words" chip. Cheap and approximate by design. */
export function countWords(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length
}
