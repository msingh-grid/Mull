import { diffWordsWithSpace } from 'diff'
import type { DiffSegment } from '@shared/hud'

/**
 * Turn a before/after pair into the marks the diff card draws.
 *
 * Word-level rather than character-level, deliberately: the card is read at a
 * glance from two feet away, and a character diff of "summarise" → "summarize"
 * produces confetti. Whole words read as editor's marks; fragments read as
 * noise.
 *
 * This runs in main so the renderer receives a finished picture (see
 * src/shared/hud.ts), and so the interesting part is testable under node.
 */

export interface DiffResult {
  segments: DiffSegment[]
  /**
   * Changes as a human would count them: a replaced word is **one** change,
   * not a deletion plus an insertion. The number in the card title has to
   * match what the body looks like, or the card stops being evidence.
   */
  changes: number
}

export function diffText(before: string, after: string): DiffResult {
  if (before === after) return { segments: before ? [{ kind: 'same', text: before }] : [], changes: 0 }

  const parts = diffWordsWithSpace(before, after)
  const segments: DiffSegment[] = []

  for (const part of parts) {
    if (!part.value) continue
    const kind: DiffSegment['kind'] = part.added ? 'ins' : part.removed ? 'del' : 'same'
    const last = segments[segments.length - 1]
    // The library can emit adjacent runs of the same kind; merging keeps the
    // markup (and the change count) honest.
    if (last && last.kind === kind) last.text += part.value
    else segments.push({ kind, text: part.value })
  }

  return { segments, changes: countChanges(segments) }
}

/** A del immediately followed by an ins is one replacement, counted once. */
function countChanges(segments: DiffSegment[]): number {
  let changes = 0
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]
    if (!segment || segment.kind === 'same') continue
    changes += 1
    if (segment.kind === 'del' && segments[i + 1]?.kind === 'ins') i += 1
  }
  return changes
}

/**
 * Flatten segments back to the text that applying the card would produce.
 * The apply path uses this rather than carrying the after-string separately —
 * one source of truth means the preview cannot promise something the apply
 * does not deliver.
 */
export function appliedText(segments: DiffSegment[]): string {
  return segments
    .filter((segment) => segment.kind !== 'del')
    .map((segment) => segment.text)
    .join('')
}
