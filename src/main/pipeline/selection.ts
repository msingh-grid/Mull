import type { SidecarApi } from '@shared/sidecar-api'

/**
 * The selection, read once and remembered.
 *
 * An edit is a promise about a specific piece of text: *this* is what I read,
 * *these* are the marks, and applying will put the result exactly there. The
 * snapshot is what makes that promise checkable. It is taken while the user is
 * still holding the key — before they have finished speaking, let alone before
 * any engine is involved — and checked again immediately before the write.
 *
 * Between those two moments the user can click somewhere else, switch apps, or
 * type over the selection. Every one of those has to end in a refusal rather
 * than a write, for the same reason `UndoService` refuses: replacing text the
 * user has moved on from is how an assistant destroys someone's writing.
 */

export interface SelectionSnapshot {
  app: { bundleId: string; name: string } | null
  /** Absolute UTF-16 offset in the element's whole value; -1 when unknown. */
  start: number
  length: number
  /** What was selected. Never empty — an empty selection is not a snapshot. */
  text: string
}

/** Why the text Mull read is no longer the text it would be replacing. */
export type SelectionCheck =
  | { ok: true }
  | { ok: false; reason: 'different-app' | 'no-selection' | 'text-changed' | 'unreadable' }

/**
 * Read the selection, or return null.
 *
 * Called off the critical path during the hold, so every failure is simply
 * "there is no selection" — an app that cannot be read through AX is not an
 * error here, it just means this utterance is dictation.
 */
export async function captureSelection(
  sidecar: SidecarApi,
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
): Promise<SelectionSnapshot | null> {
  try {
    const focused = await sidecar.focusedElement({ contextBytes: 4096 })
    const selection = focused.element?.selection
    if (!selection || !selection.text) return null
    return {
      app: focused.app ? { bundleId: focused.app.bundleId, name: focused.app.name } : null,
      start: selection.start,
      length: selection.length,
      text: selection.text
    }
  } catch (err) {
    log?.('warn', 'selection: focusedElement failed', err)
    return null
  }
}

/**
 * Is the snapshot still what an apply would overwrite?
 *
 * Compared by *text*, not by offset: an edit further up the document shifts
 * every offset below it, and refusing in that case would be pedantry. What
 * must not have changed is the characters themselves.
 */
export async function stillMatches(
  sidecar: SidecarApi,
  snapshot: SelectionSnapshot
): Promise<SelectionCheck> {
  let live: Awaited<ReturnType<SidecarApi['focusedElement']>>
  try {
    live = await sidecar.focusedElement({ contextBytes: 4096 })
  } catch {
    return { ok: false, reason: 'unreadable' }
  }

  if (snapshot.app && live.app && live.app.bundleId !== snapshot.app.bundleId) {
    return { ok: false, reason: 'different-app' }
  }
  const selection = live.element?.selection
  if (!selection || !selection.text) return { ok: false, reason: 'no-selection' }
  if (selection.text !== snapshot.text) return { ok: false, reason: 'text-changed' }
  return { ok: true }
}

/** Sentence for the HUD when an apply is refused. */
export function describeSelectionCheck(reason: Exclude<SelectionCheck, { ok: true }>['reason']): string {
  switch (reason) {
    case 'different-app':
      return 'You’ve switched apps since Mull read that text — nothing was changed.'
    case 'no-selection':
      return 'The selection is gone — select the text again and Mull will redo the edit.'
    case 'text-changed':
      return 'That text has changed since Mull read it — nothing was changed.'
    case 'unreadable':
      return 'Mull couldn’t re-read the selection, so it didn’t change anything.'
  }
}

/** Word count for the "42 words selected" chip. Cheap and approximate by design. */
export function countWords(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length
}
