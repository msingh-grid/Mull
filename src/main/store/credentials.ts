import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EngineCredentials } from '@shared/engine'

/**
 * The two secrets Mull can hold, encrypted by the OS.
 *
 * `safeStorage` hands the key to the login keychain, so what lands on disk is
 * ciphertext only this user on this Mac can read. Three rules keep it that
 * way, and each is a refusal:
 *
 *  1. **No encryption, no storage.** If `safeStorage` says it cannot encrypt —
 *     a Linux session with no keyring, a keychain that will not unlock — the
 *     store throws instead of falling back to plaintext. A token sitting
 *     readable in Application Support would be a worse outcome than the edit
 *     lane being unavailable, which is all the user loses.
 *  2. **Nothing is logged.** Not the value, not a prefix, not a length. The
 *     log file is the first thing anyone attaches to a bug report.
 *  3. **Nothing crosses the bridge.** Renderers learn `hasSubscription` and
 *     `hasApiKey` and nothing else; the settings window can tell you a token
 *     is saved, and cannot tell you what it is.
 *
 * A file that will not decrypt is treated as absent rather than fatal — which
 * is the honest reading, because a keychain that changed underneath us means
 * the secret really is gone.
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface CredentialsStoreOptions {
  path: string
  safeStorage: SafeStorageLike
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export type CredentialKind = 'subscription' | 'api-key'

interface StoredFile {
  version: 1
  /** base64 of the safeStorage ciphertext, or absent. */
  oauthToken?: string
  apiKey?: string
}

export class CredentialsStore {
  private current: EngineCredentials
  private readonly log: NonNullable<CredentialsStoreOptions['log']>

  constructor(private readonly options: CredentialsStoreOptions) {
    this.log = options.log ?? ((): void => {})
    this.current = this.read()
  }

  /** Main-process only. Never return this to a renderer. */
  get(): EngineCredentials {
    return this.current
  }

  /** What a renderer is allowed to know. */
  presence(): { hasSubscription: boolean; hasApiKey: boolean } {
    return {
      hasSubscription: this.current.oauthToken !== null,
      hasApiKey: this.current.apiKey !== null
    }
  }

  /** Save a secret, or sign out of one by passing null. Throws if it cannot. */
  set(kind: CredentialKind, secret: string | null): void {
    const value = secret?.trim() || null
    if (value !== null && !this.options.safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'macOS won’t let Mull encrypt secrets right now, so it won’t store one. Unlock your login keychain and try again.'
      )
    }

    this.current =
      kind === 'subscription'
        ? { ...this.current, oauthToken: value }
        : { ...this.current, apiKey: value }
    this.write()
  }

  private read(): EngineCredentials {
    const empty: EngineCredentials = { oauthToken: null, apiKey: null }
    if (!existsSync(this.options.path)) return empty

    try {
      const file = JSON.parse(readFileSync(this.options.path, 'utf8')) as StoredFile
      return {
        oauthToken: this.decrypt(file.oauthToken),
        apiKey: this.decrypt(file.apiKey)
      }
    } catch (err) {
      this.log('warn', 'credentials: unreadable; treating as signed out', err)
      return empty
    }
  }

  private decrypt(encoded: string | undefined): string | null {
    if (!encoded) return null
    if (!this.options.safeStorage.isEncryptionAvailable()) return null
    try {
      const value = this.options.safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      return value || null
    } catch (err) {
      // The keychain changed under us: the secret is genuinely gone, and
      // saying so is better than an edit lane that fails mysteriously.
      this.log('warn', 'credentials: a stored secret could not be decrypted', err)
      return null
    }
  }

  private write(): void {
    const { oauthToken, apiKey } = this.current
    if (oauthToken === null && apiKey === null) {
      try {
        if (existsSync(this.options.path)) unlinkSync(this.options.path)
      } catch (err) {
        this.log('warn', 'credentials: could not remove the file', err)
      }
      return
    }

    const file: StoredFile = { version: 1 }
    if (oauthToken !== null) {
      file.oauthToken = this.options.safeStorage.encryptString(oauthToken).toString('base64')
    }
    if (apiKey !== null) {
      file.apiKey = this.options.safeStorage.encryptString(apiKey).toString('base64')
    }

    mkdirSync(dirname(this.options.path), { recursive: true })
    const temp = `${this.options.path}.tmp`
    // 0600 on both: the ciphertext is not a secret, but there is no reason for
    // anything else on the machine to be able to read it either.
    writeFileSync(temp, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.options.path) // atomic on APFS
  }
}
