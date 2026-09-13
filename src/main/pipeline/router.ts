/**
 * The intent router — words to type, or an instruction to carry out?
 *
 * This is the single decision that makes Mull more than a dictation app, and
 * it is made by rules, locally, in microseconds. Two constraints shape every
 * line below.
 *
 * **The invariant** (docs/PLAN.md): plain dictation NEVER waits on an engine.
 * So the router is pure string work with no I/O, and `route()` answers the
 * common case — no selection — before it looks at the transcript at all.
 *
 * **The asymmetry.** Misrouting is not symmetric in cost:
 *
 *   dictation sent to the edit lane -> the user's words vanish into a card
 *                                      instead of landing where they were
 *                                      looking. Their sentence is *gone*.
 *   instruction sent to dictation   -> the instruction gets typed. Visible,
 *                                      obvious, and ⌥Z takes it back.
 *
 * The second is a shrug; the first is the app losing your writing. So every
 * ambiguity here resolves to `dictate`, and the fixture table in router.test.ts
 * is deliberately weighted toward sentences that must NOT be misread as
 * instructions — those are the cases that protect the invariant.
 *
 * The user-facing rule this adds up to is one sentence: **select some text,
 * then tell Mull what to do with it.** Everything else is typing.
 */

export interface RouteContext {
  /** Was there a live, non-empty selection when the user started speaking? */
  hasSelection: boolean
}

export type Route =
  | { kind: 'dictate'; text: string }
  | { kind: 'edit'; instruction: string }

/**
 * An instruction is short. A paragraph of speech is not an instruction, no
 * matter how it starts — "make it clear to the team that we're moving the
 * deadline because the vendor slipped" is something you say, not something you
 * ask for.
 */
const MAX_INSTRUCTION_WORDS = 14

/**
 * Openers people put in front of an instruction. Stripped before matching so
 * "could you please tighten this" is read the same as "tighten this".
 */
const PREAMBLE =
  /^(?:(?:hey|ok|okay)[,\s]+)?(?:mull[,\s]+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?|please\s+|let['’]?s\s+|just\s+|i(?:['’]?d)?\s+(?:want|like)\s+you\s+to\s+)*/u

/**
 * Verbs strong enough to stand alone. Nobody dictates "proofread" as prose; if
 * it heads an utterance while text is selected, it is an instruction.
 */
const TIER_A =
  /^(?:tighten|proofread|proof-?read|rephrase|reword|rewrite|reformat|condense|polish|tidy)\b/u

/**
 * Verbs that are instructions *only* when they point at the selection. These
 * are ordinary English words — "make", "fix", "turn" — and the deictic object
 * is what separates "make this crisp" from "make sure Priya signs off".
 */
const TIER_B =
  /^(?:make|fix|shorten|expand|lengthen|summari[sz]e|simplify|clarify|translate|turn|convert|correct|clean|soften|sharpen|trim|cut|punch|bullet)\b/u

/** What a Tier-B verb has to be pointing at. */
const DEICTIC =
  /\b(?:this|that|these|those|it|the selection|the text|the above|the whole thing|my (?:writing|wording|draft|note|email|message|reply)|the (?:paragraph|sentence|line|draft|note|email|message|reply|copy))\b/u

/**
 * Nouns that only ever describe writing, so they act as their own deictic:
 * "fix the grammar" needs no "this" to be about the selection.
 */
const TARGET_NOUN =
  /\b(?:grammar|spelling|punctuation|typos?|tone|wording|phrasing|capitali[sz]ation|formatting)\b/u

/**
 * Utterances that open with an instruction verb and are plainly content.
 *
 * Deliberately short. Most sentences you would think need listing here are
 * already handled by the Tier-B object test: "fix the meeting to 3pm", "turn
 * left at the lights" and "clean the kitchen before they arrive" all fail it,
 * because none of them points at any writing. Adding them anyway would grow a
 * list nobody can reason about and would start eating real instructions — the
 * first draft of this list blocked "clean up the wording".
 *
 * What is left is the residue: ordinary English that happens to contain a
 * deictic right where the router looks for one. Each line is a sentence
 * someone could say out loud and watch get mangled, so the list is meant to
 * grow — but only from real ones.
 */
const STOPLIST: RegExp[] = [
  /^make sure\b/u,
  /^make a (?:note|list|reservation|booking|start|point|call|copy|case|plan)\b/u,
  /^make time\b/u,
  /^make it (?:to|by|for|in|on|out)\b/u,
  /^turn (?:up|down|left|right|off|on|it (?:up|down|off|on))\b/u,
  /^fix it (?:later|tomorrow|then|next|after|when)\b/u,
  /^correct me if\b/u,
  /^cut (?:it|this|the meeting) short\b/u
]

/** How far past the verb a deictic object may sit and still count. */
const OBJECT_WINDOW = 4

/**
 * Does this transcript read as an instruction about some text?
 *
 * Exported separately from `route()` because the dictation path uses it for a
 * second purpose: when someone says "make this crisp" with nothing selected,
 * the words get typed (correctly — there is nothing to edit) and the HUD can
 * tell them why, which is the difference between a tool that seems broken and
 * one that teaches you how to hold it.
 */
export function looksLikeInstruction(transcript: string): boolean {
  const raw = transcript.trim()
  if (!raw) return false
  if (countWords(raw) > MAX_INSTRUCTION_WORDS) return false

  const body = raw.toLowerCase().replace(PREAMBLE, '').trimStart()
  if (!body) return false

  // "correct, that's what I meant" — a verb followed by a comma is an
  // interjection, not an imperative head.
  if (/^[\p{L}’']+\s*,/u.test(body)) return false

  if (STOPLIST.some((pattern) => pattern.test(body))) return false
  if (TIER_A.test(body)) return true
  if (!TIER_B.test(body)) return false

  // Tier B: the verb only counts if it is pointing at the writing.
  const object = wordsAfterVerb(body, OBJECT_WINDOW)
  return DEICTIC.test(object) || TARGET_NOUN.test(object)
}

/**
 * The routing decision. Order matters: the `hasSelection` gate is first so the
 * overwhelmingly common case — dictating into an empty field — returns without
 * the transcript ever being examined.
 */
export function route(transcript: string, context: RouteContext): Route {
  const text = transcript.trim()
  if (!context.hasSelection) return { kind: 'dictate', text }
  if (!looksLikeInstruction(text)) return { kind: 'dictate', text }
  return { kind: 'edit', instruction: text }
}

function countWords(text: string): number {
  const words = text.split(/\s+/u).filter(Boolean)
  return words.length
}

/** The `count` words following the leading verb, as one string to test. */
function wordsAfterVerb(body: string, count: number): string {
  const words = body.split(/\s+/u).filter(Boolean)
  return words.slice(1, 1 + count).join(' ')
}
