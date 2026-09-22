import { cardFamily, type HudCard, type HudChip } from '@shared/hud'
import type { HudState } from '@shared/ipc'

/**
 * HudState → what the panel draws.
 *
 * All of the HUD's decisions live here as one pure function, so the components
 * are declarative and the rules are testable under plain node. The alternative
 * — conditionals scattered through JSX — makes "what does the HUD show when
 * the engine is streaming but the transcript is empty?" a question you answer
 * by squinting at markup.
 *
 * Spec: docs/DESIGN.md §6.1 (states), §6.2 (chips), §7 (interaction rules).
 */

export interface HudView {
  /** Class on the panel root; the stylesheet keys every state off this. */
  stateClass: string
  /** The accessible state (§8) — decoration is aria-hidden, this is not. */
  label: string
  /**
   * What Mull heard — and, while a card is waiting on the user, something they
   * can correct.
   *
   * `editable` is the one affordance on the panel with no button attached to
   * it: the line simply becomes a field when you click it. It is offered only
   * while a card is open, because that is the only moment there is both
   * something to fix and something still to decide — a transcript with nothing
   * pending is a receipt, and re-running from a receipt would re-do work the
   * user has already accepted. A plan that is mid-walk is excluded too: those
   * steps are being pressed in someone's window right now, and the words that
   * chose them are no longer a proposal.
   */
  transcript: { text: string; ghost: boolean; caret: boolean; editable: boolean }
  /**
   * The working line: what Mull is doing, and how long it has been doing it.
   *
   * THINKING alone can sit unchanged for twenty seconds — a cold session, a
   * long screen transcript, a classifier answering at its measured p50 — and an
   * unchanging word is indistinguishable from a hang. The user reported it as
   * one, correctly.
   *
   * The seconds appear only once there is something to wait for. A counter that
   * starts at 0s on every step turns a fast pipeline into a flickering
   * stopwatch, which reads as less confident rather than more.
   */
  stage: { text: string; seconds: number | null } | null
  /**
   * The thinking toggle: armed, and whether it is worth showing at all.
   *
   * Idle only. It is a decision about the sentence you are about to say, made
   * before you press the key — and once Mull is working, the toggle is either
   * too late to matter or describing the turn already in flight, both of which
   * are worse than not being there.
   */
  thinking: { on: boolean } | null
  chips: HudChip[]
  card: HudCard | null
  lastAction: {
    summary: string
    when: string
    undoable: boolean
    /** What it produced, when the lane produced something to read. */
    result: string | null
  } | null
  notice: string | null
  /**
   * Whether the panel needs mouse events. Main mirrors this into
   * `setIgnoreMouseEvents`, so an idle HUD never eats a click meant for the
   * app underneath it.
   */
  interactive: boolean
}

/**
 * The idle line, and the only place most people will ever learn there are two
 * keys. Worth the extra four words: a key nobody knows about is a feature that
 * does not exist.
 */
const GHOST_HINT = 'Hold ⌥Space to dictate · Fn to ask'

export function hudView(state: HudState, now = Date.now()): HudView {
  const card = state.card
  const label = labelFor(state)

  return {
    stateClass: stateClassFor(state),
    label,
    transcript: transcriptFor(state),
    stage: stageFor(state, now),
    // Kept visible while armed even outside idle, so nobody leaves it on by
    // accident and wonders why everything got slow.
    thinking: state.phase === 'idle' || state.thinking ? { on: state.thinking } : null,
    chips: state.chips,
    card,
    // The ghost row is an idle-only affordance: while Mull is working, the
    // thing it is working on is what deserves the space.
    lastAction:
      state.phase === 'idle' && state.lastAction
        ? {
            summary: state.lastAction.summary,
            when: relativeTime(state.lastAction.at, now),
            undoable: state.lastAction.undoable,
            // Clamped here rather than in CSS alone: a thousand-character
            // answer would still be a thousand characters crossing IPC and
            // sitting in the DOM behind an ellipsis.
            result: clampResult(state.lastAction.result ?? null)
          }
        : null,
    notice: state.notice,
    interactive: card !== null
  }
}

/** Past this, a wait is worth counting out loud. Below it, it is just latency. */
const COUNT_AFTER_MS = 1_500

function stageFor(state: HudState, now: number): HudView['stage'] {
  if (!state.stage) return null
  // A card on screen is its own answer to "what is happening"; the working
  // line under it would be describing the past.
  if (state.card) return null
  const elapsed = state.stageAt === null ? 0 : Math.max(0, now - state.stageAt)
  return {
    text: state.stage,
    seconds: elapsed >= COUNT_AFTER_MS ? Math.floor(elapsed / 1000) : null
  }
}

