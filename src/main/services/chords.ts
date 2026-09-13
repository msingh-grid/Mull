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

export type ChordAction = 'apply' | 'cancel'

const CHORDS: Array<{ accelerator: string; action: ChordAction }> = [
  { accelerator: 'Return', action: 'apply' },
  { accelerator: 'Escape', action: 'cancel' }
]

export interface ChordScopeOptions {
  globalShortcut: GlobalShortcutLike
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export class ChordScope {
  private held: string[] = []
  private onAction: ((action: ChordAction) => void) | null = null
  private readonly log: NonNullable<ChordScopeOptions['log']>

  constructor(private readonly options: ChordScopeOptions) {
    this.log = options.log ?? (() => {})
  }

  get active(): boolean {
    return this.held.length > 0
  }

  /**
   * Claim ⏎ and esc until the returned function is called. Re-holding while
   * already held simply swaps the handler — a second card replacing a first
   * must not end up with two registrations and one release.
   */
  hold(onAction: (action: ChordAction) => void): () => void {
    this.onAction = onAction
    if (this.active) return () => this.release()

    for (const chord of CHORDS) {
      try {
        const ok = this.options.globalShortcut.register(chord.accelerator, () => {
          this.onAction?.(chord.action)
        })
        if (ok) this.held.push(chord.accelerator)
        else this.log('warn', `chords: ${chord.accelerator} is claimed by another app`)
      } catch (err) {
        this.log('error', `chords: registering ${chord.accelerator} threw`, err)
      }
    }

    // All-or-nothing: a card that can be applied but not cancelled is a trap.
    if (this.held.length !== CHORDS.length) {
      this.log('warn', 'chords: could not claim both ⏎ and esc — releasing both')
      this.release()
      return () => {}
    }

    return () => this.release()
  }

  /** Idempotent. Called from card close, window hide, and before-quit. */
  release(): void {
    this.onAction = null
    const held = this.held
    this.held = []
    for (const accelerator of held) {
      try {
        this.options.globalShortcut.unregister(accelerator)
      } catch (err) {
        this.log('error', `chords: unregistering ${accelerator} threw`, err)
      }
    }
  }
}
