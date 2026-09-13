import { PttStateMachine, type PttKeyEvent } from './ptt-machine'

/**
 * Global ⌥Space push-to-talk.
 *
 * Two listeners, each covering the other's blind spot:
 *
 *  - Electron's `globalShortcut` claims ⌥Space and **consumes** it, so the
 *    focused app never receives the non-breaking space that ⌥Space normally
 *    types. That is the whole reason it is here: a passive listener alone
 *    would leave a stray U+00A0 in front of every dictation. It only reports
 *    key-down.
 *  - `uiohook-napi` is a passive tap that still sees the key-up we need to end
 *    the utterance.
 *
 * Degradation ladder, loudest capability first:
 *   both            -> true push-to-talk, no stray character
 *   uiohook only    -> push-to-talk, but ⌥Space also reaches the app
 *   globalShortcut  -> press-to-start / press-to-stop toggle
 *   neither         -> dev trigger only; the HUD says so
 *
 * M3 replaces all of this with a CGEventTap in the Swift sidecar, which can
 * both observe and swallow, and survives Input Monitoring being granted late.
 */

export type HotkeyMode = 'ptt' | 'ptt-passive' | 'toggle' | 'unavailable'

export interface HotkeyServiceOptions {
  accelerator?: string
  onStart: () => void
  onStop: () => void
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

// uiohook keycodes (X11-style, as the library reports them on macOS).
const KEYCODES = { space: 57, alt: [56, 3640] } as const

interface UiohookLike {
  on(event: 'keydown' | 'keyup', handler: (e: PttKeyEvent) => void): void
  start(): void
  stop(): void
}

export class HotkeyService {
  private machine: PttStateMachine | null = null
  private uiohook: UiohookLike | null = null
  private registered = false
  private toggleActive = false
  private readonly accelerator: string
  private readonly log: NonNullable<HotkeyServiceOptions['log']>
  mode: HotkeyMode = 'unavailable'
  lastError: string | null = null

  constructor(private readonly options: HotkeyServiceOptions) {
    this.accelerator = options.accelerator ?? 'Alt+Space'
    this.log = options.log ?? (() => {})
  }

  /**
   * @param globalShortcut Electron's module, injected so this file stays
   *        importable (and testable) outside an Electron process.
   */
  start(globalShortcut?: {
    register(accelerator: string, cb: () => void): boolean
    unregister(accelerator: string): void
  }): HotkeyMode {
    const claimed = this.tryGlobalShortcut(globalShortcut)
    const tapped = this.tryUiohook(claimed ? 'up-only' : 'edge')

    if (claimed && tapped) this.mode = 'ptt'
    else if (tapped) this.mode = 'ptt-passive'
    else if (claimed) this.mode = 'toggle'
    else this.mode = 'unavailable'

    this.log('info', `hotkey mode: ${this.mode}`, { accelerator: this.accelerator })
    return this.mode
  }

  private tryGlobalShortcut(gs?: {
    register(accelerator: string, cb: () => void): boolean
    unregister(accelerator: string): void
  }): boolean {
    if (!gs) return false
    try {
      const ok = gs.register(this.accelerator, () => this.onShortcutPressed())
      this.registered = ok
      if (!ok) this.log('warn', `hotkey: ${this.accelerator} is already claimed by another app`)
      return ok
    } catch (err) {
      this.log('error', 'hotkey: globalShortcut registration threw', err)
      return false
    }
  }

  private tryUiohook(mode: 'edge' | 'up-only'): boolean {
    try {
      // Lazy require: the native module is built for Electron's ABI, so
      // importing it from plain node (vitest, scripts) would throw.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('uiohook-napi') as { uIOhook: UiohookLike }
      const hook = mod.uIOhook
      this.machine = new PttStateMachine(KEYCODES, mode)
      hook.on('keydown', (e) => this.onHookEvent({ ...e, type: 'keydown' }))
      hook.on('keyup', (e) => this.onHookEvent({ ...e, type: 'keyup' }))
      hook.start()
      this.uiohook = hook
      return true
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.log(
        'warn',
        'hotkey: uiohook unavailable — grant Input Monitoring, then restart Mull',
        this.lastError
      )
      return false
    }
  }

  private onHookEvent(event: PttKeyEvent): void {
    const action = this.machine?.handle(event)
    if (action === 'start') this.options.onStart()
    else if (action === 'stop') this.options.onStop()
  }

  private onShortcutPressed(): void {
    if (this.mode === 'toggle' || !this.machine) {
      // No key-up source: the same chord starts and stops.
      this.toggleActive = !this.toggleActive
      if (this.toggleActive) this.options.onStart()
      else this.options.onStop()
      return
    }
    if (this.machine.isActive) return // key repeat via the shortcut
    this.machine.markStarted()
    this.options.onStart()
  }

  /** Force the machine back to rest — called on app blur / session change. */
  reset(): void {
    this.machine?.reset()
    this.toggleActive = false
  }

  stop(gs?: { unregister(accelerator: string): void }): void {
    if (this.registered && gs) {
      try {
        gs.unregister(this.accelerator)
      } catch {
        /* shutting down anyway */
      }
    }
    this.registered = false
    try {
      this.uiohook?.stop()
    } catch {
      /* shutting down anyway */
    }
    this.uiohook = null
  }
}
