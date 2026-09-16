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
import type { AgentGoal, AgentRunResult } from './agent-loop'
import type { RecentTurn } from '../services/turns'
import type { ScreenContext } from '@shared/context'
import type { NavAttempt, NavStep } from '@shared/nav'
import type { UiTarget } from '@shared/sidecar-api'

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
 * Write something new from what is on screen.
 *
 * No `text`, and that absence is the whole difference from `transform`: there
 * is nothing to rewrite and nothing to preserve. The material is `context`.
 */
export interface ComposeRequest {
  instruction: string
  app: { bundleId: string; name: string } | null
  context?: ScreenContext | null
}

/**
 * Say what was found, once navigation has arrived somewhere.
 *
 * The counterpart to `compose`, and deliberately not the same call. A compose
 * writes text *for* the user to send, in their voice; this writes text *to* the
 * user, about a window they are not looking at. Pointing the composer at "what
 * did Anil say about the terms doc" produces a message addressed to Anil.
 *
 * There is no `app` here because the answer names no application: by the time
 * it is read, the window has already been put back.
 */
export interface AnswerRequest {
  /** The goal the user approved on the card. */
  goal: string
  /** The window that was reached — the whole material for the answer. */
  context?: ScreenContext | null
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
  /**
   * What can be pressed in this window — labels only, read during the hold.
   *
   * Here to answer one question the classifier previously had to guess at: the
   * user named a place, and is that place *here* or *elsewhere*? Getting it
   * wrong produces the two worst outcomes in the routing table — walking around
   * someone's app to find a thing that was already on screen, or answering from
   * the visible window when the answer was three clicks away.
   *
   * Labels, never authority. The indices are meaningless on this turn: the
   * classifier cannot press anything, and `ClassifiedIntent` has no variant
   * that could. See the note below it on why that absence is structural rather
   * than a matter of instruction.
   */
  targets?: UiTarget[] | null
  /**
   * The last few things the user said, and what came of each.
   *
   * The evidence for one question the classifier previously had no way to
   * answer: *is this sentence a follow-up?* "And what about Priya" is not a
   * question about anything on screen and not an instruction about any text, so
   * every rule here read it as a message to type — which is the right reading of
   * that sentence alone and the wrong one of that sentence after "what did Anil
   * say about the terms doc".
   *
   * Bounded and short-lived by construction; see `services/turns.ts` for what is
   * kept and why each bound is where it is.
   */
  recent?: RecentTurn[] | null
}

/**
 * The routing decision. `dictate` is the safe answer and the default for every
 * failure — typing an instruction is a nuisance, editing someone's sentence
 * away is not.
 *
 * **Note what is absent: there is no `send`.** Whether Mull offers to send a
 * message is decided in `pipeline/router.ts` from the user's own transcript and
 * nowhere else. The model is shown other people's writing on every context-
 * carrying turn, so anything it can set is something a message on screen can
 * try to talk it into. Classification is a claim about what the user said;
 * pressing Return in someone's window is not, and the seam between them is this
 * missing field.
 */
export type ClassifiedIntent =
  | { kind: 'dictate' }
  | { kind: 'edit'; target: 'selection' | 'document'; instruction: string }
  /**
   * Write something new from what is on screen — a reply, a summary, an answer.
   *
   * The third route, and structurally different from the other two: there is no
   * `before`. An edit rewrites text that exists; a compose produces text that
   * does not, out of the conversation the user is looking at. It lands at the
   * caret.
   */
  | { kind: 'compose'; instruction: string }
  /**
   * Tell me something about what is on screen. Write nothing.
   *
   * The sibling of `compose`, and the distinction is the whole reason it
   * exists: both read the window and produce sentences, but one produces text
   * the user wants *in their document* and the other produces text they want to
   * *read*. "Summarize the tasks I need to finish" was routed to `compose` for
   * as long as this was one route, which put an **Apply** button under a
   * summary of somebody's own notes, offering to paste it back into them — one
   * reflexive ⏎ from doing it, since ⏎ means Apply on every other card.
   *
   * So the two routes end differently by construction: a compose ends in a diff
   * card with Apply, an ask ends in an `AnswerCard`, which has no target, no
   * commit and nothing to write with.
   */
  | { kind: 'ask'; question: string }
  /**
   * Go and look somewhere else in this application, then come back.
   *
   * The fourth route, and the only one that moves before it answers. It exists
   * because "what did Priya say about the terms doc" is unanswerable from a
   * window Priya is not in, and the honest options were to say so or to go and
   * read it — and saying so is what Mull did before this, badly.
   *
   * **It does not weaken the missing `send` field above.** Navigation cannot
   * send: `@shared/nav` has no verb for it, `navKey` cannot name ⏎, and a plan
   * that navigates never carries a commit. What the classifier is choosing here
   * is where to look, not what to do.
   */
  | { kind: 'navigate'; goal: string }

