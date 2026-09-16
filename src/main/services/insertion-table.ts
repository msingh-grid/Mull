import type { InsertionStrategy } from '@shared/sidecar-api'

/**
 * Which insertion strategy to try, per app.
 *
 * macOS offers three ways to put text where the caret is, and no app supports
 * all three well:
 *
 *   ax     write `AXSelectedText` directly. Invisible, atomic, and — crucially —
 *          verifiable, because the sidecar can read the value back. Native Cocoa
 *          apps implement it; Chromium, Electron and Java apps mostly do not,
 *          and a few *accept the write and drop it*, which is why the sidecar
 *          verifies rather than trusting the return code.
 *   paste  swap the pasteboard, post ⌘V, swap it back. Works nearly everywhere.
 *          Costs a pasteboard round-trip and a settle delay, and briefly owns a
 *          system resource the user also owns.
 *   type   synthesise each character. Slow, visible, and survives targets that
 *          reject the other two (some terminals, remote desktops, games).
 *
 * The chains below are the *starting* belief. `InsertionService` demotes a
 * strategy for the rest of the session when an app proves it doesn't work, so a
 * wrong guess here costs one attempt, once — and the truth is recorded in
 * docs/INSERTION-MATRIX.md as it's confirmed by hand.
 */

export interface InsertionProfile {
  /** Strategies to try, in order. Empty means: never write into this app. */
  chain: InsertionStrategy[]
  /** How long to let the target service a paste before restoring the pasteboard. */
  settleMs: number
  /** Why this profile is what it is — quoted into the matrix doc. */
  note: string
  /**
   * Set for apps Mull refuses to type into at all. Secure input already blocks
   * most of these, but it is only on while a password field has focus; a
   * credential manager's search box is not a place for a stray transcript.
   */
  refuse?: 'credential-app'
}

const NATIVE: InsertionProfile = {
  chain: ['ax', 'paste'],
  settleMs: 90,
  note: 'Cocoa text system: AX writes land and read back; paste is the safety net.'
}

const CHROMIUM: InsertionProfile = {
  chain: ['paste'],
  settleMs: 280,
  note: 'Chromium/Electron: AX text writes are no-ops or silently dropped; paste needs a long settle.'
}

const TERMINAL: InsertionProfile = {
  chain: ['paste', 'type'],
  settleMs: 120,
  note: 'Terminal emulators expose no writable AX text; ⌘V works, typing is the fallback for TUIs that eat it.'
}

const JAVA: InsertionProfile = {
  chain: ['paste'],
  settleMs: 200,
  note: 'JetBrains/Swing: AX bridge is read-mostly; paste is reliable.'
}

const CREDENTIALS: InsertionProfile = {
  chain: [],
  settleMs: 0,
  refuse: 'credential-app',
  note: 'Password manager — Mull never writes here, secure input or not.'
}

/** The default for an app nobody has classified yet: try the good one, fall back. */
export const DEFAULT_PROFILE: InsertionProfile = {
  chain: ['ax', 'paste'],
  settleMs: 150,
  note: 'Unclassified app: try AX, fall back to paste, and remember what worked.'
}

/** Exact bundle-id matches. */
const BY_BUNDLE_ID: Record<string, InsertionProfile> = {
  // --- Apple / native -------------------------------------------------------
  'com.apple.TextEdit': NATIVE,
  'com.apple.Notes': NATIVE,
  'com.apple.mail': NATIVE,
  'com.apple.MobileSMS': NATIVE,
  'com.apple.Safari': NATIVE,
  'com.apple.Pages': NATIVE,
  'com.apple.Numbers': NATIVE,
  'com.apple.Keynote': NATIVE,
  'com.apple.reminders': NATIVE,
  'com.apple.iCal': NATIVE,
  'com.apple.dt.Xcode': NATIVE,
  'com.apple.finder': NATIVE,
  'com.apple.systempreferences': NATIVE,

  // Native third-party editors and note apps.
  'net.shinyfrog.bear': NATIVE,
  'com.culturedcode.ThingsMac': NATIVE,
  'com.omnigroup.OmniFocus3': NATIVE,
  'com.flexibits.fantastical2.mac': NATIVE,
  'com.sublimetext.4': NATIVE,
  'com.coteditor.CotEditor': NATIVE,
  'dev.zed.Zed': NATIVE,
  'com.apple.ScriptEditor2': NATIVE,

  // --- Chromium / Electron --------------------------------------------------
  'com.google.Chrome': CHROMIUM,
  'com.microsoft.edgemac': CHROMIUM,
  'com.brave.Browser': CHROMIUM,
  'company.thebrowser.Browser': CHROMIUM, // Arc
  'com.vivaldi.Vivaldi': CHROMIUM,
  'com.operasoftware.Opera': CHROMIUM,
  'com.tinyspeck.slackmacgap': CHROMIUM,
  'com.microsoft.VSCode': CHROMIUM,
  'com.visualstudio.code.oss': CHROMIUM,
  'com.hnc.Discord': CHROMIUM,
  'notion.id': CHROMIUM,
  'com.figma.Desktop': CHROMIUM,
  'com.spotify.client': CHROMIUM,
  'md.obsidian': CHROMIUM,
  'com.microsoft.teams2': CHROMIUM,
  'com.readdle.SparkDesktop': CHROMIUM,
  'com.linear': CHROMIUM,
  'com.electron.chatgpt': CHROMIUM,
  'com.openai.chat': CHROMIUM,
  'com.anthropic.claudefordesktop': CHROMIUM,

  // --- Terminals ------------------------------------------------------------
  'com.apple.Terminal': TERMINAL,
  'com.googlecode.iterm2': TERMINAL,
  'net.kovidgoyal.kitty': TERMINAL,
  'io.alacritty': TERMINAL,
  'com.mitchellh.ghostty': TERMINAL,
  'dev.warp.Warp-Stable': TERMINAL,

  // --- Credential managers --------------------------------------------------
  'com.1password.1password': CREDENTIALS,
  'com.agilebits.onepassword7': CREDENTIALS,
  'com.apple.keychainaccess': CREDENTIALS,
  'com.bitwarden.desktop': CREDENTIALS,
  'com.dashlane.Dashlane': CREDENTIALS
}

/** Prefix matches, tried in order when the exact id misses. */
const BY_PREFIX: Array<[string, InsertionProfile]> = [
  // ToDesktop ships Electron apps under generated ids (Cursor, Linear, …).
  ['com.todesktop.', CHROMIUM],
  ['com.jetbrains.', JAVA],
  ['com.google.android.studio', JAVA],
  ['org.eclipse.', JAVA],
  ['com.apple.', NATIVE]
]

export function insertionProfile(bundleId: string | null | undefined): InsertionProfile {
  if (!bundleId) return DEFAULT_PROFILE
  const exact = BY_BUNDLE_ID[bundleId]
  if (exact) return exact
  for (const [prefix, profile] of BY_PREFIX) {
    if (bundleId.startsWith(prefix)) return profile
  }
  return DEFAULT_PROFILE
}

/** Every classified app, for docs/INSERTION-MATRIX.md and the settings UI. */
export function knownProfiles(): Array<{ bundleId: string; profile: InsertionProfile }> {
  return Object.entries(BY_BUNDLE_ID)
    .map(([bundleId, profile]) => ({ bundleId, profile }))
    .sort((a, b) => a.bundleId.localeCompare(b.bundleId))
}
