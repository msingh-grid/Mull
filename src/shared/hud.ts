/**
 * What the HUD renders, as data.
 *
 * The renderer computes nothing — no diffing, no classification, no deciding
 * which chips to show. Main sends a finished picture and the panel draws it.
 * Two reasons: the interesting logic stays unit-testable under plain node
 * (docs/DESIGN.md is a spec, not a test harness), and a renderer that cannot
 * derive state cannot drift from what actually happened.
 *
 * Component specs: docs/DESIGN.md §6.2 (chips), §6.3 (diff card), §6.4 (plan).
 */

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * One run of text in a diff. `same` is context, `del` is red pencil, `ins` is
 * writing ink — the three marks the whole design metaphor rests on.
 */
export interface DiffSegment {
  kind: 'same' | 'del' | 'ins'
  text: string
}

// ---------------------------------------------------------------------------
// Chips — §6.2. A chip announces a classification *before* the action.
// ---------------------------------------------------------------------------

export type ChipKind = 'intent' | 'cmd' | 'mem' | 'dict' | 'warn'

export interface HudChip {
  kind: ChipKind
  label: string
  /** Stable key for React, and the citation id for `mem` chips. */
  id: string
  /** Key hint printed inside the chip, e.g. '⌥Z'. */
  hint?: string
}

// ---------------------------------------------------------------------------
// Cards — a proposal until the user commits (§7.5). Never auto-applied.
// ---------------------------------------------------------------------------

/**
 * A second, heavier commit offered beside Apply.
 *
 * Present only when Mull can both write the text *and* do the thing the user
 * asked for next — today that is "and send it", in an app whose send chord is
 * on the table in `services/send-table.ts`.
 *
 * It carries its own `warning` because it is the first thing in Mull that ⌥Z
 * cannot take back, and §7.2 says an action states its undo path in the same
 * breath as itself. Here the undo path is: there isn't one.
 */
export interface CardCommit {
  /** Button text, e.g. 'Apply & send'. */
  label: string
  /** The chord printed inside it, e.g. '⌘⏎'. */
  hint: string
  /** One clause under the actions, e.g. 'sending can’t be undone'. */
  warning: string
}

export interface DiffCard {
  kind: 'diff'
  /** Named in the card title: "EDIT PREVIEW · Mail". */
  app: string | null
  segments: DiffSegment[]
  /** Counted in main so the title and the body can never disagree. */
  changes: number
  /** Absent on almost every card. See `CardCommit`. */
  commit?: CardCommit | null
}

export type PlanStepState = 'pending' | 'running' | 'done' | 'failed'

export interface PlanStep {
  id: string
  verb: string
  object: string
  state: PlanStepState
}

/**
 * A plan, and — since M5a Stage 5 — a plan that is still being written.
 *
 * The steps arrive one at a time rather than all at once, because a user
 * interface is a moving target: press Slack's Search and the list of things
 * that can be pressed is entirely replaced, so a three-step plan decided
 * against the first window has a second step that refers to nothing.
 *
 * That changes what Run means. It approves the **goal and the budget** — "go
 * look for this, in this app, read-only, at most six steps" — and the steps
 * then appear as they happen. A confirmation per press would be a dialog box
 * nobody reads by the fourth one, and would say less than watching it.
 */
export interface PlanCard {
  kind: 'plan'
  steps: PlanStep[]
  /** Verb context shown at the card's top right. */
  context: string | null
  /** The user's own words. Absent on the tray demo, present on a real plan. */
  goal?: string | null
  /** Named in the title, so it is obvious whose window is being driven. */
  app?: string | null
  /** The step budget, printed beside the app. `null` on a plan with no loop. */
  limit?: number | null
  /**
   * One clause under the actions, in the place `CardCommit.warning` occupies on
   * a diff card — and saying the opposite thing, because here the reassurance
   * is what is true: nothing is written and nothing is sent.
   */
  note?: string | null
  /** True once the loop is running; Run becomes unavailable and esc stops it. */
  running?: boolean
}

/**
 * Send what is already in the box — the one card that proposes no new text.
 *
 * "Send the message", said over a composer the user has already filled. There
 * is nothing to preview in the usual sense, so what the card shows is *the
 * thing that is about to go*: Mull reads the composer and prints it back. That
 * read is the whole safety story here. Every other card can say "here is what I
 * would write"; this one can only say "here is what you wrote, and this key
 * sends it".
 *
 * It has no Apply. There is nothing to apply, and ⏎ therefore does nothing on
 * this card — which is also why it must stay claimed: Mull holds Return
 * globally while a card is open, and letting it through to Slack would send the
 * message the card is still asking about.
 */
export interface SendCard {
  kind: 'send'
  app: string | null
  /** The composer's current contents, read just now. Never rewritten. */
  text: string
  commit: CardCommit
}

export type HudCard = DiffCard | PlanCard | SendCard

/**
 * What the user's ⏎ / ⌘⏎ / esc do while a card is open.
 *
 * `apply-send` is offered only when the card carries a `commit`, and it is
 * always a separate keystroke from `apply` — never a mode, never a default.
 * Someone who presses ⏎ out of habit has applied an edit, which is what ⏎ has
 * always done here; they have not sent a message.
 */
export type HudAction = 'apply' | 'apply-send' | 'cancel'
