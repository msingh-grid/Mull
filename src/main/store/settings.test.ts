import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { SettingsStore } from './settings'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mull-settings-'))
  path = join(dir, 'settings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('SettingsStore', () => {
  it('starts from defaults when there is no file, without creating one', () => {
    const store = new SettingsStore({ path })
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(path)).toBe(false)
  })

  it('round-trips a change through the file', () => {
    new SettingsStore({ path }).set({ theme: 'dark' })
    expect(new SettingsStore({ path }).get().theme).toBe('dark')
  })

  it('round-trips the Codex lane without erasing Claude preferences', () => {
    new SettingsStore({ path }).set({
      engine: 'codex-subscription',
      editModel: 'haiku',
      codexEditModel: 'sol',
      codexClassifierModel: 'luna',
      agentLoop: true
    })
    expect(new SettingsStore({ path }).get()).toMatchObject({
      engine: 'codex-subscription',
      editModel: 'haiku',
      codexEditModel: 'sol',
      codexClassifierModel: 'luna',
      agentLoop: true
    })
  })

  it('migrates old settings to independent Terra defaults without changing Claude choices', () => {
    writeFileSync(
      path,
      JSON.stringify({ engine: 'codex-subscription', editModel: 'haiku', agentLoop: true }),
      'utf8'
    )
    expect(new SettingsStore({ path }).get()).toMatchObject({
      engine: 'codex-subscription',
      editModel: 'haiku',
      codexEditModel: 'terra',
      codexClassifierModel: 'terra',
      agentLoop: true
    })
  })

  it('merges rather than replaces', () => {
    const store = new SettingsStore({ path })
    store.set({ theme: 'dark' })
    store.set({ hotkey: 'fn' })
    expect(store.get()).toMatchObject({ theme: 'dark', hotkey: 'fn' })
  })

  it('refuses an invalid value and keeps the current one', () => {
    const store = new SettingsStore({ path })
    const after = store.set({ theme: 'chartreuse' } as never)
    expect(after.theme).toBe('system')
    expect(store.get().theme).toBe('system')
  })

  it('drops unknown keys instead of persisting them', () => {
    const store = new SettingsStore({ path })
    store.set({ nonsense: true } as never)
    expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty('nonsense')
  })

  it('survives a corrupt file rather than taking the app down with it', () => {
    writeFileSync(path, '{not json at all', 'utf8')
    const store = new SettingsStore({ path })
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    // And it recovers: the next write lays down a valid file.
    store.set({ theme: 'light' })
    expect(new SettingsStore({ path }).get().theme).toBe('light')
  })

  it('falls back to defaults for a file with wrong-typed fields', () => {
    writeFileSync(path, JSON.stringify({ theme: 42, hotkey: 'fn' }), 'utf8')
    expect(new SettingsStore({ path }).get()).toEqual(DEFAULT_SETTINGS)
  })

  it('reports rather than throws when the file cannot be written', () => {
    const problems: unknown[] = []
    // A path whose parent is a file, not a directory.
    writeFileSync(join(dir, 'blocker'), 'x', 'utf8')
    const store = new SettingsStore({
      path: join(dir, 'blocker', 'settings.json'),
      log: (level, message) => problems.push([level, message])
    })
    expect(() => store.set({ theme: 'dark' })).not.toThrow()
    expect(store.get().theme).toBe('dark') // applies for this run
    expect(problems.length).toBeGreaterThan(0)
  })

  it('treats onboarding as never completed until it is stamped', () => {
    const store = new SettingsStore({ path })
    expect(store.get().onboardingCompletedAt).toBeNull()
    store.set({ onboardingCompletedAt: 1_700_000_000_000 })
    expect(new SettingsStore({ path }).get().onboardingCompletedAt).toBe(1_700_000_000_000)
  })
})
