import type { ScreenContext } from '@shared/context'
import type { UiTarget } from '@shared/sidecar-api'
import type { ClassifiedIntent, Engine } from '../engine/types'
import type { RecentTurn } from '../services/turns'
import { justSend, route, type Route, type RouteContext } from './router'

/**
 * IntentRouter — the one call the dictation loop makes to find out what the
 * user meant.
 *
 * **It is only ever reached on the instruct key.** ⌥Space does not come here
 * at all: those words are the message, the user said so by choosing that key,
 * and `DictationPipeline` types them without an engine in the loop. That is the
 * "dictation never waits" invariant, back in its unqualified form.
 *
 * So by the time anything below runs, the question "was that an instruction?"
 * has already been answered — by a key press, rather than by a table of verbs
 * that got it wrong for every phrasing nobody had listed ("summarize this
 * thread", "catch me up on this"). What is left is the narrower question of
 * *which* instruction, and that is what the model is for.
 *
 * The order, and the order is the design:
 *
 *   1. **A bare send**, answered locally and instantly. "Send the message" has
 *      nothing to write, so there is nothing to ask about — and the model has
 *      no way to request an irreversible act, which is the point. See
 *      `justSend`.
 *   2. **The model**, for everything else. Raced against a timeout, because a
 *      classifier that hangs must not hold the user's words hostage.
 *   3. **The rules**, when the model could not answer — signed out, offline,
 *      rate limited, timed out, or switched off in Settings. Mull still has to
 *      decide something, and refusing to act is not a decision.
 *   4. **The rules for a while**, once an engine has timed out five times
 *      running. Temporary, because a bad network minute should not outlive the
 *      bad network minute. See `DEMOTE_AFTER_TIMEOUTS` and `DEMOTION_MS`.
 *
 * Never throws. Every failure lands somewhere recoverable: a card the user
 * approves, or text one keystroke undoes.
 */

export type RoutedBy = 'fast-path' | 'model' | 'rules'

export interface RoutedIntent {
  route: Route
  by: RoutedBy
  /** How long the classifier took, when it ran at all. */
  classifyMs: number | null
  /** Why the rules answered instead of the model. Shown on the HUD as a chip. */
  fallbackReason: string | null
}

export interface IntentInput {
  transcript: string
  app: { bundleId: string; name: string } | null
  /** What is selected, or null. */
  selection: string | null
  /** The focused field's text when nothing is selected, or null. */
  fieldText: string | null
  fieldTruncated: boolean
  /** The window around the caret, when Mull was allowed to read it (M5a). */
  context?: ScreenContext | null
  /** What can be pressed there, read in the same breath. */
  targets?: UiTarget[] | null
}

export interface IntentRouterDeps {
  engine: Engine
  /** The utterance's trace, so classify's cost lands in the same story. */
  trace?: () => { step: (name: string, fields?: Record<string, unknown>) => void }
  /** False puts Mull on rules only — nothing about the field leaves the Mac. */
  useModel?: () => boolean
  /**
   * The last few things the user said, for the classifier to read follow-ups
   * against. Read per utterance, so it is always the conversation as it stands
   * rather than as it stood when the router was built.
   */
  recent?: () => RecentTurn[]
  /** Budget for the classifier. Past this, the rules answer. */
  timeoutMs?: number
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  now?: () => number
}

/**
 * How long to wait for the decision.
 *
 * This number has been wrong twice, in opposite directions, and both times the
 * cause was measuring the symptom instead of the disease.
 *
 * It was 4.5s, set in M4.1 when classification ran on every utterance that
 * might be an instruction — so the budget was really "how long may ordinary
 * dictation be held up". M5b took that job away (⌥Space dictates with no engine
 * in the loop; only Fn asks) and nobody moved the number. A real session log
 * then showed `fallbackReason: 'too-slow'` on fourteen consecutive utterances:
 * the classifier timed out twice, demoted itself for the session, and the local
 * rules made every decision after that. The model had never decided anything.
 *
 * The fix at that point was to raise it to 20s, because the lane measured p50
 * 5.4s / max 17.2s. That was treating the symptom. The real cause was that the
 * Agent SDK ran **extended thinking** on every turn, and nothing had ever told
 * it not to — a hundred tokens of deliberation in front of
 * `{"intent":"compose"}`, on a choice between four words:
 *
 *   thinking: harness default    p50 20086ms   min 3866ms   max 33438ms
 *   thinking: disabled           p50   954ms   min  845ms   max  1219ms
 *
 * See `thinking: { type: 'disabled' }` in `engine/agent.ts`. With that in
 * place, 8s is roughly six times the measured worst case — enough for a cold
 * session or a bad minute, and short enough that falling back is still a
 * decision rather than a hang.
 */
