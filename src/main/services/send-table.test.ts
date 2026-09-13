import { describe, expect, it } from 'vitest'
import { knownSendChords, sendChord } from './send-table'

describe('sendChord', () => {
  it('knows the chat apps where Return sends', () => {
    expect(sendChord('com.tinyspeck.slackmacgap')).toMatchObject({ key: 'return', modifiers: [] })
    expect(sendChord('com.hnc.Discord')?.key).toBe('return')
    expect(sendChord('com.apple.MobileSMS')?.key).toBe('return')
    expect(sendChord('com.microsoft.teams2')?.key).toBe('return')
  })

  it('uses ⌘⇧D for Mail rather than Return', () => {
    const chord = sendChord('com.apple.mail')
    expect(chord).toMatchObject({ key: 'd', modifiers: ['cmd', 'shift'], hint: '⌘⇧D' })
  })

  /**
   * The rule the whole table exists to enforce. Everything below is one case of
   * "Mull does not know, so Mull does not press anything".
   */
  it('refuses everything it has not been told about', () => {
    expect(sendChord('com.apple.TextEdit')).toBeNull()
    expect(sendChord('com.google.Chrome')).toBeNull()
    expect(sendChord('com.acme.NewChatApp')).toBeNull()
    expect(sendChord(null)).toBeNull()
    expect(sendChord(undefined)).toBeNull()
    expect(sendChord('')).toBeNull()
  })

  /**
   * No prefix matching, deliberately — unlike `insertionProfile`. `com.apple.`
   * covering Mail would also cover TextEdit, Notes and Finder, and "belongs to
   * the same vendor" says nothing whatsoever about whether Return sends.
   */
  it('does not generalise from one app in a family to the rest', () => {
    expect(sendChord('com.apple.mail')).not.toBeNull()
    expect(sendChord('com.apple.Notes')).toBeNull()
    expect(sendChord('com.apple.mail.extra')).toBeNull()
  })

  it('lists what it knows, sorted, for the settings pane', () => {
    const known = knownSendChords()
    expect(known.length).toBeGreaterThan(0)
    expect(known.map((entry) => entry.bundleId)).toEqual(
      [...known.map((entry) => entry.bundleId)].sort((a, b) => a.localeCompare(b))
    )
    for (const entry of known) expect(entry.chord.note).not.toHaveLength(0)
  })
})
