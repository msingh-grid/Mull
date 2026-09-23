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
 * So this keeps a few, and the lanes that can use them are shown them.
 *
 * ### What it deliberately is not
 *
 * **Not the journal.** The journal is the durable record of everything Mull did,
 * per row, and reading it back would mean paging through dictation rows, per-step
 * rows and rows from last Tuesday to find the two sentences that matter. This is
 * a handful of clauses about the last half hour, and it is written down as a
 * fixed-size block that is replaced rather than appended to — a different thing
 * with a different shape and a different lifetime.
 *
 * **Not a conversation history for the model to continue.** It is evidence for
 * two questions — *does this sentence refer to something we were just doing?*
 * and *what did that attempt actually do?* — which is why the turns are stored
 * as a few short fields rather than as transcripts, and why they expire.
 *
 * ### Bounds, and why each one is there
 *
 * Everything here leaves the Mac on the next instruction, so nothing is kept
 * because it might be useful.
 *
 *   MAX_TURNS    six. Four was the old number and it was set against one
 *                reader; with the agent, the navigator and the ask lane also
 *                reading, one in-flight turn and one interrupted one are
 *                enough to push a real follow-up chain off the end. Six keeps
 *                five visible in the worst case, which is the shape this
 *                exists for. A longer tail is somebody else's conversation.
 *   TTL_MS       thirty minutes. Fifteen was right while this lived and died
 *                with the process; now that `persistence` carries it across a
 *                relaunch, the TTL is the *only* thing standing between a
 *                follow-up and a turn from this morning — and a wrong
 *                follow-up is worse than no memory at all, because it routes a
 *                plain message into an expedition. Thirty is a coffee, not a
 *                morning.
 *   the clamps   short fields, all of them. `outcome` and `did` in particular
 *                are model output about somebody's private window, and there is
 *                no version of this feature that needs three paragraphs of it.
 *   MAX_RECENT_CHARS
 *                what the *rendered* block may cost. The clamps bound one turn;
 *                this bounds the whole block, on a prompt the user waits
 *                through with nothing on screen. See `compact`.
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
  /**
   * The expanded goal the classifier wrote, when there was one.
   *
   * `said` is what the user uttered and is often a pronoun with nothing
   * attached — "and what about Priya". The goal is the sentence that was
   * actually acted on, and it is the half a *later* run needs: the next
   * follow-up has to know the subject, and the subject only ever appears here.
   */
  goal?: string
  /**
   * What the run did, in its own verbs — `go to Slack · find “Priya” · look text`.
   *
   * For the lanes that act, rather than for the classifier. "It already tried
   * searching and the window did not move" is the difference between a second
   * attempt that varies the route and one that repeats it.
   */
  did?: string
  /** How a run ended: 'done' | 'stopped' | 'turns' | 'budget' | 'deadline' | 'error'. */
  ended?: string
}

export const MAX_TURNS = 6
export const TTL_MS = 30 * 60_000
/** The budget for the rendered block, whatever the individual clamps allow. */
export const MAX_RECENT_CHARS = 1_200
const SAID_CHARS = 160
const OUTCOME_CHARS = 240
const GOAL_CHARS = 160
const DID_CHARS = 160

/**
 * Where the turns are kept between launches, if anywhere.
 *
 * A port rather than a store, so every test in this file — and every one that
 * builds a `TurnMemory` incidentally — keeps working with no database at all.
 * Absent is exactly the behaviour this had before: in memory, gone on quit.
 */
export interface TurnPersistence {
  load(): RecentTurn[]
  save(turns: readonly RecentTurn[]): void
  clear(): void
}

export interface TurnMemoryOptions {
  now?: () => number
  max?: number
  ttlMs?: number
  persistence?: TurnPersistence
}

/** What a lane learned after the fact, filled in by `close`. */
export interface TurnOutcome {
  goal?: string | null
  did?: string | null
  ended?: string | null
}

export class TurnMemory {
  private readonly turns: RecentTurn[] = []
  private readonly now: () => number
  private readonly max: number
  private readonly ttlMs: number
  private readonly persistence: TurnPersistence | null

  constructor(options: TurnMemoryOptions = {}) {
    this.now = options.now ?? ((): number => Date.now())
    this.max = options.max ?? MAX_TURNS
    this.ttlMs = options.ttlMs ?? TTL_MS
    this.persistence = options.persistence ?? null
    // Trimmed on the way in as well as on the way out: a file written by a
    // build with a larger `max` must not make this one remember more than it
    // is willing to.
    const loaded = this.persistence?.load() ?? []
    this.turns.push(...loaded.slice(-this.max))
  }

  /**
   * A new utterance has been routed. Opened now rather than on completion,
   * because a run can take half a minute and the user may well say the next
   * thing before it lands — and a memory that only recorded finished work would
   * be missing exactly the turn they are following up on.
   */
  open(turn: { said: string; route: string; app: string | null; goal?: string | null }): void {
    this.turns.push({
      said: clamp(turn.said, SAID_CHARS),
      route: turn.route,
      app: turn.app,
      outcome: null,
      at: this.now(),
      ...(turn.goal ? { goal: clamp(turn.goal, GOAL_CHARS) } : {})
    })
    while (this.turns.length > this.max) this.turns.shift()
    this.flush()
  }