const DEFAULT_TIMEOUT_MS = 8_000

/**
 * How many timeouts before Mull stops asking this engine.
 *
 * A timeout is the worst of both worlds — the user waits the full budget and
 * then gets the rules answer that was available instantly — so giving up has to
 * remain possible. But it was giving up far too readily: two timeouts against a
 * budget shorter than the measured median meant it demoted itself within the
 * first two instructions of every session, permanently, and the rules made
 * every decision from then on.
 *
 * Five, now, and against a budget that actually fits. Five consecutive
 * timeouts at 20s each is a minute and a half of an engine answering nothing,
 * which is no longer "it might be slow today" — it is broken.
 */
const DEMOTE_AFTER_TIMEOUTS = 5

/**
 * And giving up is temporary.
 *
 * It used to be permanent: one bad stretch — a flaky connection, a rate limit,
 * a laptop waking up — and the classifier was off until the app relaunched,
 * with nothing on screen to say so. A network problem should not outlive the
 * network problem.
 */
const DEMOTION_MS = 5 * 60_000

export class IntentRouter {
  private readonly now: () => number
  private readonly log: NonNullable<IntentRouterDeps['log']>
  private readonly timeoutMs: number
  private consecutiveTimeouts = 0
  /** When this engine gave up, or null. Expires; see `DEMOTION_MS`. */
  private demotedAt: number | null = null

