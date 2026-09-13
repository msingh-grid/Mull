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

export interface DiffCard {
  kind: 'diff'
  /** Named in the card title: "EDIT PREVIEW · Mail". */
  app: string | null
  segments: DiffSegment[]
  /** Counted in main so the title and the body can never disagree. */
  changes: number
}

export type PlanStepState = 'pending' | 'running' | 'done' | 'failed'

export interface PlanStep {
  id: string
  verb: string
  object: string
  state: PlanStepState
}

export interface PlanCard {
  kind: 'plan'
  steps: PlanStep[]
  /** Verb context shown at the card's top right. */
  context: string | null
}

export type HudCard = DiffCard | PlanCard

/** What the user's ⏎ / esc do while a card is open. */
export type HudAction = 'apply' | 'cancel'
