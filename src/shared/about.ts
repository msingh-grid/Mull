import type { PermissionKey } from './permissions'

/**
 * What the about pane shows, and what a bug report needs.
 *
 * Deliberately the *live* values rather than build-time constants: the sidecar
 * version and protocol come from the running handshake, and the hotkey mode is
 * whichever rung of the degradation ladder this launch reached. A support
 * conversation that starts from what is actually running skips a round trip.
 */
export interface AboutInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  sidecarVersion: string | null
  sidecarProtocol: number | null
  /** The hotkey source in use: 'tap', 'ptt', 'toggle', 'unavailable', … */
  hotkeyMode: string
  /** Why the sidecar event tap is not in use, when it is not. Actionable. */
  hotkeyTapReason: string | null
  /**
   * Can the user ask Mull for something right now, or only dictate?
   *
   * False whenever the sidecar event tap is not running: Fn is the instruct key
   * and no other rung can see it. Surfaced rather than inferred because
   * "nothing happens when I press Fn" is otherwise indistinguishable from a
   * broken app.
   */
  canInstruct: boolean
  /** Whether ASR is the real local engine or the fake. */
  asrProvider: string
  paths: {
    journal: string
    settings: string
    bench: string
    model: string
    whisperCli: string
    logs: string
  }
  /** Permissions that are missing right now; empty when everything is granted. */
  missingPermissions: PermissionKey[]
}
