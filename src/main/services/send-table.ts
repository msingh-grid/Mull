import type { SidecarParams } from '@shared/sidecar-api'

type KeyChordParams = SidecarParams<'keyChord'>

/**
 * Which keystroke sends a message, per app.
 *
 * Shaped like `insertion-table.ts`, with one difference that is the whole
 * point: **an unknown app has no send chord, and Mull offers no send at all.**
 *
 * Insertion can afford a default because a wrong guess there is visible and
 * undoable — the text lands in the wrong place and ⌥Z takes it back. Sending is
 * neither. A Return pressed into someone else's window either does nothing, or
 * does something nobody can take back, and there is no third outcome worth
 * gambling on. So this table is a list of chords that are *documented public
 * interface* of the app in question, and everything not on it gets the honest
 * answer: press it yourself.
 *
 * Two consequences worth saying out loud:
 *
 *  - Adding a row here is a safety decision, not a convenience one. The bar is
 *    that the chord is the app's own advertised way to send, stable across
 *    versions, and does nothing destructive if the composer happens to be empty.
 *  - Apps where Return inserts a newline instead of sending (because the user
 *    changed the preference) will simply fail the read-back check, and the HUD
 *    says the send did not go through. A wrong row here degrades to a sentence,
 *    never to a surprise.
 */

export interface SendChord {
  /** Passed straight to the sidecar's `keyChord` verb. */
  key: KeyChordParams['key']
  modifiers: NonNullable<KeyChordParams['modifiers']>
  /** Printed on the card's second button, e.g. '⌘⏎'. */
  hint: string
  /** Why this app is on the list — quoted into docs and the settings pane. */
  note: string
}

/** Return, the near-universal chat convention. */
const RETURN: SendChord = {
  key: 'return',
  modifiers: [],
  hint: '⏎',
  note: 'Return sends in the message composer; Shift-Return is the newline.'
}

/** ⌘⇧D — Mail's send, and the same chord in several mail clients. */
const MAIL: SendChord = {
  key: 'd',
  modifiers: ['cmd', 'shift'],
  hint: '⌘⇧D',
  note: 'Mail sends with ⌘⇧D from anywhere in the compose window.'
}

const BY_BUNDLE_ID: Record<string, SendChord> = {
  'com.tinyspeck.slackmacgap': RETURN,
  'com.hnc.Discord': RETURN,
  'com.apple.MobileSMS': RETURN,
  'com.microsoft.teams2': RETURN,
  'com.apple.mail': MAIL,
  'com.readdle.SparkDesktop': MAIL
}

/**
 * The chord that sends in this app, or null when Mull does not know one.
 *
 * Null is the common answer and the safe one. There is no default and no
 * prefix matching: `com.apple.` covering Mail would also cover TextEdit, and
 * "the family this app belongs to" says nothing about whether Return sends.
 */
export function sendChord(bundleId: string | null | undefined): SendChord | null {
  if (!bundleId) return null
  return BY_BUNDLE_ID[bundleId] ?? null
}

/** Every app Mull can send in, for the settings pane and docs. */
export function knownSendChords(): Array<{ bundleId: string; chord: SendChord }> {
  return Object.entries(BY_BUNDLE_ID)
    .map(([bundleId, chord]) => ({ bundleId, chord }))
    .sort((a, b) => a.bundleId.localeCompare(b.bundleId))
}
