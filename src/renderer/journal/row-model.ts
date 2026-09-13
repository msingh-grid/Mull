import type { JournalEntryView } from '@shared/types'

/**
 * Journal row presentation (docs/DESIGN.md §6.5).
 *
 * Pure, and therefore testable — which matters most for `undoAffordance`. The
 * honest thing for a row that cannot be undone is to say *why*, not to hide
 * the button: a record that quietly omits its own limits is the kind of record
 * nobody checks twice.
 */

export type RowKind = 'dictation' | 'edit' | 'command' | 'failed' | 'undone'

export function rowKind(entry: JournalEntryView): RowKind {
  if (entry.status === 'undone') return 'undone'
  if (entry.status === 'failed' || entry.status === 'cancelled') return 'failed'
  switch (entry.intent.kind) {
    case 'edit':
      return 'edit'
    case 'command':
      return 'command'
    default:
      return 'dictation'
  }
}

export const KIND_LABEL: Record<RowKind, string> = {
  dictation: 'Dictation',
  edit: 'Edit',
  command: 'Command',
  failed: 'Failed',
  undone: 'Undone'
}

export function rowTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** "2 changes", "19 characters", or nothing worth saying. */
export function rowMeasure(entry: JournalEntryView): string | null {
  if (entry.changes !== null && entry.changes > 0) {
    return `${entry.changes} ${entry.changes === 1 ? 'change' : 'changes'}`
  }
  const chars = entry.after?.length ?? 0
  if (chars === 0) return null
  return `${chars} ${chars === 1 ? 'character' : 'characters'}`
}

export interface UndoAffordance {
  enabled: boolean
  label: string
  /** Shown when the button is disabled. Always a reason, never silence. */
  why: string | null
}

export function undoAffordance(entry: JournalEntryView): UndoAffordance {
  if (entry.status === 'undone') {
    return { enabled: false, label: 'Undone', why: 'Mull already put this back.' }
  }
  if (entry.status !== 'applied') {
    return { enabled: false, label: 'Undo', why: 'Nothing was changed, so there is nothing to undo.' }
  }
  if (entry.verified !== true) {
    return {
      enabled: false,
      label: 'Undo',
      why: 'This app wouldn’t confirm the text landed, so Mull won’t remove it. ⌘Z should work.'
    }
  }
  if (!entry.undoable) {
    return { enabled: false, label: 'Undo', why: 'This entry can no longer be undone.' }
  }
  return { enabled: true, label: 'Undo', why: null }
}
