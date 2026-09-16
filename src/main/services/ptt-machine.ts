/**
 * Push-to-talk state machine for ⌥Space — pure, so the awkward parts are
 * testable without a keyboard.
 *
 * The awkward parts, all of which have bitten PTT implementations before:
 *   - key repeat: holding Space re-fires keydown ~30x/s; only the first counts
 *   - release order: the user may lift ⌥ before Space, or Space before ⌥;
 *     either ends the utterance, and the second release must be a no-op
 *   - chord pollution: ⌘⌥Space / ⌃⌥Space are somebody else's shortcut
 *   - lost events: if a keyup is swallowed (focus change, screen lock) the
 *     machine can strand itself "active" — `reset()` is called on app blur
 *
 * Two modes, because how we learn about key-down differs by capability:
 *   'edge'    — uiohook gives us both edges (used when Electron's
 *               globalShortcut could not claim ⌥Space)
 *   'up-only' — globalShortcut owns key-down (and, importantly, *consumes* it
 *               so the focused app never receives a stray non-breaking space);
 *               uiohook is only here to tell us when the key came back up
 */

export interface PttKeyEvent {
  type: 'keydown' | 'keyup'
  keycode: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export type PttAction = 'start' | 'stop' | null

export interface PttKeycodes {
  space: number
  alt: readonly number[]
}

export class PttStateMachine {
  private altDown = false
  private spaceDown = false
  private active = false

  constructor(
    private readonly keys: PttKeycodes,
    private readonly mode: 'edge' | 'up-only' = 'edge'
  ) {}

  get isActive(): boolean {
    return this.active
  }

  /** Called when key-down arrived out-of-band (globalShortcut). */
  markStarted(): void {
    this.active = true
    this.spaceDown = true
    this.altDown = true
  }

  handle(event: PttKeyEvent): PttAction {
    const isAlt = this.keys.alt.includes(event.keycode)
    const isSpace = event.keycode === this.keys.space

    if (event.type === 'keydown') {
      if (isAlt) this.altDown = true
      if (isSpace) this.spaceDown = true
      if (this.mode !== 'edge') return null
      if (!isSpace) return null
      // Repeat suppression: a held key re-fires keydown forever.
      if (this.active) return null
      const altHeld = this.altDown || event.altKey
      if (!altHeld) return null
      // ⌥Space only — any other modifier means this chord belongs elsewhere.
      if (event.metaKey || event.ctrlKey || event.shiftKey) return null
      this.active = true
      return 'start'
    }

    // keyup
    if (isAlt) this.altDown = false
    if (isSpace) this.spaceDown = false
    if (!this.active) return null
    if (!isAlt && !isSpace) return null
    // Either release ends the utterance; the trailing one must not re-fire.
    this.active = false
    return 'stop'
  }

  /** Drop all held-key belief. Use when focus or the session changes. */
  reset(): void {
    this.altDown = false
    this.spaceDown = false
    this.active = false
  }
}
