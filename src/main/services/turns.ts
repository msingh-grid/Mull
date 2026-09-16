/**
 * What the user has been doing, in the last few things they said.
 *
 * The classifier was built to answer one question about one sentence, shown one
 * window. That works until the second sentence:
 *
 *     "what did Anil say about the terms doc"   → navigate, and it answers
 *     "and what about Priya"                    → dictate, typed into Slack
 *
 * The second utterance is meaningless on its own. "And what about Priya" is not
 * a question about anything visible, not an instruction about any text, and
 * looks for all the world like someone speaking a message — which is exactly
 * what the classifier concluded, because the only evidence it had was the
 * sentence and the window. The thing that makes it answerable is the sentence
 * *before* it, and nothing was keeping that.
 *
 * So this keeps a few, and the classifier is shown them.
 *
 * ### What it deliberately is not
 *
 * **Not the journal.** The journal is the durable record of everything Mull did,
 * per row, and reading it back would mean paging through dictation rows, per-step
 * rows and rows from last Tuesday to find the two sentences that matter. This is
 * a handful of clauses about the last few minutes, in memory, gone when the app
 * quits — a different thing with a different lifetime.
 *
 * **Not a conversation history for the model to continue.** It is evidence for
 * one decision: *does this sentence refer to something we were just doing?* Which
 * is why the turns are stored as three short fields rather than as transcripts,
 * and why it expires.
 *
 * ### Bounds, and why each one is there
 *
 * Everything here leaves the Mac on the next instruction, so nothing is kept
 * because it might be useful.
 *
 *   MAX_TURNS    four. Enough for "and what about Priya", "and her reply",
 *                which is the shape this exists for. A longer tail is somebody
 *                else's conversation from twenty minutes ago.
 *   TTL_MS       fifteen minutes. A turn from this morning is not context, it is
 *                noise that makes an unrelated sentence look like a follow-up —
 *                and a wrong follow-up is worse than no memory at all, because
 *                it routes a plain message into an expedition.
 *   the clamps   a said and an outcome, both short. The outcome in particular is
 *                model output about somebody's private window, and there is no
 *                version of this feature that needs three paragraphs of it.
 */

/** One thing the user said, and what became of it. */
export interface RecentTurn {
  /** Their own words, clamped. */
  said: string
  /** Where it went: 'dictate' | 'edit' | 'compose' | 'ask' | 'navigate' | 'send'. */
  route: string
  /** Which app it happened in, so a follow-up in a different one reads as one. */
  app: string | null
  /** What came back — an answer, or why there wasn't one. Null while in flight. */
  outcome: string | null
  at: number
}

export const MAX_TURNS = 4
export const TTL_MS = 15 * 60_000
const SAID_CHARS = 160
const OUTCOME_CHARS = 240

export interface TurnMemoryOptions {
  now?: () => number
  max?: number
  ttlMs?: number
}

export class TurnMemory {
  private readonly turns: RecentTurn[] = []
  private readonly now: () => number
  private readonly max: number
  private readonly ttlMs: number

  constructor(options: TurnMemoryOptions = {}) {
    this.now = options.now ?? ((): number => Date.now())
    this.max = options.max ?? MAX_TURNS
    this.ttlMs = options.ttlMs ?? TTL_MS
  }

  /**
   * A new utterance has been routed. Opened now rather than on completion,
   * because a run can take half a minute and the user may well say the next
   * thing before it lands — and a memory that only records finished work would
   * be missing exactly the turn they are following up on.
   */
  open(turn: { said: string; route: string; app: string | null }): void {
    this.turns.push({
      said: clamp(turn.said, SAID_CHARS),
      route: turn.route,
      app: turn.app,
      outcome: null,
      at: this.now()
    })
    while (this.turns.length > this.max) this.turns.shift()
  }

  /**
   * What became of the turn that is still open.
   *
   * Applied to the most recent *unfinished* turn rather than simply the last
   * one: an utterance that arrives while a run is still going would otherwise
   * steal the run's outcome when it finally lands.
   */
  close(outcome: string | null): void {
    if (!outcome) return
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = this.turns[i]
      if (turn && turn.outcome === null) {
        turn.outcome = clamp(outcome, OUTCOME_CHARS)
        return
      }
    }
  }

  /** The turns still worth showing, oldest first. Expired ones are dropped. */
  recent(): RecentTurn[] {
    const cutoff = this.now() - this.ttlMs
    // Pruned on read rather than on a timer: nothing here needs to happen while
    // nobody is asking, and a timer would be a second thing to get wrong.
    while (this.turns.length > 0 && (this.turns[0] as RecentTurn).at < cutoff) this.turns.shift()
    return [...this.turns]
  }

  /**
   * Forget everything.
   *
   * There is no UI for this yet and there should be: "Mull, forget that" is a
   * thing people will want to say the first time it repeats something back.
   */
  clear(): void {
    this.turns.length = 0
  }
}

function clamp(text: string, limit: number): string {
  const tidy = text.replace(/\s+/gu, ' ').trim()
  return tidy.length <= limit ? tidy : `${tidy.slice(0, limit - 1)}…`
}
