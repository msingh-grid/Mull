import type { ClassifiedIntent, Engine } from '../engine/types'
import { mightBeInstruction, nothingToEdit, route, type Route } from './router'

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

export class IntentRouter {
  private readonly now: () => number
  private readonly log: NonNullable<IntentRouterDeps['log']>
  private readonly timeoutMs: number

  constructor(private readonly deps: IntentRouterDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? ((): void => {})
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async decide(input: IntentInput): Promise<RoutedIntent> {
    const transcript = input.transcript.trim()
    const context = {
      hasSelection: input.selection !== null && input.selection.length > 0,
      hasFieldText: input.fieldText !== null && input.fieldText.trim().length > 0
    }

    const straightToTheCaret = (): RoutedIntent => ({
      route: { kind: 'dictate', text: transcript },
      by: 'fast-path',
      classifyMs: null,
      fallbackReason: null
    })

    if (nothingToEdit(context)) return straightToTheCaret()
    // There is text on screen, but these words could not be an instruction
    // about it. Typing them is the answer, and asking would cost seconds.
    if (!mightBeInstruction(transcript)) return straightToTheCaret()

    const rules = (reason: string): RoutedIntent => ({
      route: route(transcript, context),
      by: 'rules',
      classifyMs: null,
      fallbackReason: reason
    })

    if (this.deps.useModel && !this.deps.useModel()) return rules('rules-only')

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
          fieldTruncated: input.fieldTruncated
        }),
        this.timeoutMs
      )
    } catch (err) {
      const reason = err instanceof TimeoutError ? 'timed-out' : 'engine-error'
      this.log('warn', `intent: the classifier did not answer (${reason})`, err)
      return rules(reason)
    }

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
  context: { hasSelection: boolean; hasFieldText: boolean }
): Route {
  if (intent.kind === 'dictate') return { kind: 'dictate', text: transcript }

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
