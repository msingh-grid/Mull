import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialsStore, type SafeStorageLike } from './credentials'

/**
 * A stand-in for the OS keychain. Reversible on purpose — the test needs to
 * prove the plaintext is *not* what lands on disk, which means it has to be
 * able to tell the difference.
 */
function fakeSafeStorage(available = true): SafeStorageLike & { available: boolean } {
  const store = {
    available,
    isEncryptionAvailable: () => store.available,
    encryptString: (plain: string) => Buffer.from(`keychain:${plain}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const value = encrypted.toString('utf8')
      if (!value.startsWith('keychain:')) throw new Error('not ours')
      return value.slice('keychain:'.length)
    }
  }
  return store
}

const dirs: string[] = []

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mull-credentials-'))
  dirs.push(dir)
  return join(dir, 'credentials.json')
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('CredentialsStore', () => {
  it('round-trips a secret without writing it in the clear', () => {
    const path = tempPath()
    const safeStorage = fakeSafeStorage()
    const store = new CredentialsStore({ path, safeStorage })
    store.set('subscription', 'sk-ant-oat-SECRET')

    const onDisk = readFileSync(path, 'utf8')
    expect(onDisk).not.toContain('sk-ant-oat-SECRET')

    const reopened = new CredentialsStore({ path, safeStorage })
    expect(reopened.get().oauthToken).toBe('sk-ant-oat-SECRET')
  })

  it('keeps the two secrets apart', () => {
    const path = tempPath()
    const safeStorage = fakeSafeStorage()
    const store = new CredentialsStore({ path, safeStorage })
    store.set('subscription', 'token')
    store.set('api-key', 'key')

    const reopened = new CredentialsStore({ path, safeStorage })
    expect(reopened.get()).toEqual({ oauthToken: 'token', apiKey: 'key' })
    expect(reopened.presence()).toEqual({ hasSubscription: true, hasApiKey: true })
  })

  it('tells a renderer whether a secret exists and nothing more', () => {
    const store = new CredentialsStore({ path: tempPath(), safeStorage: fakeSafeStorage() })
    store.set('api-key', 'sk-ant-SECRET')
    // The whole surface a renderer sees — assert it by shape, so a field added
    // here later has to be a deliberate decision.
    expect(Object.keys(store.presence()).sort()).toEqual(['hasApiKey', 'hasSubscription'])
    expect(JSON.stringify(store.presence())).not.toContain('SECRET')
  })

  it('refuses to store a secret it cannot encrypt', () => {
    const path = tempPath()
    const safeStorage = fakeSafeStorage(false)
    const store = new CredentialsStore({ path, safeStorage })

    // Plaintext on disk would be worse than the edit lane being unavailable,
    // which is all that is lost by refusing.
    expect(() => store.set('subscription', 'token')).toThrow(/won’t store/)
    expect(existsSync(path)).toBe(false)
  })

  it('signs out by removing the file once nothing is left', () => {
    const path = tempPath()
    const safeStorage = fakeSafeStorage()
    const store = new CredentialsStore({ path, safeStorage })
    store.set('subscription', 'token')
    store.set('subscription', null)

    expect(existsSync(path)).toBe(false)
    expect(store.presence()).toEqual({ hasSubscription: false, hasApiKey: false })
  })

  it('keeps the other secret when one is signed out', () => {
    const path = tempPath()
    const safeStorage = fakeSafeStorage()
    const store = new CredentialsStore({ path, safeStorage })
    store.set('subscription', 'token')
    store.set('api-key', 'key')
    store.set('subscription', null)

    expect(new CredentialsStore({ path, safeStorage }).get()).toEqual({
      oauthToken: null,
      apiKey: 'key'
    })
  })

  it('writes the file 0600', () => {
    const path = tempPath()
    new CredentialsStore({ path, safeStorage: fakeSafeStorage() }).set('api-key', 'key')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('treats a secret it can no longer decrypt as gone, not as fatal', () => {
    // What a keychain reset or a restored-from-backup Mac looks like.
    const path = tempPath()
    writeFileSync(path, JSON.stringify({ version: 1, oauthToken: 'bm90LW91cnM=' }))

    const store = new CredentialsStore({ path, safeStorage: fakeSafeStorage() })
    expect(store.get().oauthToken).toBeNull()
    expect(store.presence().hasSubscription).toBe(false)
  })

  it('starts empty rather than throwing on a corrupt file', () => {
    const path = tempPath()
    writeFileSync(path, 'not json at all')
    expect(new CredentialsStore({ path, safeStorage: fakeSafeStorage() }).get()).toEqual({
      oauthToken: null,
      apiKey: null
    })
  })

  it('treats blank input as signing out', () => {
    const path = tempPath()
    const safeStorage = fakeSafeStorage()
    const store = new CredentialsStore({ path, safeStorage })
    store.set('api-key', '   ')
    expect(store.presence().hasApiKey).toBe(false)
  })
})
