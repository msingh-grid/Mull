import type { HudState } from '@shared/ipc'

/**
 * The pet, and when the panel is worth its space (docs/DESIGN.md §6.1a).
 *
 * The HUD used to be on screen the whole time Mull was running, and almost all
 * of that time it was idle — a hollow orb, a static waveform and a hint,
 * occupying 480px of somebody else's window to say that nothing was happening.
 * So the resting form is a small cat and the panel is raised only when there is
 * something to raise it for.
 *
 * Pure, like `hud/view-model.ts` and for the same reason: every rule about when
 * the panel appears is one function you can read, and the component below it
 * decides nothing. What a mood *looks* like is not here — that is hud.css,
 * which owns the spritesheet's geometry the way it already owns the orb's.
 */

export type PetMood =
  /** Idle. */
  | 'rest'
  /** Idle, and left alone long enough to doze. */
  | 'asleep'
  | 'listening'
  /** Thinking, inserting, or filling in a card. */
  | 'working'
  /** A card is open and Mull is owed an answer. */
  | 'waiting'
  /** Something landed. */
  | 'done'
  /** Blocked, errored, or carrying a notice. */
  | 'trouble'

export interface PetUi {
  /**
   * The user's own answer about the panel, which outranks the rules.
   *
   * `null` means they have not said — follow the rules. A click sets it to the
   * opposite of whatever is currently showing, and it is cleared again when the
   * next action lands, so the linger below can happen once per action rather
   * than once per session.
   */
  wanted: boolean | null
  /** When the HUD last changed. What the doze is measured from. */
  quietSince: number
}

export interface PetView {
  /** Is the panel drawn at all? */
  panelOpen: boolean
  mood: PetMood
  /** Accessible name — the pet is the only control on the stage. */
  label: string
  /**
   * Whether a click can change anything.
   *
   * False while the panel is required: a card waiting on ⏎ is not something the
   * pet may fold away, and a button that says "hide" and does not hide is worse
   * than a button that says nothing.
   */
  pinnable: boolean
}

/**
 * How long the panel stays up after an action, once the phase is idle again.
 *
 * `applied` itself lasts 1 400ms (pipeline/dictation.ts). Without this, the
 * last-action row and its `⌥Z undo` hint would appear and vanish inside a
 * second and a half — the panel would be at its least useful in exactly the
 * moment it has something to report.
 */
export const PANEL_LINGER_MS = 4_000

/** Idle and untouched for this long, and the cat dozes off. */
export const SLEEP_AFTER_MS = 90_000

/** How far a pointer may travel and still count as a click, not a drag. */
export const TAP_SLOP_PX = 4

export interface Point {
  x: number
  y: number
}

export function petView(state: HudState, ui: PetUi, now = Date.now()): PetView {
  const required = demandsPanel(state)
  const mood = moodFor(state, ui, now)
  const panelOpen = required || (ui.wanted ?? lingering(state, now))
  return {
    panelOpen,
    mood,
    pinnable: !required,
    label: labelFor(mood, required, panelOpen)
  }
}

/**
 * When the view would change on its own, in ms from now — or null if it is
 * stable until main says otherwise.
 *
 * Here rather than in the component because it is the same rule as `petView`
 * read backwards, and the two drifting apart is how you get a panel that never
 * closes or a cat that never sleeps.
 */
export function petWakes(state: HudState, ui: PetUi, now = Date.now()): number | null {
  const waits: number[] = []
  const linger = lingerEndsAt(state)
  // Only worth waking for if it is what is holding the panel open.
  if (linger !== null && linger > now && ui.wanted === null && !demandsPanel(state)) {
    waits.push(linger - now)
  }
  if (state.phase === 'idle' && !state.card && !state.notice) {
    const sleepsAt = ui.quietSince + SLEEP_AFTER_MS
    if (sleepsAt > now) waits.push(sleepsAt - now)
  }
  return waits.length > 0 ? Math.min(...waits) : null
}

/** Did the pointer stay still enough for this to have been a click? */
export function isTap(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) <= TAP_SLOP_PX
}

/**
 * Is the panel required, whatever anyone clicked?
 *
 * Anything that is not plain idle. A diff card that needed a click to be
 * discovered is a card nobody answers, and a notice nobody sees is a failure
 * reported to no one — so the pet is allowed to be the whole interface only
 * when there is genuinely nothing to say.
 */
function demandsPanel(state: HudState): boolean {
  return state.card !== null || state.notice !== null || state.phase !== 'idle'
}

function lingerEndsAt(state: HudState): number | null {
  if (state.phase !== 'idle' || !state.lastAction) return null
  return state.lastAction.at + PANEL_LINGER_MS
}

function lingering(state: HudState, now: number): boolean {
  const ends = lingerEndsAt(state)
  return ends !== null && now < ends
}

function moodFor(state: HudState, ui: PetUi, now: number): PetMood {
  // A card outranks the phase, exactly as it does in `hudView`'s label: the
  // card is the fact, the phase is a claim about it.
  if (state.card) return 'waiting'
  if (state.notice) return 'trouble'
  switch (state.phase) {
    case 'listening':
      return 'listening'
    case 'thinking':
    case 'inserting':
    case 'preview':
      return 'working'
    case 'applied':
      return 'done'
    case 'blocked':
    case 'error':
      return 'trouble'
    case 'idle':
      return now - ui.quietSince >= SLEEP_AFTER_MS ? 'asleep' : 'rest'
  }
}

const MOOD_SENTENCE: Record<PetMood, string> = {
  rest: 'Mull is idle',
  asleep: 'Mull is idle',
  listening: 'Mull is listening',
  working: 'Mull is working',
  waiting: 'Mull is waiting for an answer',
  done: 'Mull just finished',
  trouble: 'Mull hit a problem'
}

/**
 * What a screen reader is told.
 *
 * The click hint is added only when a click would do something, because the
 * pet is also the only visible thing during a phase where it is inert.
 */
function labelFor(mood: PetMood, required: boolean, panelOpen: boolean): string {
  const sentence = MOOD_SENTENCE[mood]
  if (required) return sentence
  return `${sentence} — click to ${panelOpen ? 'hide' : 'open'} the panel`
}