  /**
   * What became of the turn that is still open.
   *
   * Applied to the most recent *unfinished* turn rather than simply the last
   * one: an utterance that arrives while a run is still going would otherwise
   * steal the run's outcome when it finally lands.
   *
   * `extra` is how a lane that walked somewhere says what it did. It is
   * optional and applied independently of `outcome`, because the two arrive
   * from opposite ends: a run that ended with nothing to say still has a route
   * worth remembering, and a run that answered may have taken no steps at all.
   */
  close(outcome: string | null, extra?: TurnOutcome): void {
    if (!outcome && !extra) return
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = this.turns[i]
      if (turn && turn.outcome === null) {
        if (outcome) turn.outcome = clamp(outcome, OUTCOME_CHARS)
        if (extra?.goal) turn.goal = clamp(extra.goal, GOAL_CHARS)
        if (extra?.did) turn.did = clamp(extra.did, DID_CHARS)
        if (extra?.ended) turn.ended = extra.ended
        this.flush()
        return
      }
    }
  }

  /** The turns still worth showing, oldest first. Expired ones are dropped. */
  recent(): RecentTurn[] {
    const cutoff = this.now() - this.ttlMs
    // Pruned on read rather than on a timer: nothing here needs to happen while
    // nobody is asking, and a timer would be a second thing to get wrong.
    const before = this.turns.length
    while (this.turns.length > 0 && (this.turns[0] as RecentTurn).at < cutoff) this.turns.shift()
    if (this.turns.length !== before) this.flush()
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
    this.persistence?.clear()
  }

  /** Never allowed to throw: a memory that failed to save is still a memory. */
  private flush(): void {
    this.persistence?.save(this.turns)
  }
}

/**
 * The turns, trimmed to fit a prompt.
 *
 * The clamps bound one turn and this bounds the block, which are different
 * jobs: six turns that each fit comfortably still add up to something the
 * classifier — the one model call the user waits through with nothing on
 * screen — should not be paying for on every instruction.
 *
 * Newest first, because the newest turn is the one a follow-up is following.
 * Whole turns are kept while they fit and everything older is folded into a
 * single line, so the model is told that there *was* more rather than being
 * handed a truncated sentence and left to wonder.
 *
 * Deliberately arithmetic rather than a summarisation turn. A model call here
 * would be a second thing to wait for in front of the one call whose whole
 * virtue is being small, and it would put prior screen text through a model
 * twice on its way to a third — see the latency argument in
 * `pipeline/intent.ts`.
 */
export function compact(
  turns: readonly RecentTurn[],
  render: (turn: RecentTurn) => string,
  budget: number = MAX_RECENT_CHARS
): { lines: string[]; earlier: string | null } {
  const kept: string[] = []
  let spent = 0
  let cut = turns.length
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const line = render(turns[i] as RecentTurn)
    if (kept.length > 0 && spent + line.length > budget) break
    kept.unshift(line)
    spent += line.length + 1
    cut = i
  }
  const dropped = turns.slice(0, cut)
  return { lines: kept, earlier: dropped.length > 0 ? describeEarlier(dropped) : null }
}

/**
 * The one line that stands for everything that did not fit.
 *
 * Names the applications rather than the sentences, because what survives a
 * fold is the *shape* of what came before — "we were in Slack and Chrome for a
 * while" is the part that still helps decide whether this sentence continues
 * it. The sentences themselves are what was too expensive to keep.
 */
function describeEarlier(dropped: readonly RecentTurn[]): string {
  const apps = [...new Set(dropped.map((turn) => turn.app).filter((app): app is string => !!app))]
  const where = apps.length === 0 ? '' : ` in ${listOf(apps)}`
  const plural = dropped.length === 1 ? 'turn' : 'turns'
  return `earlier: ${dropped.length} more ${plural}${where}`
}

function listOf(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`
}

function clamp(text: string, limit: number): string {
  const tidy = text.replace(/\s+/gu, ' ').trim()
  return tidy.length <= limit ? tidy : `${tidy.slice(0, limit - 1)}…`
}

/**
 * What a run did, in one clause — `go to Slack · find “Priya” · look text`.
 *
 * The *route*, not the transcript of it. A run of twenty acts is mostly looks
 * and finds, and a later turn does not need them: what it needs is where this
 * went and roughly how, so that a second attempt at the same thing can vary
 * rather than repeat. So the tail is kept rather than the head — the last few
 * acts are the ones that got closest — and the count stands for the rest.
 *
 * Structural in its parameter rather than importing `PlanStep`, because two
 * lanes with two different step types both need this and neither should have
 * to learn about the other.
 */
export function describeSteps(
  steps: readonly { verb: string; object: string; state?: string }[],
  max = 4
): string | null {
  const done = steps.filter((step) => step.state !== 'running')
  if (done.length === 0) return null
  const tail = done.slice(-max)
  // A failed act is marked, because the whole value of this line to a later run
  // is knowing which parts of the route worked. "find, press, look" and "find,
  // press ✗, look" are the same list and opposite advice.
  const shown = tail
    .map((step) => `${step.verb} ${step.object}${step.state === 'failed' ? ' ✗' : ''}`.trim())
    .join(' · ')
  const hidden = done.length - tail.length
  return hidden > 0 ? `${hidden} more · ${shown}` : shown
}
