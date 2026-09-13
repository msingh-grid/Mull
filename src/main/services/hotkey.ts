import type { SidecarApi } from '@shared/sidecar-api'
import type { SidecarClient } from './sidecar'
import { PttStateMachine, type PttKeyEvent } from './ptt-machine'

/**
 * The push-to-talk key.
 *
 * Four ways to watch one key, tried in order of how well they work:
 *
 *  - **tap** — a `CGEventTap` in the Swift sidecar (M3). One listener that both
 *    observes *and* consumes, so there is no stray U+00A0 and no second
 *    mechanism to keep in step. It is also the only rung that can offer Fn.
 *  - **ptt** — Electron's `globalShortcut` (claims and consumes ⌥Space, but
 *    reports only key-down) paired with `uiohook-napi` (sees key-up, cannot
 *    consume). Two listeners, each covering the other's blind spot. This was
 *    M1's best case and is now the fallback.
 *  - **ptt-passive** — uiohook alone: push-to-talk works, but ⌥Space also
 *    reaches the app underneath.
 *  - **toggle** — globalShortcut alone: press to start, press again to stop.
 *
 * The tap is preferred but never required: it needs Input Monitoring, and a
 * user who has not granted it yet still gets a working hotkey while the app
 * explains what is missing. Failing over is silent by design — the mode is
 * logged and shown in Settings, not thrown.
 */

export type HotkeyMode = 'tap' | 'ptt' | 'ptt-passive' | 'toggle' | 'unavailable'

export type HotkeyChord = 'opt-space' | 'fn'

export interface HotkeyServiceOptions {
  accelerator?: string
  /** Which key to watch. `fn` is only possible on the tap rung. */
  chord?: HotkeyChord
  /** The sidecar, when one is running. Without it the tap rung is skipped. */
  sidecar?: SidecarApi | null
  /**
   * How to load the passive key tap. Injected so tests never load the native
   * module — requiring it actually starts listening to the keyboard, which is
   * not something a test run should do to the machine it runs on.
   */
  loadUiohook?: () => UiohookLike
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

/** Lazy require: loading this module begins listening, so never at import. */
function loadUiohookNapi(): UiohookLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('uiohook-napi') as { uIOhook: UiohookLike }
  return mod.uIOhook
}

export class HotkeyService {
  private machine: PttStateMachine | null = null
  private uiohook: UiohookLike | null = null
  private registered = false
  private toggleActive = false
  private sidecarTapRunning = false
  private offHotkey: (() => void) | null = null
  private readonly accelerator: string
  readonly chord: HotkeyChord
  private readonly log: NonNullable<HotkeyServiceOptions['log']>
  mode: HotkeyMode = 'unavailable'
  /** Why the passive listener could not be loaded, if it could not. */
  lastError: string | null = null
  /**
   * Why the tap rung was not taken. Kept separate from `lastError` because
   * both can fail in one launch and the tap's reason is the actionable one —
   * "no-input-monitoring" is a thing the user can go and fix.
   */
  tapReason: string | null = null

  constructor(private readonly options: HotkeyServiceOptions) {
    this.accelerator = options.accelerator ?? 'Alt+Space'
    this.chord = options.chord ?? 'opt-space'
    this.log = options.log ?? (() => {})
  }

  /**
   * @param globalShortcut Electron's module, injected so this file stays
   *        importable (and testable) outside an Electron process.
   */
  async start(globalShortcut?: {
    register(accelerator: string, cb: () => void): boolean
    unregister(accelerator: string): void
  }): Promise<HotkeyMode> {
    if (await this.trySidecarTap()) {
      this.mode = 'tap'
      this.log('info', 'hotkey mode: tap', { chord: this.chord })
      return this.mode
    }

    if (this.chord === 'fn') {
      // Only the tap can see Fn. Rather than silently watching a different key
      // than the one Settings claims, say so — the fallback still runs, so the
      // user keeps a working hotkey while they fix the permission.
      this.log('warn', 'hotkey: Fn needs the sidecar event tap; falling back to ⌥Space')
    }

    const claimed = this.tryGlobalShortcut(globalShortcut)
    const tapped = this.tryUiohook(claimed ? 'up-only' : 'edge')

    if (claimed && tapped) this.mode = 'ptt'
    else if (tapped) this.mode = 'ptt-passive'
    else if (claimed) this.mode = 'toggle'
    else this.mode = 'unavailable'

    this.log('info', `hotkey mode: ${this.mode}`, { accelerator: this.accelerator })
    return this.mode
  }

  /**
   * The best rung: one listener that both sees and swallows the chord.
   *
   * Any failure here is a fall-through, not an error. The common one is
   * Input Monitoring not granted yet, which is a state the app is designed to
   * survive — Settings will say so, and the ladder below still works.
   */
  private async trySidecarTap(): Promise<boolean> {
    const sidecar = this.options.sidecar
    if (!sidecar) return false

    try {
      const result = await sidecar.startHotkeyTap({ chord: this.chord, swallow: true })
      if (!result.started) {
        this.tapReason = result.reason
        this.log('info', `hotkey: sidecar tap unavailable (${result.reason ?? 'unknown'})`)
        return false
      }
      if (!result.swallowing) {
        // True for Fn, which the window server will not let anyone consume.
        this.log('info', `hotkey: watching ${this.chord}, but the app still receives it`)
      }

      const emitter = sidecar as Partial<SidecarClient>
      if (typeof emitter.on !== 'function' || typeof emitter.off !== 'function') {
        // A sidecar that cannot deliver notifications would leave the tap
        // running with nobody listening — worse than not starting it.
        await sidecar.stopHotkeyTap({}).catch(() => undefined)
        this.tapReason = 'no-notification-channel'
        return false
      }

      const handler = (event: { phase: 'down' | 'up' }): void => {
        if (event.phase === 'down') this.options.onStart()
        else this.options.onStop()
      }
      emitter.on('hotkey', handler)
      this.offHotkey = () => emitter.off?.('hotkey', handler)
      this.sidecarTapRunning = true
      return true
    } catch (err) {
      this.tapReason = err instanceof Error ? err.message : String(err)
      this.log('warn', 'hotkey: sidecar tap threw; falling back', err)
      return false
    }
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
      const hook = this.options.loadUiohook?.() ?? loadUiohookNapi()
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
    this.offHotkey?.()
    this.offHotkey = null
    if (this.sidecarTapRunning) {
      this.sidecarTapRunning = false
      void this.options.sidecar?.stopHotkeyTap({}).catch(() => undefined)
    }
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
