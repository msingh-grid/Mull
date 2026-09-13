import type { HudCard, HudChip } from '@shared/hud'
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
  transcript: { text: string; ghost: boolean; caret: boolean }
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
  chips: HudChip[]
  card: HudCard | null
  lastAction: { summary: string; when: string; undoable: boolean } | null
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
    chips: state.chips,
    card,
    // The ghost row is an idle-only affordance: while Mull is working, the
    // thing it is working on is what deserves the space.
    lastAction:
      state.phase === 'idle' && state.lastAction
        ? {
            summary: state.lastAction.summary,
            when: relativeTime(state.lastAction.at, now),
            undoable: state.lastAction.undoable
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

function labelFor(state: HudState): string {
  switch (state.phase) {
    case 'idle':
      return 'IDLE'
    case 'listening':
      return 'LISTENING'
    case 'thinking':
      return 'THINKING'
    case 'inserting':
      return 'INSERTING'
    case 'applied':
      return 'APPLIED'
    case 'blocked':
      return 'PAUSED'
    case 'error':
      return 'ERROR'
    // §6.1: THINKING while the card is still filling in, PREVIEW once it can
    // actually be judged. Labelling a half-written diff PREVIEW invites the
    // user to decide on evidence that has not finished arriving.
    case 'preview':
      return state.card ? 'PREVIEW' : 'THINKING'
  }
}

function transcriptFor(state: HudState): HudView['transcript'] {
  if (state.transcript) {
    return { text: state.transcript, ghost: false, caret: state.partial }
  }
  // Nothing said yet: the hint in idle, a bare caret while listening (the orb
  // and waveform are already saying "live" — a second hint would be noise).
  if (state.phase === 'idle') return { text: GHOST_HINT, ghost: true, caret: false }
  return { text: '', ghost: false, caret: state.partial }
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
