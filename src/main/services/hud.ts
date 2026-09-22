import { IDLE_HUD_STATE, type HudAction, type HudState } from '@shared/ipc'
import { cardFamily, type HudCard } from '@shared/hud'
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
  /**
   * Is a run in flight on the open card?
   *
   * Separate from `PlanCard.running` because the two flip at different moments
   * and the gap between them is reachable. This one is set synchronously the
   * instant Run is delivered; the card's is set whenever the lane next draws,
   * which for a lane that starts a subprocess is several hundred milliseconds
   * later. Return auto-repeats, so a user leaning on the key can press into
   * that gap — and this flag is what makes ⏎ inert for strictly longer than the
   * card *looks* running, which is the side to be wrong on.
   */
  private running = false

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
    // Where a run ends. Set by `act` before the lane has drawn anything and
    // cleared here once the lane draws the ending, so the card is answerable
    // again the moment it stops claiming to be running — and not before.
    if (this.running && !(card.kind === 'plan' && card.running === true)) this.running = false
    this.emit()
  }

  /** Close without answering — used when the proposal is withdrawn. */
  closeCard(): void {
    if (!this.card) return
    this.card = null
    this.onAction = null
    this.running = false
    this.releaseChords?.()
    this.releaseChords = null
    this.emit()
  }

  /**
   * Deliver the user's answer, then close. Closing first would release the
   * chords before the handler ran, which is harmless — but delivering first
   * means a handler that throws still cannot leave ⏎ claimed.
   *
   * ### Except for the one card whose Apply is a beginning
   *
   * Every other card is a question: the press is the answer and the card is
   * done. A plan's Run is not an answer — it starts a loop that reports back
   * onto this same card, and esc becomes the only way to stop it. Closing on
   * the press, as this did for every card alike, made every later `updateCard`
   * a silent no-op and handed Escape back to the very app the run was driving:
   * the step list never appeared, and Stop could not be pressed.
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
    // ⏎ while a run is in flight: claimed and inert, for the send card's reason
    // and a sharper version of it. Mull holds Return globally for as long as a
    // card is open, and the window underneath is one this very run is driving —
    // letting the press through would hand Return to a composer Mull may have
    // just typed into. There is nothing for it to mean here either: the Run it
    // used to press has been pressed.
    if (action !== 'cancel' && this.running) {
      this.options.log?.('info', 'hud: ⏎ while a run is in flight — claimed and inert')
      return
    }
    // A card nothing more can happen on has no "yes" for ⏎ to be — but there
    // is also nothing at stake in closing it, and a Done button whose ⏎ hint
    // did nothing would be a lie printed on the card. Return means done there,
    // and it can only ever mean done: a `wont` card has no text, no target and
    // no commit to reach. This is also what stops a finished plan from
    // offering to walk the whole thing again.
    if (action === 'apply' && this.card && cardFamily(this.card) === 'wont') action = 'cancel'
    // …and the other way round. Swallowed rather than downgraded to a cancel:
    // a card that vanished because the user brushed ⏎ is a card they have to
    // ask for again, and this one is one keystroke from an irreversible act.
    if (action === 'apply' && !acceptsApply(this.card)) {
      this.options.log?.('info', 'hud: ⏎ has no meaning on this card — ignored')
      return
    }
    // Does this press leave the card up? Two do, and they are the two ends of
    // the same run:
    //
    //   the Run that starts it   the card is where the run reports back, so
    //                            closing it blinds the user to everything that
    //                            follows and takes the stop away with it.
    //   the esc that stops it    stopping is not finishing. The lane still has a
    //                            window to put back and an ending to write, and
    //                            a stop that blanked the card would read as
    //                            "nothing happened" — the one thing a stop must
    //                            never be mistaken for, because a press already
    //                            dispatched cannot be un-pressed.
    //
    // Everything else is an answer, and an answered card is finished.
    const keeps = this.running ? action === 'cancel' : action === 'apply' && startsRun(this.card)

    let kept = false
    try {
      handler(action)
      // Only from a handler that *returned*. One that threw never started
      // anything, and must not leave ⏎ claimed on a card with nobody behind it
      // — that is the rule above, unchanged. And only while the card is still
      // here: a handler may have closed it itself.
      kept = keeps && this.card !== null
    } finally {
      if (kept) this.running = true
      else this.closeCard()
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
    if (!this.card) return
    this.act('cancel')
    // …and then go, whatever `act` decided. A run answers a cancel by stopping,
    // and stopping takes as long as it takes to put the window back; Escape can
    // afford to wait for that ending to appear on the card, but this cannot —
    // the panel has just been claimed by a new utterance. The run still
    // restores, still files its row, and still reports through `announce`, so
    // the ending is on the ghost row and in the journal instead. Idempotent for
    // every other card, which `act` has already closed.
    this.closeCard()
  }

  get hasCard(): boolean {
    return this.card !== null
  }

  /**
   * The user is correcting what Mull heard, in a field on the panel itself.
   *
   * All this owns is the card's chords: while the field has the caret, ⏎ and
   * esc belong to it, not to the card underneath. The window's focusability is
   * main's business — this class has no `electron` import and is not about to
   * grow one.
   *
   * Safe to leave on: a card closing releases the claim outright, so a
   * correction that ends by re-running the utterance cannot strand it.
   */
  setEditing(editing: boolean): void {
    if (editing) this.options.chords.suspend()
    else this.options.chords.resume()
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

/**
 * Does Apply on this card *start* something rather than answer it?
 *
 * Keyed on the card's own field rather than on `kind`, because a plan card is
 * not always a running one: the tray's demo plan proposes nothing and runs
 * nothing, and a rule that read `kind === 'plan'` would leave it holding ⏎ and
 * esc for the rest of the session with no handler behind them.
 */
function startsRun(card: HudCard | null): boolean {
  return card?.kind === 'plan' && card.startsRun === true
}

/** Does this card offer the heavier commit — Apply & send, or a bare Send? */
function offersCommit(card: HudCard | null): boolean {
  if (card?.kind === 'send') return true
  return card?.kind === 'diff' && card.commit != null
}

/**
 * Does ⏎ mean Apply on this card?
 *
 * Only on a card something can still happen on, and only when that something
 * is not a send. Two exclusions, for opposite reasons:
 *
 *   send    has nothing to apply, and ⏎ must stay *claimed and inert* — Mull
 *           holds Return globally while a card is open, and letting it through
 *           to Slack would send the very message the card is asking about.
 *   `wont`  has nothing to apply either, but nothing is at risk, so ⏎ was
 *           already translated to a cancel in `act` before it reached here.
 *           That is the whole difference between a card that proposes an
 *           irreversible act and one that proposes nothing at all.
 */
function acceptsApply(card: HudCard | null): boolean {
  return card !== null && card.kind !== 'send' && cardFamily(card) === 'will'
}