function stateClassFor(state: HudState): string {
  switch (state.phase) {
    case 'idle':
      return 'is-idle'
    case 'listening':
      return 'is-listening'
    // Insertion is a moment of work, not a distinct look: the panel holds the
    // thinking treatment (static waveform) and only the label changes.
    case 'thinking':
    case 'inserting':
      return 'is-thinking'
    case 'preview':
      return 'is-preview'
    case 'applied':
      return 'is-applied'
    case 'blocked':
      return 'is-blocked'
    case 'error':
      return 'is-error'
  }
}

/**
 * One slot, four kinds of thing — so each kind gets its own word and its own
 * colour, and the *form* says which before the word is read.
 *
 *   activity   LISTENING · THINKING · WRITING     what Mull is doing
 *   card       PREVIEW · PLAN · ANSWER            what is waiting on you
 *   fault      PAUSED (ochre) · ERROR (red)       what stopped
 *   outcome    APPLIED (green)                    what landed
 *
 * The card words name the three things Mull can do, because that is the one
 * thing the card's shape says and its title does not: PREVIEW changes your
 * document, PLAN presses things in another application, ANSWER changes nothing
 * at all. A plan and a diff both saying "preview" made a proposal about
 * behaviour indistinguishable from a proposal about text.
 */
function labelFor(state: HudState): string {
  const card = state.card
  // A card on screen is the fact; the phase is a claim about it. Deciding this
  // from `phase` alone meant every lane had to remember to announce one — and
  // the navigator did not, so a plan card sat under the word THINKING and
  // stayed there after the plan had finished and the window had been put back.
  if (card) {
    // Not a preview: a preview is a proposal about something that has not
    // happened, and a `wont` card is a report on something that has. That
    // covers an answer and a plan whose walk is over, which is why FOUND no
    // longer needs to exist — a finished plan *is* an answer, and now looks
    // like one.
    if (cardFamily(card) === 'wont') return 'ANSWER'
    return card.kind === 'plan' ? 'PLAN' : 'PREVIEW'
  }
  switch (state.phase) {
    case 'idle':
      return 'IDLE'
    case 'listening':
      return 'LISTENING'
    case 'thinking':
      return 'THINKING'
    // "Inserting" is the implementation's word for it. The product's metaphor
    // is an editor with a pencil, and a pencil writes.
    case 'inserting':
      return 'WRITING'
    case 'applied':
      return 'APPLIED'
    case 'blocked':
      return 'PAUSED'
    case 'error':
      return 'ERROR'
    // §6.1: THINKING while the card is still filling in. Labelling a
    // half-written diff PREVIEW invites the user to decide on evidence that
    // has not finished arriving.
    case 'preview':
      return 'THINKING'
  }
}

function transcriptFor(state: HudState): HudView['transcript'] {
  if (state.transcript) {
    return {
      text: state.transcript,
      ghost: false,
      caret: state.partial,
      editable: correctable(state)
    }
  }
  // Nothing said yet: the hint in idle, a bare caret while listening (the orb
  // and waveform are already saying "live" — a second hint would be noise).
  if (state.phase === 'idle') {
    return { text: GHOST_HINT, ghost: true, caret: false, editable: false }
  }
  return { text: '', ghost: false, caret: state.partial, editable: false }
}

/** Is there both something to fix and something still to decide? See above. */
function correctable(state: HudState): boolean {
  if (state.partial || !state.card) return false
  return !(state.card.kind === 'plan' && state.card.running === true)
}

/**
 * Ghost-row timestamps. Relative while it is still "the thing you just did",
 * clock time after that — the row exists to answer "can I still ⌥Z this?",
 * and "4m ago" answers it where "14:32" makes you do arithmetic.
 */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Bar heights and phase offsets for the listening waveform (§5). */
export const WAVE_BARS: Array<{ height: number; amp: number; delay: number }> = [
  { height: 5, amp: 2.6, delay: 0 },
  { height: 9, amp: 1.9, delay: 120 },
  { height: 6, amp: 3.0, delay: 240 },
  { height: 11, amp: 1.6, delay: 80 },
  { height: 7, amp: 2.3, delay: 300 },
  { height: 4, amp: 3.2, delay: 180 }
]

/**
 * The answer, shortened to what a glance can use.
 *
 * The panel shows two lines; this bounds what reaches it. The whole text is in
 * the journal, which is where someone who wants to read it properly goes.
 */
function clampResult(text: string | null): string | null {
  if (!text) return null
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (!flat) return null
  return flat.length <= RESULT_CHARS ? flat : `${flat.slice(0, RESULT_CHARS).trimEnd()}…`
}

const RESULT_CHARS = 220
