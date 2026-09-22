import type { FocusSnapshot } from './selection'

/**
 * Telling whisper what is on screen before it decodes.
 *
 * Whisper's `--prompt` is read as text preceding the utterance, so tokens in
 * it become cheaper for the decoder to emit. That is worth almost nothing to a
 * general dictation app, which has no idea what you are looking at, and a lot
 * to Mull, which has already harvested the frontmost app and the window's
 * accessibility tree *in parallel with the hold* — the context is sitting there
 * paid for by the time ASR starts.
 *
 * Measured on a synthesised "open the eng platform channel in Slack and
 * summarise what Anil said about the terms doc":
 *
 *   base.en, no prompt   "the end platform channel"
 *   base.en, this prompt "the #eng-platform channel"
 *
 * The prompt beat a 3x larger model that had no prompt. Proper nouns are where
 * local ASR actually fails, and proper nouns are exactly what is on screen.
 *
 * Two constraints shape everything below:
 *
 *  1. **A noun list, never a sentence.** Whisper continues prose it is given.
 *     A prompt reading "The user is looking at Slack" can come back as part of
 *     the transcript; "Slack, #eng-platform, Anil" cannot say anything.
 *  2. **Nothing leaves the machine.** whisper.cpp is a local subprocess, so
 *     screen text in the prompt is no more exposed than screen text in the
 *     harvest that produced it. This is not a new disclosure; it must not
 *     become one by being reused somewhere with a network.
 */

/** Whisper's own ceiling is n_text_ctx/2 tokens; this stays well inside it. */
const MAX_CANDIDATES = 24

/**
 * Words that start a sentence and mean nothing as a hint. Without this the
 * list fills with "The, This, When" harvested from ordinary prose and the
 * genuine names get pushed past the character cap.
 */
const STOPWORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'a', 'an', 'and', 'or', 'but', 'if',
  'when', 'while', 'for', 'from', 'with', 'without', 'to', 'in', 'on', 'at',
  'by', 'of', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'you',
  'your', 'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her', 'i', 'me',
  'my', 'all', 'any', 'new', 'no', 'not', 'yes', 'ok', 'okay', 'today',
  'yesterday', 'tomorrow', 'now', 'then', 'here', 'there', 'what', 'who',
  'how', 'why', 'where', 'can', 'will', 'just', 'more', 'most', 'some'
])

/** `#eng-platform`, `@anil`, and the like — unambiguous, so they rank first. */
const HANDLE = /[#@][a-z0-9][a-z0-9._-]{1,30}/gi

/**
 * One capitalised word. Requires a leading capital and at least two characters
 * so initials and stray punctuation do not qualify.
 *
 * Single words rather than runs of them on purpose. Matching "Anil Turaga" as
 * a unit reads better but buys nothing — whisper biases on tokens, and
 * "Anil, Turaga" contributes the same two — while a run happily swallows
 * unrelated neighbours, which is how a Slack sidebar listing two people in a
 * row became the single name "Anil Turaga Sarah Chen". Worse, a repeated word
 * escaped deduplication by hiding inside a longer run, so the cap filled with
 * the same name three times. Tested in asr-prompt.test.ts.
 */
const PROPER_NOUN = /\b[A-Z][a-zA-Z0-9]{1,}\b/g

/**
 * Only the first slice of the window is scanned. The harvest can run to
 * thousands of characters and the useful names — title bar, sidebar, channel
 * header — are at the top in reading order. Scanning all of it would spend
 * milliseconds on the critical path to find nothing new.
 */
const SCAN_CHARS = 4_000

function addCandidate(into: Map<string, string>, raw: string): void {
  const value = raw.trim().replace(/\s+/g, ' ')
  if (value.length < 2 || value.length > 40) return
  const bare = value.replace(/^[#@]/, '').toLowerCase()
  if (STOPWORDS.has(bare)) return
  // Keyed case-insensitively so "Slack" and "slack" do not both take a slot,
  // first spelling wins because the earliest source is the most trustworthy.
  const key = value.toLowerCase()
  if (!into.has(key)) into.set(key, value)
}

/**
 * Build the `--prompt` string for one utterance, most trustworthy source
 * first: the app being spoken into, then its window title, then handles and
 * proper nouns from the window itself.
 *
 * Returns an empty string when there is nothing worth saying — an empty prompt
 * is omitted by the provider rather than passed as a flag with no value.
 */
export function buildAsrPrompt(
  snapshot: Pick<FocusSnapshot, 'app' | 'context'> | null,
  maxChars: number
): string {
  if (!snapshot) return ''
  const candidates = new Map<string, string>()

  if (snapshot.app?.name) addCandidate(candidates, snapshot.app.name)

  const context = snapshot.context
  if (context?.windowTitle) {
    for (const match of context.windowTitle.matchAll(HANDLE)) addCandidate(candidates, match[0])
    for (const match of context.windowTitle.matchAll(PROPER_NOUN)) addCandidate(candidates, match[0])
  }

  if (context?.blocks?.length) {
    let scanned = ''
    for (const block of context.blocks) {
      const text = block.text ?? ''
      if (!text) continue
      scanned += `${text}\n`
      if (scanned.length >= SCAN_CHARS) break
    }
    // Handles before proper nouns: a channel name is never a false positive,
    // a capitalised word often is.
    for (const match of scanned.matchAll(HANDLE)) addCandidate(candidates, match[0])
    for (const match of scanned.matchAll(PROPER_NOUN)) addCandidate(candidates, match[0])
  }

  const parts: string[] = []
  let length = 0
  for (const value of candidates.values()) {
    if (parts.length >= MAX_CANDIDATES) break
    const cost = parts.length === 0 ? value.length : value.length + 2
    if (length + cost > maxChars) break
    parts.push(value)
    length += cost
  }
  return parts.join(', ')
}