/**
 * One turn of navigation: here is where we are, what do we do next?
 *
 * **One step per call, and that is the design.** A plan of three steps decided
 * up front is a plan written against a window that no longer exists by step
 * two — press Slack's Search and the entire target list is replaced. So the
 * model looks, acts once, and looks again, and the card fills in as it goes.
 *
 * What the user approves is therefore the *goal and the budget*, not each
 * press. A confirmation per click would be a dialog box nobody reads by the
 * fourth one, and it would not be more informative: the steps are on the card
 * as they happen, and Escape stops it between any two.
 */
export interface NavigateRequest {
  /** The user's own words. Never rewritten, and journalled with every step. */
  goal: string
  app: { bundleId: string; name: string } | null
  /** What the window says right now — text, and the picture when allowed. */
  context?: ScreenContext | null
  /**
   * What can be pressed right now, numbered. The model answers with an index
   * into this, never with a name. See `@shared/nav`.
   */
  targets: UiTarget[]
  /**
   * Why the scan stopped. `'targets'` means the list is a prefix of the window
   * rather than the whole of it, which the model must be told — otherwise "the
   * row I want is not here" is a conclusion drawn from a list that stopped.
   */
  stoppedBy?: string
  /** Every step so far and how it went, so the model can stop repeating one. */
  history: NavAttempt[]
  /** How many more steps are allowed. Zero means: answer `done`. */
  stepsLeft: number
  /**
   * How the expedition is going: steps taken, and how many of them actually
   * changed the window. Four presses that moved nothing is the signal that a
   * route is not working, and it is invisible from `stepsLeft` alone.
   */
  progress?: { taken: number; moved: number }
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
   * On the critical path, so implementations answer in a handful of tokens
   * from one shared model (see `CLASSIFIER_MODEL`) rather than the edit model.
   * Throwing is allowed — `IntentRouter` treats any failure, including a
   * timeout, as `dictate` and falls back to the local rules.
   */
  classify(request: ClassifyRequest): Promise<ClassifiedIntent>
  /**
   * Edit text. `onPartial` receives progressively longer prefixes of the
   * result so the card can fill in as it arrives rather than appearing whole —
   * the difference between an instrument that is working and one that is hung.
   */
  transform(request: TransformRequest, onPartial?: (text: string) => void): Promise<TransformResult>
  /**
   * Draft something new. Same streaming contract as `transform` — the card
   * fills in as it arrives — but the result replaces nothing, so what the user
   * sees is all insertion.
   */
  compose(request: ComposeRequest, onPartial?: (text: string) => void): Promise<TransformResult>
  /**
   * Where next? One step, chosen from an enumerated list of what can be
   * pressed — see `NavigateRequest`.
   *
   * Implementations MUST validate against `NavStepSchema` and throw on
   * anything else. A malformed step ends the plan; it is never repaired,
   * because improvising in someone else's window is not a recovery strategy.
   */
  navigate(request: NavigateRequest): Promise<NavStep>
  /**
   * Report what the window says, once the navigator has arrived.
   *
   * Streams like `transform` and `compose`, for the same reason and to the same
   * effect: the card fills in as the sentences arrive, which is the difference
   * between an instrument that is working and one that is hung. Unlike those
   * two, the result is never inserted anywhere — it is read in the panel and
   * dismissed, which is why `AnswerRequest` has no app and no target.
   */
  answer(request: AnswerRequest, onPartial?: (text: string) => void): Promise<TransformResult>
  /**
   * Run a goal to completion, with the model calling tools rather than
   * answering a questionnaire — see `engine/agent-loop.ts`.
   *
   * **Optional, and the only optional capability on this interface.** `navigate`
   * above is a single model call and every engine can make one; a tool loop is
   * a property of the harness, and only the Agent SDK lane has one. An engine
   * without this is not broken — `index.ts` gives its utterances to
   * `NavigateLane` instead, which is what every engine did until now.
   *
   * Widening this to the API-key lane means writing the same loop over the
   * Messages API, which is ordinary work and simply has not been done yet.
   */
  runAgent?(request: AgentGoal): Promise<AgentRunResult>
  dispose?(): Promise<void>
}
