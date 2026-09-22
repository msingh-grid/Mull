/**
 * The card's ⏎ / esc chords.
 *
 * The HUD is never focusable (docs/DESIGN.md §7.1) — it must not take the
 * caret from the app you are dictating into — so Apply and Cancel cannot be
 * keydown handlers in the renderer. They have to be global shortcuts.
 *
 * Global Return and Escape are about as invasive as a shortcut gets: while
 * they are registered, no other app can see them. So the scope is the whole
 * design here. `hold()` claims them, and the returned release is idempotent
 * and called from every path that closes a card — including the error paths.
 * If this file is wrong, the symptom is that the user cannot press Enter
 * anywhere on their Mac, which is why the claim is verified and logged.
 *
 * No `electron` import: the module is injected, so this is unit-testable.
 */

export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  isRegistered?(accelerator: string): boolean
}

export type ChordAction = 'apply' | 'apply-send' | 'cancel'

/** The two every card has. All-or-nothing: see `hold`. */
const CORE: Array<{ accelerator: string; action: ChordAction }> = [
  { accelerator: 'Return', action: 'apply' },
  { accelerator: 'Escape', action: 'cancel' }
]

/**
 * The third, claimed only for a card that offers a second commit.
 *
 * Best-effort, unlike the core two. ⌘⏎ is a common shortcut inside other apps
 * (Slack's own "send" when Return is set to newline, among others), so failing
 * to claim it is an ordinary outcome rather than a broken card — the button is
 * still there to click, and Apply and Cancel are unaffected. Claiming it
 * unconditionally would also mean holding someone's ⌘⏎ hostage on every
 * ordinary edit preview, for a commit that card does not offer.
 */
const SEND: { accelerator: string; action: ChordAction } = {
  accelerator: 'CommandOrControl+Return',
  action: 'apply-send'
}

/** Which action each accelerator stands for, so `resume` can rebuild a claim. */
const ACCELERATORS = new Map<string, ChordAction>(
  [...CORE, SEND].map((chord) => [chord.accelerator, chord.action])
)

export interface ChordScopeOptions {
  globalShortcut: GlobalShortcutLike
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export class ChordScope {
  private held: string[] = []
  /** What `suspend` gave back, kept so `resume` can claim exactly that again. */
  private suspended: string[] | null = null
  private onAction: ((action: ChordAction) => void) | null = null
  private readonly log: NonNullable<ChordScopeOptions['log']>

  constructor(private readonly options: ChordScopeOptions) {
    this.log = options.log ?? (() => {})
  }

  get active(): boolean {
    return this.held.length > 0
  }

  /**
   * Claim ⏎ and esc until the returned function is called — and ⌘⏎ too when
   * `send` is set, for a card that offers a second commit.
   *
   * Re-holding while already held simply swaps the handler — a second card
   * replacing a first must not end up with two registrations and one release.
   */
  hold(onAction: (action: ChordAction) => void, options?: { send?: boolean }): () => void {
    this.onAction = onAction
    if (this.active) return () => this.release()

    const claim = (chord: { accelerator: string; action: ChordAction }): boolean => {
      try {
        const ok = this.options.globalShortcut.register(chord.accelerator, () => {
          this.onAction?.(chord.action)
        })
        if (ok) this.held.push(chord.accelerator)
        else this.log('warn', `chords: ${chord.accelerator} is claimed by another app`)
        return ok
      } catch (err) {
        this.log('error', `chords: registering ${chord.accelerator} threw`, err)
        return false
      }
    }

    const core = CORE.filter((chord) => claim(chord))

    // All-or-nothing: a card that can be applied but not cancelled is a trap.
    if (core.length !== CORE.length) {
      this.log('warn', 'chords: could not claim both ⏎ and esc — releasing both')
      this.release()
      return () => {}
    }

    // Best-effort, and deliberately after the all-or-nothing check: the card
    // works without it, and the button is still clickable.
    if (options?.send && !claim(SEND)) {
      this.log('warn', 'chords: ⌘⏎ is claimed elsewhere — Apply & send is click-only')
    }

    return () => this.release()
  }

  /**
   * Hand ⏎ and esc back for as long as the user is typing into the panel.
   *
   * A global shortcut wins over the focused window, so a claimed Return never
   * reaches a field in Mull's own HUD — it would apply the card instead of
   * ending the line. Correcting a misheard name needs both keys to mean what
   * they mean in a text field, so the claim is dropped for the duration and
   * `resume` puts back exactly what was held, with the same handler.
   *
   * Not `release` + a second `hold`: the card is still open and still the thing
   * those chords belong to, and a release would tell every caller watching
   * `active` that the card had stopped claiming them for good.
   */
  suspend(): void {
    if (this.suspended !== null || !this.active) return
    this.suspended = this.held
    this.held = []
    for (const accelerator of this.suspended) this.unclaim(accelerator)
  }

  /** Re-claim what `suspend` gave back. A no-op if the card closed meanwhile. */
  resume(): void {
    const suspended = this.suspended
    this.suspended = null
    if (!suspended || !this.onAction) return
    for (const accelerator of suspended) {
      const action = ACCELERATORS.get(accelerator)
      if (!action) continue
      try {
        if (this.options.globalShortcut.register(accelerator, () => this.onAction?.(action))) {
          this.held.push(accelerator)
        } else {
          this.log('warn', `chords: ${accelerator} was taken while the panel had focus`)
        }
      } catch (err) {
        this.log('error', `chords: re-registering ${accelerator} threw`, err)
      }
    }
  }

  /** Idempotent. Called from card close, window hide, and before-quit. */
  release(): void {
    this.onAction = null
    // A card closing under a suspended claim — the correction re-ran the
    // utterance, say — must not leave accelerators behind for a `resume` that
    // will never come.
    const held = [...this.held, ...(this.suspended ?? [])]
    this.held = []
    this.suspended = null
    for (const accelerator of held) this.unclaim(accelerator)
  }

  private unclaim(accelerator: string): void {
    try {
      this.options.globalShortcut.unregister(accelerator)
    } catch (err) {
      this.log('error', `chords: unregistering ${accelerator} threw`, err)
    }
  }
}
