/**
 * The three permissions Mull needs, as data.
 *
 * Shared so the settings pane and onboarding render the same rows from the
 * same answer. The service that produces it is
 * src/main/services/permissions.ts; the rule it enforces is that a ✓ only ever
 * comes from asking macOS, never from the user having clicked Grant.
 */

export type PermissionKey = 'microphone' | 'accessibility' | 'inputMonitoring'

export interface PermissionInfo {
  key: PermissionKey
  label: string
  /** Why Mull needs it, in the user's terms — shown next to every row. */
  reason: string
  granted: boolean
}

export interface PermissionsSnapshot {
  permissions: PermissionInfo[]
  /** Live secure-input state — not a permission, but the same kind of surprise. */
  secureInput: boolean
}
