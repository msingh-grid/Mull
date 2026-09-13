import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SidecarApi } from '@shared/sidecar-api'
import { FakeSidecar } from './sidecar'
import { HotkeyService } from './hotkey'

/**
 * The ladder, not the keys.
 *
 * The passive listener is injected in every test here. Loading the real one
 * starts watching the keyboard of whatever machine the suite runs on, which a
 * test has no business doing — and injecting it is also what makes the middle
 * rungs reachable at all.
 */

/** Stands in for uiohook-napi. */
function fakeHook(): { on: () => void; start: () => void; stop: () => void } {
  return { on: () => {}, start: () => {}, stop: () => {} }
}

/** A machine where the passive listener cannot be loaded. */
const noHook = (): never => {
  throw new Error('uiohook unavailable')
}

/** A sidecar that can deliver notifications, like the real client. */
class TapSidecar extends EventEmitter {
  started: Array<{ chord: string; swallow?: boolean }> = []
  stopped = 0

  constructor(private readonly outcome: { started: boolean; reason?: string; swallowing?: boolean } = { started: true }) {
    super()
  }

  async startHotkeyTap(params: { chord: string; swallow?: boolean }) {
    this.started.push(params)
    return {
      started: this.outcome.started,
      reason: this.outcome.reason ?? null,
      swallowing: this.outcome.swallowing ?? this.outcome.started
    }
  }

  async stopHotkeyTap() {
    this.stopped += 1
    return { stopped: true }
  }
}

interface FakeShortcuts {
  register: (accelerator: string, cb: () => void) => boolean
  unregister: (accelerator: string) => void
  claimed: string[]
}

const shortcuts = (claim = true): FakeShortcuts => {
  const claimed: string[] = []
  return {
    claimed,
    register(accelerator) {
      if (claim) claimed.push(accelerator)
      return claim
    },
    unregister(accelerator) {
      const index = claimed.indexOf(accelerator)
      if (index >= 0) claimed.splice(index, 1)
    }
  }
}

describe('HotkeyService ladder', () => {
  it('prefers the sidecar tap and never touches globalShortcut', async () => {
    const sidecar = new TapSidecar()
    const gs = shortcuts()
    const service = new HotkeyService({
      sidecar: sidecar as unknown as SidecarApi,
      loadUiohook: fakeHook,
      onStart: () => {},
      onStop: () => {}
    })

    expect(await service.start(gs)).toBe('tap')
    expect(sidecar.started).toEqual([{ chord: 'opt-space', swallow: true }])
    expect(gs.claimed).toEqual([])
  })

  it('turns tap notifications into start and stop', async () => {
    const sidecar = new TapSidecar()
    const onStart = vi.fn()
    const onStop = vi.fn()
    const service = new HotkeyService({
      sidecar: sidecar as unknown as SidecarApi,
      loadUiohook: noHook,
      onStart,
      onStop
    })
    await service.start(shortcuts())

    sidecar.emit('hotkey', { phase: 'down', chord: 'opt-space' })
    sidecar.emit('hotkey', { phase: 'up', chord: 'opt-space' })
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('falls back to the old path when Input Monitoring is missing', async () => {
    const sidecar = new TapSidecar({ started: false, reason: 'no-input-monitoring' })
    const gs = shortcuts()
    const service = new HotkeyService({
      sidecar: sidecar as unknown as SidecarApi,
      loadUiohook: fakeHook,
      onStart: () => {},
      onStop: () => {}
    })

    // Both halves of the M1 pair are available, so it lands on the rung that
    // still gives true push-to-talk without a stray character.
    expect(await service.start(gs)).toBe('ptt')
    expect(gs.claimed).toEqual(['Alt+Space'])
    expect(service.tapReason).toBe('no-input-monitoring')
  })

  it('falls back when the sidecar throws', async () => {
    const sidecar = {
      startHotkeyTap: () => Promise.reject(new Error('pipe closed')),
      stopHotkeyTap: () => Promise.resolve({ stopped: false })
    }
    const service = new HotkeyService({
      sidecar: sidecar as unknown as SidecarApi,
      loadUiohook: noHook,
      onStart: () => {},
      onStop: () => {}
    })

    expect(await service.start(shortcuts())).toBe('toggle')
    expect(service.tapReason).toBe('pipe closed')
  })

  it('refuses to leave a tap running that nothing can listen to', async () => {
    // FakeSidecar answers startHotkeyTap but is not an event emitter, so there
    // is no way for key events to arrive — starting it would be a silent trap.
    const sidecar = new FakeSidecar()
    const service = new HotkeyService({
      sidecar,
      loadUiohook: noHook,
      onStart: () => {},
      onStop: () => {}
    })

    expect(await service.start(shortcuts())).toBe('toggle')
    expect(sidecar.hotkeyTapChord).toBeNull()
    expect(service.tapReason).toBe('no-notification-channel')
  })

  it('reports unavailable when nothing at all is on offer', async () => {
    const service = new HotkeyService({
      sidecar: null,
      loadUiohook: noHook,
      onStart: () => {},
      onStop: () => {}
    })
    expect(await service.start(shortcuts(false))).toBe('unavailable')
  })

  it('asks the tap for Fn when that is the chosen chord', async () => {
    const sidecar = new TapSidecar()
    const service = new HotkeyService({
      chord: 'fn',
      sidecar: sidecar as unknown as SidecarApi,
      loadUiohook: noHook,
      onStart: () => {},
      onStop: () => {}
    })

    expect(await service.start(shortcuts())).toBe('tap')
    expect(sidecar.started[0]?.chord).toBe('fn')
  })

  it('says so when Fn is asked for but only the fallback is available', async () => {
    const sidecar = new TapSidecar({ started: false, reason: 'no-input-monitoring' })
    const warnings: string[] = []
    const service = new HotkeyService({
      chord: 'fn',
      sidecar: sidecar as unknown as SidecarApi,
      loadUiohook: noHook,
      onStart: () => {},
      onStop: () => {},
      log: (level, message) => {
        if (level === 'warn') warnings.push(message)
      }
    })

    await service.start(shortcuts())
    expect(warnings.some((line) => line.includes('Fn needs the sidecar event tap'))).toBe(true)
  })

  it('stops the tap and unsubscribes on shutdown', async () => {
    const sidecar = new TapSidecar()
    const onStart = vi.fn()
    const service = new HotkeyService({
      sidecar: sidecar as unknown as SidecarApi,
      loadUiohook: noHook,
      onStart,
      onStop: () => {}
    })
    await service.start(shortcuts())

    service.stop()
    await Promise.resolve()
    expect(sidecar.stopped).toBe(1)

    // A key event arriving after shutdown must not restart dictation.
    sidecar.emit('hotkey', { phase: 'down', chord: 'opt-space' })
    expect(onStart).not.toHaveBeenCalled()
  })
})
