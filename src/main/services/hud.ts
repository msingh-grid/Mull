import { IDLE_HUD_STATE, type HudAction, type HudState } from '@shared/ipc'
import type { HudCard } from '@shared/hud'
import type { ChordScope } from './chords'

/**
 * HudController — the one place that decides what the HUD is showing.
 *
 * Two independent sources want to put things on the panel: the dictation
 * pipeline (which owns phase, transcript and the last-action ghost) and
 * whatever is proposing a card (M3: the FakeEngine demo; M4: the real engine).
 * Merging them here rather than letting both write the same object is what
 * stops the classic bug where a finished utterance clears a card that is still
 * waiting on the user.
 *
 * It also owns the two side effects a card has on the window itself:
 *   - the panel only takes mouse events while a card is open, so an idle HUD
 *     never eats a click meant for the app underneath (docs/DESIGN.md §7.1);
 *   - ⏎ and esc are claimed globally only for exactly as long as the card is
 *     open (see chords.ts).
 *
 * No `electron` import — the window is a port, so this is testable.
 */

export interface HudPort {
  send(state: HudState): void
  /** Mirrors into `setIgnoreMouseEvents(!interactive, { forward: true })`. */
  setInteractive(interactive: boolean): void
}

export interface HudControllerOptions {
  port: HudPort
  chords: ChordScope
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export class HudController {
  private base: HudState = { ...IDLE_HUD_STATE }
  private card: HudCard | null = null
  private onAction: ((action: HudAction) => void) | null = null
  private releaseChords: (() => void) | null = null
  private interactive = false

  constructor(private readonly options: HudControllerOptions) {}

  getState(): HudState {
    return this.merged()
  }

  /** Everything the dictation pipeline reports. */
  setPipelineState(state: HudState): void {
    this.base = state
    this.emit()
  }

  /**
   * Open a proposal. `onAction` receives the user's answer from any source —
   * the buttons, the global chords, or a cancel forced by something else.
   */
  openCard(card: HudCard, onAction: (action: HudAction) => void): void {
    this.card = card
    this.onAction = onAction
    // ⌘⏎ is claimed only for a card that actually offers a second commit —
    // there is no point holding someone's shortcut for a button they cannot
    // see. The card is the single source of truth for both, so the button and
    // the chord can never disagree about whether the commit exists.
    this.releaseChords = this.options.chords.hold((action) => this.act(action), {
      send: offersCommit(card)
    })
    this.emit()
  }

  /** Replace the open card's contents as it streams in. */
  updateCard(card: HudCard): void {
    if (!this.card) return
    this.card = card
    this.emit()
  }

  /** Close without answering — used when the proposal is withdrawn. */
  closeCard(): void {
    if (!this.card) return
    this.card = null
    this.onAction = null
    this.releaseChords?.()
    this.releaseChords = null
    this.emit()
  }

  /**
   * Deliver the user's answer, then close. Closing first would release the
   * chords before the handler ran, which is harmless — but delivering first
   * means a handler that throws still cannot leave ⏎ claimed.
   */
  act(action: HudAction): void {
    const handler = this.onAction
    if (!handler) return
    // A renderer or a stale chord can only ever ask for a commit the open card
    // is actually offering. Downgraded rather than dropped: the user pressed
    // something that means "yes", and Apply is the yes this card has.
    if (action === 'apply-send' && !offersCommit(this.card)) {
      this.options.log?.('warn', 'hud: apply-send on a card with no commit — applying only')
      action = 'apply'
    }
    try {
      handler(action)
    } finally {
      this.closeCard()
    }
  }

  /**
   * Withdraw an open proposal because something else needs the panel — in
   * practice, the user starting a new utterance.
   *
   * Delivered as a cancel rather than a silent `closeCard()` so whoever opened
   * it hears the answer and writes it down. A proposal that disappears without
   * a word is one the journal has no row for, and "where did that go?" is the
   * question this app exists to never provoke.
   */
  cancelOpen(): void {
    if (this.card) this.act('cancel')
  }

  get hasCard(): boolean {
    return this.card !== null
  }

  private merged(): HudState {
    if (!this.card) return this.base
    // A card outranks the pipeline's phase: whatever dictation is doing, the
    // panel is showing a proposal and waiting for an answer.
    return { ...this.base, phase: 'preview', card: this.card }
  }

  private emit(): void {
    const state = this.merged()
    const interactive = this.card !== null
    if (interactive !== this.interactive) {
      this.interactive = interactive
      this.options.port.setInteractive(interactive)
    }
    this.options.port.send(state)
  }
}

/** Does this card offer a second, heavier commit — today, Apply & send? */
function offersCommit(card: HudCard | null): boolean {
  return card?.kind === 'diff' && card.commit != null
}
