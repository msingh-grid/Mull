import type { JournalEntryView } from '@shared/types'

/**
 * Journal row presentation (docs/DESIGN.md §6.5).
 *
 * Pure, and therefore testable — which matters most for `undoAffordance`. The
 * honest thing for a row that cannot be undone is to say *why*, not to hide
 * the button: a record that quietly omits its own limits is the kind of record
 * nobody checks twice.
 */

export type RowKind =
  | 'dictation'
  | 'edit'
  | 'command'
  | 'answer'
  | 'failed'
  | 'undone'
  // The navigation verbs, which all used to read "Command".
  | 'looked'
  | 'pressed'
  | 'typed'
  | 'read'
  | 'key'
  | 'sent'

/**
 * Which badge a row wears.
 *
 * `command` used to swallow the entire navigation vocabulary: a whole
 * expedition and each of the four presses inside it came out as the same word,
 * on the one part of the row the eye actually lands on. The verb is right there
 * in the intent; using it costs nothing and is most of what makes a session
 * readable after the fact.
 *
 * `failed` and `undone` still outrank everything, because what happened to a
 * row matters more than what kind of row it is.
 */
const COMMAND_KIND: Record<string, RowKind> = {
  'nav.plan': 'looked',
  'nav.press': 'pressed',
  'nav.type': 'typed',
  'nav.read': 'read',
  'nav.navKey': 'key',
  send: 'sent'
}

export function rowKind(entry: JournalEntryView): RowKind {
  if (entry.status === 'undone') return 'undone'
  if (entry.status === 'failed' || entry.status === 'cancelled') return 'failed'
  switch (entry.intent.kind) {
    case 'edit':
      return 'edit'
    case 'command':
      return COMMAND_KIND[entry.intent.verb] ?? 'command'
    // Nothing was typed and nothing was changed: Mull read the window and said
    // something back. Labelling it "Dictation" — which is what `default` did
    // before this row kind existed — describes the one thing it did not do.
    case 'ask':
      return 'answer'
    default:
      return 'dictation'
  }
}

export const KIND_LABEL: Record<RowKind, string> = {
  dictation: 'Dictation',
  edit: 'Edit',
  command: 'Command',
  answer: 'Answer',
  failed: 'Failed',
  undone: 'Undone',
  looked: 'Looked',
  pressed: 'Pressed',
  typed: 'Typed',
  read: 'Read',
  key: 'Key',
  sent: 'Sent'
}

/** Is this row an expedition's own row, rather than one of its steps? */
export function isPlan(entry: JournalEntryView): boolean {
  return entry.intent.kind === 'command' && entry.intent.verb === 'nav.plan'
}

/** "17.8s", "430ms", or nothing when nobody measured it. */
export function rowElapsed(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null
  if (ms < 1_000) return `${ms}ms`
  return `${(ms / 1_000).toFixed(1)}s`
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

/**
 * What a plan's row says on the right: how much work it was, not how many
 * characters came back.
 *
 * "441 characters" was the measure on a row whose whole point was the answer —
 * the same mistake the navigation lane itself made once, reporting "51 blocks ·
 * 6023 chars" to somebody who had asked what a conversation said.
 */
export function planMeasure(entry: JournalEntryView, steps: number): string | null {
  const elapsed = rowElapsed(entry.ms)
  const count = `${steps} ${steps === 1 ? 'step' : 'steps'}`
  return elapsed ? `${count} · ${elapsed}` : count
}

/** One row in the list: either a lone entry, or an expedition and its steps. */
export interface JournalGroup {
  head: JournalEntryView
  /** The steps taken under `head`, oldest first. Empty for a lone entry. */
  steps: JournalEntryView[]
}

/**
 * What a group shows, given which row is expanded.
 *
 * Two questions that look like one and are not: *are the steps listed* and *is
 * the plan's own detail open*. Deriving the first from the second was a bug —
 * clicking a step moved the expansion off the head, which closed the group,
 * which unmounted the list the step lived in. The row vanished under the
 * cursor and the click read as broken.
 *
 * So the group stays disclosed while anything inside it is open.
 */
export function groupView(
  group: JournalGroup,
  expandedId: string | null
): { open: boolean; headOpen: boolean } {
  const headOpen = expandedId === group.head.id
  return {
    headOpen,
    open: headOpen || group.steps.some((step) => step.id === expandedId)
  }
}

/**
 * Where a step's click sends the expansion.
 *
 * Closing a step hands it back to the plan rather than to nothing, so folding
 * one step does not fold the whole expedition out from under the reader. To
 * close the group you click its head, which is where you opened it.
 */
export function stepToggleTarget(
  group: JournalGroup,
  stepId: string,
  expandedId: string | null
): string {
  return expandedId === stepId ? group.head.id : stepId
}

/**
 * Fold the flat list into what the window draws.
 *
 * An expedition writes one row per press *plus* one for itself, and the
 * journal showed all of them as siblings — five `COMMAND` lines that happened
 * to share a minute, with nothing saying they were one request.
 *
 * Collected by `groupId` rather than by adjacency, because the plan's own row
 * is written **last** (after the window is put back) and therefore sorts above
 * its own steps. Order within a group is restored to the order things happened,
 * which is the reverse of the newest-first list they arrive in.
 *
 * A step whose plan is missing — a plan that threw before it could record
 * itself — becomes its own head rather than vanishing. The journal's promise is
 * that everything Mull did is visible, and an orphan is still something Mull
 * did.
 */
export function groupEntries(entries: JournalEntryView[]): JournalGroup[] {
  const heads = new Map<string, JournalGroup>()
  const out: JournalGroup[] = []

  for (const entry of entries) {
    const id = entry.groupId ?? null
    if (id === null) {
      out.push({ head: entry, steps: [] })
      continue
    }
    const existing = heads.get(id)
    if (!existing) {
      // The first row seen for this group leads it. Because the list is
      // newest-first and the plan is written last, that is normally the plan.
      const group: JournalGroup = { head: entry, steps: [] }
      heads.set(id, group)
      out.push(group)
      continue
    }
    // A later arrival that *is* the plan takes the head, and whatever was
    // standing in becomes a step — which is what happens when a plan's own row
    // shares a millisecond with its last step and sorts underneath it.
    if (isPlan(entry) && !isPlan(existing.head)) {
      existing.steps.unshift(existing.head)
      existing.head = entry
    } else {
      existing.steps.push(entry)
    }
  }

  // Newest-first within the list, oldest-first within a group: a list is read
  // downwards from what just happened, but an expedition is read in the order
  // it was walked.
  for (const group of out) group.steps.reverse()
  return out
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
  // After the status check — a send that failed sent nothing, and the line
  // above is the right one for it — but before `verified`, which would
  // otherwise tell someone whose send Mull could not confirm that the *app*
  // wouldn't confirm the text landed. That sentence invites them to go and
  // make it confirm. The true answer is the one `UndoService` gives ⌥Z: a sent
  // message has no reverse operation to offer.
  if (isSend(entry)) {
    return { enabled: false, label: 'Undo', why: 'Mull can’t unsend a message.' }
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

/** The journal's record of a send (M5a). Mirrors the check in `UndoService`. */
function isSend(entry: JournalEntryView): boolean {
  return entry.intent.kind === 'command' && entry.intent.verb === 'send'
}
