import type { ScreenContext } from '@shared/context'
import type { ClassifiedIntent, Engine } from '../engine/types'
import { route, worthAsking, type Route, type RouteContext } from './router'

/**
 * IntentRouter — the one call the dictation loop makes to find out what the
 * user meant.
 *
 * It owns the order, and the order is the design:
 *
 *   1. **Fast path.** Nothing selected, empty field → `dictate`, synchronously.
 *      No engine, no network, no perceptible pause. This is the narrowed
 *      invariant from docs/PLAN.md, and it still covers the ordinary case of
 *      talking into an empty box.
 *   2. **Fast path again.** Text is present, but the words carry no instruction
 *      verb at all — "and I'll send the deck tonight". Also `dictate`, also
 *      synchronously. This second gate exists because of a measurement, not a
 *      preference: see `mightBeInstruction` in router.ts. Without it every
 *      utterance into a half-written email would pay seconds.
 *   3. **The model**, for what is left: text on screen *and* words that could
 *      plausibly be an instruction. Raced against a timeout, because a
 *      classifier that hangs must not hold the user's words hostage.
 *   4. **The rules**, when the model could not answer — signed out, offline,
 *      rate limited, timed out, or switched off in Settings. Mull still has to
 *      decide something, and refusing to type is not a decision.
 *   5. **The rules from then on**, once an engine has timed out twice. A
 *      timeout is the worst outcome available: the user waits the whole budget
 *      and then receives the answer the rules had instantly. Finding that out
 *      costs two utterances; continuing to pay for it would be a slower Mull
 *      that decides exactly the same things. See `DEMOTE_AFTER_TIMEOUTS`.
 *
 * Never throws. Every failure lands on `dictate`, which is recoverable with one
 * keystroke; the alternative failure — routing someone's sentence into a card —
 * is not.
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
}

export interface IntentRouterDeps {
  engine: Engine
  /** False puts Mull on rules only — nothing about the field leaves the Mac. */
  useModel?: () => boolean
  /** Budget for the classifier. Past this, the rules answer. */
  timeoutMs?: number
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  now?: () => number
}

/**
 * How long to wait for the decision.
 *
 * Measured, not guessed. A warm Agent SDK turn runs p50 4.2s / min 2.5s to
 * completion — the Claude Code harness, not the model — so a 1.2s budget would
 * have meant the classifier never once answered in time on the subscription
 * lane, and the whole feature would have been rules-with-extra-steps. The
 * API-key lane is much faster and simply finishes early.
 *
 * This much silence is only ever spent on an utterance that already looks like
 * it might be an instruction (gate 2 above). Past it, the rules answer.
 */
const DEFAULT_TIMEOUT_MS = 4_500

/**
 * How many timeouts before Mull stops asking this engine.
 *
 * Because a timeout is the worst of both worlds: the user waits the full
 * budget and then gets the rules answer that was available instantly. Paying
 * that once to find out is reasonable. Paying it on every utterance for the
 * rest of the session is not — it is a slower Mull that makes exactly the same
 * decisions.
 *
 * Measured on the subscription lane with window context attached: warm p50
 * 5.4s, max 17.2s, against a 4.5s budget. The classifications themselves were
 * right every time (6/6, compose and dictate and edit), so this is not the
 * model being wrong — it is the Claude Code harness being the wrong shape for
 * something on the critical path. An API key answers in a fraction of it.
 *
 * The pattern is `InsertionService`'s: try the good strategy, and when an
 * implementation proves it does not work here, stop trying it and remember.
 */
const DEMOTE_AFTER_TIMEOUTS = 2

export class IntentRouter {
  private readonly now: () => number
  private readonly log: NonNullable<IntentRouterDeps['log']>
  private readonly timeoutMs: number
  private consecutiveTimeouts = 0
  /** Set once this engine has proved it cannot answer in time. */
  private tooSlow = false

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
    this.tooSlow = false
  }

  async decide(input: IntentInput): Promise<RoutedIntent> {
    const transcript = input.transcript.trim()
    const context: RouteContext = {
      hasSelection: input.selection !== null && input.selection.length > 0,
      hasFieldText: input.fieldText !== null && input.fieldText.trim().length > 0,
      hasScreen: (input.context?.blocks.length ?? 0) > 0 || input.context?.image != null
    }

    const straightToTheCaret = (): RoutedIntent => ({
      route: { kind: 'dictate', text: transcript },
      by: 'fast-path',
      classifyMs: null,
      fallbackReason: null
    })

    // One gate now, where there used to be two. It answers: could these words,
    // against what is actually on screen, be asking for anything at all? No
    // means type them, synchronously, with no engine in the loop — and that is
    // still most of what anyone says. See `worthAsking` in router.ts for why
    // the invariant reads the way it does now.
    if (!worthAsking(transcript, context)) return straightToTheCaret()

    const rules = (reason: string): RoutedIntent => ({
      route: route(transcript, context),
      by: 'rules',
      classifyMs: null,
      fallbackReason: reason
    })

    if (this.deps.useModel && !this.deps.useModel()) return rules('rules-only')
    // Asked and answered, twice. Waiting again would buy nothing.
    if (this.tooSlow) return rules('too-slow')

    // Free: `ready()` reads remembered health, it does not probe.
    const state = await this.deps.engine.ready().catch(() => ({ kind: 'local-only' as const }))
    if (state.kind !== 'ready') return rules(state.kind)

    const startedAt = this.now()
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
          context: withoutImage(input.context)
        }),
        this.timeoutMs
      )
    } catch (err) {
      const reason = err instanceof TimeoutError ? 'timed-out' : 'engine-error'
      this.log('warn', `intent: the classifier did not answer (${reason})`, err)
      if (err instanceof TimeoutError) {
        this.consecutiveTimeouts += 1
        if (this.consecutiveTimeouts >= DEMOTE_AFTER_TIMEOUTS) {
          this.tooSlow = true
          this.log(
            'warn',
            'intent: this engine cannot classify inside the budget — using the local rules for the rest of the session'
          )
        }
      }
      return rules(reason)
    }

    this.consecutiveTimeouts = 0
    const classifyMs = this.now() - startedAt
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
