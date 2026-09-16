import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE, insertionProfile, knownProfiles } from './insertion-table'

describe('insertionProfile', () => {
  it('prefers the invisible strategy in apps that support it', () => {
    expect(insertionProfile('com.apple.TextEdit').chain[0]).toBe('ax')
    expect(insertionProfile('com.apple.mail').chain).toContain('paste')
  })

  it('skips AX entirely for Chromium and Electron targets', () => {
    for (const id of ['com.tinyspeck.slackmacgap', 'com.microsoft.VSCode', 'notion.id']) {
      expect(insertionProfile(id).chain, id).not.toContain('ax')
    }
  })

  it('gives Electron targets a longer paste settle than Cocoa ones', () => {
    expect(insertionProfile('com.tinyspeck.slackmacgap').settleMs).toBeGreaterThan(
      insertionProfile('com.apple.TextEdit').settleMs
    )
  })

  it('falls back to typing in terminals', () => {
    expect(insertionProfile('com.googlecode.iterm2').chain).toEqual(['paste', 'type'])
  })

  it('refuses password managers outright', () => {
    const profile = insertionProfile('com.1password.1password')
    expect(profile.refuse).toBe('credential-app')
    expect(profile.chain).toHaveLength(0)
  })

  it('matches ToDesktop and JetBrains apps by prefix', () => {
    expect(insertionProfile('com.todesktop.230313mzl4w4u92').chain).toEqual(['paste'])
    expect(insertionProfile('com.jetbrains.intellij').chain).toEqual(['paste'])
  })

  it('prefers an exact match over a prefix one', () => {
    // com.apple.* is a NATIVE prefix, but Terminal needs the terminal profile.
    expect(insertionProfile('com.apple.Terminal').chain).toEqual(['paste', 'type'])
  })

  it('falls back to the default for unknown and missing ids', () => {
    expect(insertionProfile('com.example.unheard-of')).toBe(DEFAULT_PROFILE)
    expect(insertionProfile(null)).toBe(DEFAULT_PROFILE)
    expect(insertionProfile(undefined)).toBe(DEFAULT_PROFILE)
    expect(insertionProfile('')).toBe(DEFAULT_PROFILE)
  })

  it('documents why every classified app is classified', () => {
    const profiles = knownProfiles()
    expect(profiles.length).toBeGreaterThan(20)
    for (const { bundleId, profile } of profiles) {
      expect(profile.note, bundleId).not.toHaveLength(0)
    }
  })
})
