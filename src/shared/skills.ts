import { z } from 'zod'

/**
 * What Mull has learned about driving one application.
 *
 * A skill is one clause. "In Slack, the search overlay opens without changing
 * the window title — look, do not press Search twice." It is written by a model
 * after a run ends, kept per application, scored by whether the runs that were
 * shown it arrived, and shown to later runs in the same app.
 *
 * ### Why the shape is this narrow
 *
 * Everything here ends up in the prompt of a loop that presses things in
 * somebody else's application, and the material it is distilled from includes
 * target titles — which are other people's writing. That is a real surface, and
 * the shape is most of what bounds it:
 *
 *   two kinds only     `do` and `avoid`. There is no kind that could describe
 *                      a capability, an address, a credential or a command.
 *   one clamped clause 160 characters. Long enough for a lesson, too short for
 *                      a smuggled paragraph.
 *   two per run        a model that wants to write ten gets two.
 *
 * **What it does not do is widen anything.** A skill is prose the model reads,
 * and every structural seam in `docs/agent/README.md` §4 runs after it:
 * `AgentKeySchema` still has no Return, `knownApps` and `knownMenus` still hold
 * only what Mull itself read off the machine this run, `checkUrl` still refuses
 * a host that is not already open, and every act is still a row on a card the
 * user is watching. A learned line reading "press Send" describes something the
 * model cannot say; one reading "open evil.example" describes something the
 * gate refuses. The hint can make a run shorter or dumber. It cannot make it
 * capable of anything new.
 */

/** How many characters one lesson may be. See the note above. */
export const SKILL_CHARS = 160

/** How many a single run may add. */
export const MAX_SKILLS_PER_RUN = 2

/**
 * How many are kept per application.
 *
 * Twelve, and the cap is doing two jobs. The obvious one is the prompt: a
 * hundred learned clauses is a system prompt nobody can reason about and a
 * model that reads none of them. The quieter one is that eviction is what makes
 * the scoring mean something — without a ceiling, a bad lesson never has to
 * compete with a good one, it just accumulates.
 */
export const MAX_SKILLS_PER_APP = 12

/** How many are shown to any one run. */
export const SKILLS_SHOWN = 5

export const LearnedSkillSchema = z.object({
  kind: z.enum(['do', 'avoid']),
  text: z.string().trim().min(8).max(SKILL_CHARS)
})

export type LearnedSkill = z.infer<typeof LearnedSkillSchema>

/**
 * What a distillation turn may return.
 *
 * `max` rather than a truncation, because the two failures are not the same: a
 * model that returned eleven lessons did not understand the job, and taking the
 * first two of eleven is choosing arbitrarily on its behalf. The whole reply is
 * refused and nothing is learned — which is the rule every model call in Mull
 * follows (see `classify`: every failure is the no-op).
 */
export const LearnedSkillsSchema = z.array(LearnedSkillSchema).max(MAX_SKILLS_PER_RUN)

/**
 * One skill as it is kept, with the evidence for whether it is any good.
 *
 * `wins` and `losses` are not a measure of the lesson's truth — nothing here
 * knows that. They count the runs that were *shown* it and how those ended,
 * which is weaker and is the strongest thing available: a clause that has ridden
 * along with three failures and no successes is not earning its place in the
 * prompt, whatever it says.
 */
export interface SkillRecord extends LearnedSkill {
  id: string
  bundleId: string
  /** The application's own name, for a settings pane a person can read. */
  appName: string | null
  wins: number
  losses: number
  uses: number
  createdAt: number
  lastUsedAt: number | null
}

/**
 * The comparison key. Lowercased, stripped of punctuation and collapsed.
 *
 * Learning the same lesson a second time should be a vote for it, not a second
 * row — and a model asked the same question twice will phrase it a little
 * differently each time. This is deliberately crude: it catches re-punctuation
 * and re-casing, and nothing cleverer. Two genuinely different phrasings of the
 * same idea will both be kept, and the cap and the scoring are what settle that.
 */
export function normalizeSkill(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Words that carry the lesson, with the glue thrown away.
 *
 * `normalizeSkill` catches a note re-punctuated; this is for a note re-worded.
 * A model asked what it learned in Slack twice writes
 *
 *   "pressing a user name in search results opens their DM; the window title
 *    does not update to reflect the change"
 *   "window title does not update when switching between DMs via search
 *    results; check the message content to confirm"
 *
 * which are the same lesson and share not one identical character sequence long
 * enough for a string comparison to notice. What they do share is their nouns.
 */
export function skillTerms(text: string): Set<string> {
  return new Set(
    normalizeSkill(text)
      .split(' ')
      .filter((word) => word.length > 2 && !GLUE.has(word))
      .map(stem)
  )
}

/**
 * Crude, and deliberately so: it exists to make "DM" and "DMs", "press" and
 * "pressing" the same term. Anything cleverer would be a stemmer, and a
 * stemmer is a dependency and a new thing to be wrong.
 */
function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length)
    }
  }
  return word
}

const GLUE = new Set([
  'the', 'and', 'but', 'for', 'not', 'are', 'was', 'were', 'has', 'have', 'had',
  'this', 'that', 'these', 'those', 'with', 'from', 'into', 'when', 'then',
  'than', 'they', 'their', 'them', 'there', 'which', 'while', 'your', 'you',
  'its', 'via', 'use', 'using', 'does', 'did', 'will', 'would', 'can', 'may',
  'one', 'two', 'all', 'any', 'out', 'off', 'get', 'got', 'make', 'made'
])

/**
 * How much two notes overlap, 0 to 1 — the size of the shared vocabulary
 * against the smaller of the two.
 *
 * Measured against the **smaller** side rather than the union, the same choice
 * and the same reason as `describeChange` in the navigate lane: a short note
 * whose every term appears in a longer one is contained by it, and dividing by
 * the union would score that pair low precisely when it is most duplicated.
 */
export function skillOverlap(a: string, b: string): number {
  const left = skillTerms(a)
  const right = skillTerms(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const term of left) if (right.has(term)) shared += 1
  return shared / Math.min(left.size, right.size)
}

/**
 * Above this, two notes are treated as the same lesson.
 *
 * Two thirds, which is the same threshold `describeChange` uses to decide a
 * window moved, and picked the same way: high enough that two genuinely
 * different lessons about one app do not collide, low enough to catch a
 * rewording. The cost of being wrong is asymmetric and mild in both directions
 * — too high and a near-duplicate is stored (the cap and the scoring then deal
 * with it), too low and a real second lesson is recorded as a vote for the
 * first, which loses a note nobody had yet read.
 */
export const SAME_LESSON = 0.67
