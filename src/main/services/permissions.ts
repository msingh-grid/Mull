import type { SidecarApi } from '@shared/sidecar-api'
import type { PermissionKey, PermissionsSnapshot } from '@shared/permissions'

/**
 * The permissions Mull needs, in one place.
 *
 * Each one is asked for by a different API and lives in a different pane of
 * System Settings, which is exactly why a user who has "granted everything"
 * can still have a Mull that does nothing. This service answers one question —
 * *what did macOS actually grant?* — for the settings pane, for onboarding,
 * and for the boot log.
 *
 * The rule that matters, from docs/DESIGN.md §6.8: **a ✓ never comes from the
 * click.** Granting happens in System Settings, asynchronously, and sometimes
 * requires a relaunch. So the UI polls this and reports what it finds; the
 * Grant button only opens the right pane.
 */

/** `x-apple.systempreferences:` targets for each pane. */
const SETTINGS_URL: Record<PermissionKey, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  inputMonitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  screenRecording:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
}

const COPY: Record<PermissionKey, { label: string; reason: string }> = {
  microphone: {
    label: 'Microphone',
    reason: 'To hear you while you hold the key. Audio never leaves this Mac.'
  },
  accessibility: {
    label: 'Accessibility',
    reason: 'To place text at your caret in other apps, and to take it back with ⌥Z.'
  },
  inputMonitoring: {
    label: 'Input Monitoring',
    reason: 'To notice the hotkey while you are working in another app.'
  },
  screenRecording: {
    label: 'Screen Recording',
    reason:
      'To see the window you are working in, so “reply to this” has something to reply to. Without it Mull reads the text but never sees the picture. Needs a relaunch.'
  }
}

/** Mull types, edits and composes without this one. It just sees less. */
const OPTIONAL: ReadonlySet<PermissionKey> = new Set<PermissionKey>(['screenRecording'])

/**
 * macOS caches this grant per process. Flipping the switch does nothing until
 * Mull is launched again, so the row has to say so rather than sit on a ✗ the
 * user has already fixed.
 */
const NEEDS_RELAUNCH: ReadonlySet<PermissionKey> = new Set<PermissionKey>(['screenRecording'])

export interface PermissionsDeps {
  sidecar: SidecarApi
  /** `systemPreferences.getMediaAccessStatus('microphone')`, injected. */
  microphoneStatus: () => string
  /** `shell.openExternal`, injected. */
  openExternal: (url: string) => void
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export class PermissionsService {
  constructor(private readonly deps: PermissionsDeps) {}

  async snapshot(): Promise<PermissionsSnapshot> {
    const microphone = this.deps.microphoneStatus() === 'granted'
    const fromSidecar = await this.deps.sidecar
      .checkPermissions({})
      .catch(() => ({ accessibility: false, inputMonitoring: false, screenRecording: false }))
    const secure = await this.deps.sidecar
      .secureInputState({})
      .catch(() => ({ active: false, processName: null }))

    const granted: Record<PermissionKey, boolean> = {
      microphone,
      accessibility: fromSidecar.accessibility,
      inputMonitoring: fromSidecar.inputMonitoring,
      screenRecording: fromSidecar.screenRecording
    }

    const permissions = (Object.keys(granted) as PermissionKey[]).map((key) => ({
      key,
      label: COPY[key].label,
      reason: COPY[key].reason,
      granted: granted[key],
      ...(OPTIONAL.has(key) ? { optional: true } : {}),
      ...(NEEDS_RELAUNCH.has(key) ? { needsRelaunch: true } : {})
    }))

    return { permissions, secureInput: secure.active }
  }

  /** Open the pane. Nothing here decides whether it was granted. */
  open(key: PermissionKey): void {
    this.deps.openExternal(SETTINGS_URL[key])
  }

  /**
   * The one grant macOS will prompt for in-process. Accessibility and Input
   * Monitoring have no such API — the pane is the only route.
   */
  async prompt(key: PermissionKey): Promise<void> {
    if (key === 'accessibility') {
      await this.deps.sidecar.promptAccessibility({}).catch(() => undefined)
      return
    }
    if (key === 'screenRecording') {
      // `CGRequestScreenCaptureAccess` shows the system prompt the first time
      // and opens nothing thereafter, so the pane is opened as well — a second
      // click that lands on an already-answered prompt has to go somewhere.
      await this.deps.sidecar.promptScreenRecording({}).catch(() => undefined)
      this.open(key)
      return
    }
    this.open(key)
  }
}