  constructor(private readonly deps: IntentRouterDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? ((): void => {})
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Give the classifier another chance — after a sign-in, a model change, or
   * any other swap. What was measured was this engine, not all engines.
   */
  reset(): void {
    this.consecutiveTimeouts = 0
    this.demotedAt = null
  }

  /** Is the engine still in the sin bin? Answers no once the wait is served. */
  private demoted(): boolean {
    if (this.demotedAt === null) return false
    if (this.now() - this.demotedAt < DEMOTION_MS) return true
    this.log('info', 'intent: giving the classifier another go')
    this.demotedAt = null
    this.consecutiveTimeouts = 0
    return false
  }

  async decide(input: IntentInput): Promise<RoutedIntent> {
    const transcript = input.transcript.trim()
    const context: RouteContext = {
      hasSelection: input.selection !== null && input.selection.length > 0,
      hasFieldText: input.fieldText !== null && input.fieldText.trim().length > 0,
      hasScreen: (input.context?.blocks.length ?? 0) > 0 || input.context?.image != null
    }

    // "Send the message." Answered here, from the words alone, before any of
    // the machinery below — there is nothing to write, so there is nothing to
    // ask a model about, and the one utterance whose whole point is immediacy
    // must not pay seconds for a classification. It is also, deliberately, a
    // route the model cannot produce: `ClassifiedIntent` has no `send` variant,
    // so nothing on screen can talk its way into a keystroke.
    if (justSend(transcript) && context.hasFieldText) {
      return { route: { kind: 'send' }, by: 'fast-path', classifyMs: null, fallbackReason: null }
    }

    const rules = (reason: string): RoutedIntent => ({
      route: route(transcript, context),
      by: 'rules',
      classifyMs: null,
      fallbackReason: reason
    })

    if (this.deps.useModel && !this.deps.useModel()) return rules('rules-only')

    // Asked and answered, five times over. Waiting again would buy nothing —
    // for a few minutes, after which it is worth finding out again.
    if (this.demoted()) return rules('too-slow')

    // Free: `ready()` reads remembered health, it does not probe.
    const state = await this.deps.engine.ready().catch(() => ({ kind: 'local-only' as const }))
    if (state.kind !== 'ready') return rules(state.kind)

    const startedAt = this.now()
    const trace = this.deps.trace?.()
    trace?.step('classify.ask', {
      model: 'haiku',
      screen: input.context?.chars ?? 0,
      targets: input.targets?.length ?? 0,
      field: input.fieldText?.length ?? 0,
      selection: input.selection?.length ?? 0,
      budgetMs: this.timeoutMs
    })
    let classified: ClassifiedIntent
    try {
      classified = await withTimeout(
        this.deps.engine.classify({
          transcript,
          app: input.app,
          selection: input.selection,
          fieldText: input.selection === null ? input.fieldText : null,
          fieldTruncated: input.fieldTruncated,
          // Text only, and stripped here rather than merely left unrendered.
          // The picture belongs to the turn that produces something the user
          // can watch arrive, not to the one they wait through blind — and a
          // rule that holds only because today's prompt builder happens not to
          // read the field is not a rule.
          context: withoutImage(input.context),
          targets: input.targets ?? null,
          recent: this.deps.recent?.() ?? null
        }),
        this.timeoutMs
      )
    } catch (err) {
      const reason = err instanceof TimeoutError ? 'timed-out' : 'engine-error'
      trace?.step('classify.failed', {
        reason,
        ms: this.now() - startedAt,
        strikes: reason === 'timed-out' ? this.consecutiveTimeouts + 1 : undefined
      })
      this.log('warn', `intent: the classifier did not answer (${reason})`, err)
      if (err instanceof TimeoutError) {
        this.consecutiveTimeouts += 1
        if (this.consecutiveTimeouts >= DEMOTE_AFTER_TIMEOUTS) {
          this.demotedAt = this.now()
          this.log(
            'warn',
            `intent: the classifier has timed out ${this.consecutiveTimeouts} times running — local rules for the next ${DEMOTION_MS / 60_000} minutes`
          )
        }
      }
      return rules(reason)
    }

    this.consecutiveTimeouts = 0
    const classifyMs = this.now() - startedAt
    trace?.step('classify.done', { kind: classified.kind, ms: classifyMs })
    return {
      route: toRoute(classified, transcript, context),
      by: 'model',
      classifyMs,
      fallbackReason: null
    }
  }
}

/**
 * The model's answer, reconciled with what is actually on screen.
 *
 * It is told what it is looking at, but a model that asks to edit "the
 * selection" when nothing is selected should not produce a card pointing at
 * nothing. The correction is cheap and one-directional: fall back to whichever
 * target exists.
 */
function toRoute(
  intent: ClassifiedIntent,
  transcript: string,
  context: RouteContext
): Route {
  if (intent.kind === 'dictate') return { kind: 'dictate', text: transcript }

  if (intent.kind === 'compose') {
    // A compose with nothing to compose from is a card proposing text invented
    // out of nothing. Dictating the words back is the honest answer.
    if (!context.hasScreen) return { kind: 'dictate', text: transcript }
    return { kind: 'compose', instruction: intent.instruction.trim() || transcript }
  }

  if (intent.kind === 'ask') {
    // Nothing on screen to answer from. Unlike a compose — which could at least
    // invent something plausible — an answer with no material is a card with
    // nothing on it, so the words go in as dictation instead.
    if (!context.hasScreen) return { kind: 'dictate', text: transcript }
    return { kind: 'ask', question: intent.question.trim() || transcript }
  }

  if (intent.kind === 'navigate') {
    // Nothing to navigate *from*: with no readable window there is no list of
    // things to press and no way to tell whether we arrived. Dictating the
    // words is the honest answer, as it is for a compose with no screen.
    if (!context.hasScreen) return { kind: 'dictate', text: transcript }
    return { kind: 'navigate', goal: usableGoal(intent.goal, transcript) }
  }

  const target =
    intent.target === 'selection' && !context.hasSelection
      ? 'document'
      : intent.target === 'document' && !context.hasFieldText
        ? 'selection'
        : intent.target

  return {
    kind: 'edit',
    // An empty instruction means the model gave us nothing to act on; the
    // user's own words are the better fallback than an empty prompt.
    instruction: intent.instruction.trim() || transcript,
    target
  }
}

/**
 * The goal, or the user's own words if the goal is too thin to act on.
 *
 * The navigator is shown this sentence and a list of what is on screen, and
 * nothing else — it never sees what the user actually said. So a goal of
 * "Anil Turaga" (which is what the classifier returned, before its prompt said
 * otherwise) leaves it to guess what to do with him, and the guess is a press
 * in somebody's application.
 *
 * The prompt is the fix and this is the backstop, in that order. It only has to
 * catch the one shape that is definitely useless: a bare noun phrase with no
 * verb in it. The transcript is a worse goal than a good one and a much better
 * goal than a name.
 */
export function usableGoal(goal: string, transcript: string): string {
  const trimmed = goal.trim()
  if (!trimmed) return transcript
  // Two words or fewer is a name or a channel, never an instruction.
  const words = trimmed.split(/\s+/u)
  if (words.length <= 2) return transcript
  // Longer, but still nothing being *asked for* — "the terms doc conversation".
  if (!/\b(open|read|find|check|look|see|go|search|scroll|show|tell|get)\b/iu.test(trimmed)) {
    return transcript
  }
  return trimmed
}

/** See the call site: the classifier is never shown the picture. */
function withoutImage(context: ScreenContext | null | undefined): ScreenContext | null {
  if (!context) return null
  if (!context.image) return context
  return { ...context, image: null, imageReason: 'not-sent-to-classifier' }
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`no answer in ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}
