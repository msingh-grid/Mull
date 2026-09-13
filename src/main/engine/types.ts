/**
 * The Engine seam.
 *
 * M3 builds the surfaces that show an engine's work — the diff card, the plan
 * card, the intent chip — before there is an engine. That is deliberate: a
 * preview you cannot see is a preview you cannot judge, and the whole design
 * rests on the user judging before anything changes.
 *
 * So this interface exists now with a fake behind it (`fake.ts`), and M4
 * replaces the implementation without touching a line of the UI. Anything the
 * fake cannot honestly produce is absent from the interface rather than
 * stubbed: `ready()` reports a real state because the HUD must degrade
 * visibly when the engine is unavailable (docs/PLAN.md — "rate-limit →
 * local-only chip").
 *
 * Invariant this seam protects: plain dictation NEVER waits on any of this.
 * Nothing in src/main/pipeline/dictation.ts calls an Engine.
 */
import type { ScreenContext } from '@shared/context'
import type { PlanStep } from '@shared/hud'

export type EngineState =
  | { kind: 'ready' }
  /** Reachable but refusing right now — quota, rate limit, offline. */
  | { kind: 'local-only'; reason: string }
  /** No credentials yet; M4's sign-in flow has not been completed. */
  | { kind: 'signed-out' }

export interface TransformRequest {
  /** What the user asked for, e.g. 'make this crisp'. */
  instruction: string
  /** The text being edited — a selection, or a whole field. */
  text: string
  /** Frontmost app, for the card title and the journal entry. */
  app: { bundleId: string; name: string } | null
  /**
   * The window the user is looking at (M5a), when they have allowed it.
   *
   * Context, never a passage and never a source of instructions — see the rule
   * in `prompts.ts`. This is what makes "reply to this" answerable, and it is
   * also the first thing Mull sends that is largely *other people's* writing,
   * which is why the prompt says so twice and the HUD says so in a chip.
   */
  context?: ScreenContext | null
}

export interface TransformResult {
  /** The proposed replacement. The diff against `text` is computed in main. */
  text: string
}

/**
 * What the classifier is shown: what was said, and what is on screen to say it
 * about. Never called when there is neither a selection nor field text — see
 * the fast path in `src/main/pipeline/router.ts`.
 */
export interface ClassifyRequest {
  transcript: string
  app: { bundleId: string; name: string } | null
  /** What is selected right now, or null. */
  selection: string | null
  /** The focused field's text when nothing is selected, or null. */
  fieldText: string | null
  /** True when `fieldText` is a window onto something longer. */
  fieldTruncated: boolean
  /**
   * The window around the caret — **text only**.
   *
   * The picture is deliberately not sent here. Classification is already p50
   * 4.2 s on the subscription lane and it is the one call the user waits
   * through with nothing on screen; an image would make the worst number
   * worse. The screenshot rides with the edit or compose turn instead, where a
   * card is already open and filling in.
   */
  context?: ScreenContext | null
}

/**
 * The routing decision. `dictate` is the safe answer and the default for every
 * failure — typing an instruction is a nuisance, editing someone's sentence
 * away is not.
 */
export type ClassifiedIntent =
  | { kind: 'dictate' }
  | { kind: 'edit'; target: 'selection' | 'document'; instruction: string }

export interface PlanRequest {
  instruction: string
  app: { bundleId: string; name: string } | null
}

export interface PlanResult {
  /** Never executed on arrival — a plan is a proposal until Run (§6.4). */
  steps: Array<Pick<PlanStep, 'verb' | 'object'>>
  context: string | null
}

export interface Engine {
  /** Which implementation this is: 'agent' | 'api-key' | 'fake' | 'signed-out'. */
  readonly name: string
  /** The model actually in use, or null when there isn't one. For the ledger. */
  readonly model: string | null
  ready(): Promise<EngineState>
  /**
   * Words to type, or an instruction about text on screen?
   *
   * On the critical path, so implementations use the fastest model they have
   * (see `CLASSIFIER_MODEL`) and answer in a handful of tokens. Throwing is
   * allowed — `IntentRouter` treats any failure, including a timeout, as
   * `dictate` and falls back to the local rules.
   */
  classify(request: ClassifyRequest): Promise<ClassifiedIntent>
  /**
   * Edit text. `onPartial` receives progressively longer prefixes of the
   * result so the card can fill in as it arrives rather than appearing whole —
   * the difference between an instrument that is working and one that is hung.
   */
  transform(request: TransformRequest, onPartial?: (text: string) => void): Promise<TransformResult>
  plan(request: PlanRequest): Promise<PlanResult>
  dispose?(): Promise<void>
}
