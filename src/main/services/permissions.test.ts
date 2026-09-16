import { describe, expect, it } from 'vitest'
import { FakeSidecar } from './sidecar'
import { PermissionsService } from './permissions'

/**
 * The rule this service exists to enforce, from docs/DESIGN.md §6.8: **a ✓
 * never comes from the click.** Granting happens in System Settings, out of
 * process, sometimes only after a relaunch — so every answer here is what macOS
 * said, and the Grant button's only job is to get the user to the right pane
 * with Mull actually listed in it.
 */

function service(overrides: {
  accessibility?: boolean
  inputMonitoring?: boolean
  screenRecording?: boolean
  microphone?: string
}): { permissions: PermissionsService; opened: string[]; sidecar: FakeSidecar } {
  const sidecar = new FakeSidecar({
    accessibility: overrides.accessibility ?? false,
    inputMonitoring: overrides.inputMonitoring ?? false,
    screenRecording: overrides.screenRecording ?? false
  })
  const opened: string[] = []
  return {
    sidecar,
    opened,
    permissions: new PermissionsService({
      sidecar,
      microphoneStatus: () => overrides.microphone ?? 'denied',
      openExternal: (url) => opened.push(url)
    })
  }
}

describe('PermissionsService', () => {
  /**
   * The bug this row fixes: Screen Recording was never listed, so the
   * screenshot half of `windowContext` was built, shipped, and never once
   * executed. A permission nobody can see is a permission nobody grants.
   */
  it('lists Screen Recording alongside the three that are required', async () => {
    const { permissions } = service({})
    const snapshot = await permissions.snapshot()
    expect(snapshot.permissions.map((p) => p.key)).toEqual([
      'microphone',
      'accessibility',
      'inputMonitoring',
      'screenRecording'
    ])
  })

  /**
   * Marked, not hidden. Mull dictates, edits and composes without it — so the
   * row must not read like a broken installation — but it has to be visible or
   * nobody ever turns it on.
   */
  it('says which one is optional, and which needs a relaunch', async () => {
    const { permissions } = service({})
    const rows = await permissions.snapshot()
    const shot = rows.permissions.find((p) => p.key === 'screenRecording')
    expect(shot).toMatchObject({ optional: true, needsRelaunch: true })
    for (const key of ['microphone', 'accessibility', 'inputMonitoring'] as const) {
      expect(rows.permissions.find((p) => p.key === key)?.optional).toBeUndefined()
    }
  })

  it('reports what macOS said, not what was asked for', async () => {
    const { permissions } = service({ screenRecording: true, microphone: 'granted' })
    const rows = (await permissions.snapshot()).permissions
    expect(rows.find((p) => p.key === 'screenRecording')?.granted).toBe(true)
    expect(rows.find((p) => p.key === 'microphone')?.granted).toBe(true)
    expect(rows.find((p) => p.key === 'accessibility')?.granted).toBe(false)
  })

  /**
   * An app that has never called `CGRequestScreenCaptureAccess` does not appear
   * in the Screen Recording list at all — so opening the pane alone showed the
   * user a list with no Mull in it and no way to add one. The request registers
   * the app; the pane is where they flip the switch. Both, in that order.
   */
  it('registers the app before sending anyone to the Screen Recording pane', async () => {
    const { permissions, opened, sidecar } = service({})
    await permissions.prompt('screenRecording')
    expect(sidecar.calls.some((call) => call.method === 'promptScreenRecording')).toBe(true)
    expect(opened[0]).toContain('Privacy_ScreenCapture')
  })

  it('still just opens the pane for the ones with no in-process prompt', async () => {
    const { permissions, opened } = service({})
    await permissions.prompt('inputMonitoring')
    expect(opened[0]).toContain('Privacy_ListenEvent')
  })

  it('survives a sidecar that cannot answer at all', async () => {
    const permissions = new PermissionsService({
      sidecar: {
        checkPermissions: () => Promise.reject(new Error('no sidecar')),
        secureInputState: () => Promise.reject(new Error('no sidecar'))
      } as never,
      microphoneStatus: () => 'granted',
      openExternal: () => {}
    })
    const snapshot = await permissions.snapshot()
    // Everything unknown reads as not granted, which is the safe direction:
    // a row that wrongly claims a ✓ is worse than one that wrongly asks again.
    expect(snapshot.permissions.find((p) => p.key === 'screenRecording')?.granted).toBe(false)
    expect(snapshot.secureInput).toBe(false)
  })
})
