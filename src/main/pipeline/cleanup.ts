/**
 * Cleanup v0 — deterministic, local, no model in the loop.
 *
 * The routing invariant (docs/PLAN.md) is that plain dictation NEVER waits on
 * the engine, so everything here must be pure string work measured in
 * microseconds. Anything requiring judgement belongs to the Engine (M4).
 *
 * Rules, in order:
 *   1. drop whisper's non-speech annotations   ([BLANK_AUDIO], (music), ...)
 *   2. drop filler tokens                       (um, uh, erm, ...)
 *   3. normalise whitespace + spacing around punctuation
 *   4. sentence-case the first letter
 *   5. straighten nothing — whisper already emits curly quotes; we keep them
 */

/** Bracketed/parenthesised annotations whisper emits for non-speech audio. */
const ANNOTATION = /[[(](?:blank_audio|silence|music|applause|laughter|inaudible|noise|sound)[^\])]*[\])]/gi

/** Fillers removed anywhere they stand alone as a word. */
const FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'erm', 'er', 'ah', 'mmm', 'hmm'])

export interface CleanupResult {
  text: string
  /** What rule 2 removed, in order — surfaced in the journal, never silently. */
  removedFillers: string[]
}

export function cleanTranscript(raw: string): CleanupResult {
  const removedFillers: string[] = []

  let text = raw.replace(ANNOTATION, ' ')

  // Rule 2: filler removal, word-wise so "I'm humming" survives "hmm".
  text = text
    .split(/(\s+)/)
    .filter((token) => {
      if (!token.trim()) return true
      const bare = token.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
      if (FILLERS.has(bare)) {
        removedFillers.push(bare)
        return false
      }
      return true
    })
    .join('')

  // Rule 3: whitespace + punctuation spacing.
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?%)\]}])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/^[\s,;:.!?-]+/, '')
    .trim()

  // Rule 4: sentence-case the opening letter, leaving ALLCAPS and I/proper
  // nouns alone (we only ever raise, never lower).
  const first = text.search(/\p{L}/u)
  if (first >= 0) {
    text = text.slice(0, first) + text.charAt(first).toUpperCase() + text.slice(first + 1)
  }

  return { text, removedFillers }
}

/** One-line journal summary for a dictation, e.g. `“Send the revised deck…”`. */
export function summarise(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1).trimEnd()}…`
}
