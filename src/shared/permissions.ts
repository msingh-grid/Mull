/**
 * The permissions Mull needs, as data.
 *
 * Shared so the settings pane and onboarding render the same rows from the
 * same answer. The service that produces it is
 * src/main/services/permissions.ts; the rule it enforces is that a ✓ only ever
 * comes from asking macOS, never from the user having clicked Grant.
 */

/**
 * Three of these are needed to type a word; the fourth is not.
 *
 * `screenRecording` is the only optional one, and it is the only one whose
 * absence is *silent*: without it Mull still dictates, still edits, still
 * composes — it simply never sees a picture, so it works from the accessibility
 * text alone and says things like "I can only see the headers". It went
 * unlisted for the whole of M5a, which meant the screenshot half of
 * `windowContext` was built, shipped and never once executed.
 */
export type PermissionKey =
  | 'microphone'
  | 'accessibility'
  | 'inputMonitoring'
  | 'screenRecording'

export interface PermissionInfo {
  key: PermissionKey
  label: string
  /** Why Mull needs it, in the user's terms — shown next to every row. */
  reason: string
  granted: boolean
  /**
   * Mull works without this one. Marked rather than hidden: a row that is
   * merely off should not read like a broken installation, and a permission
   * nobody can see is a permission nobody grants.
   */
  optional?: boolean
  /**
   * macOS will not honour this grant until the app restarts, so a ✓ cannot
   * appear on its own after the user flips the switch.
   */
  needsRelaunch?: boolean
}

export interface PermissionsSnapshot {
  permissions: PermissionInfo[]
  /** Live secure-input state — not a permission, but the same kind of surprise. */
  secureInput: boolean
}
