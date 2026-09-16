import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '@shared/settings'

/**
 * Settings — a small JSON file, read once and written on every change.
 *
 * The only interesting requirement is that it can never take the app down. A
 * settings file is the easiest thing in a Mac app to end up corrupt: a crash
 * mid-write, a half-synced backup, a hand edit. So a file that does not parse
 * is *reported and replaced by defaults*, never thrown — Mull starting with
 * the wrong theme is a nuisance, Mull not starting is a broken instrument.
 *
 * Writes go through a temp file and a rename, which is atomic on APFS, so the
 * corrupt case stays hypothetical rather than something we cause ourselves.
 */

export interface SettingsStoreOptions {
  path: string
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export class SettingsStore {
  private current: Settings
  private readonly log: NonNullable<SettingsStoreOptions['log']>

  constructor(private readonly options: SettingsStoreOptions) {
    this.log = options.log ?? (() => {})
    this.current = this.read()
  }

  get(): Settings {
    return this.current
  }

  /**
   * Merge a patch and persist. Returns the new settings so callers never have
   * to guess what the store made of their input — an unknown key or a bad
   * value is dropped by the schema, not honoured silently.
   */
  set(patch: Partial<Settings>): Settings {
    const merged = SettingsSchema.safeParse({ ...this.current, ...patch })
    if (!merged.success) {
      this.log('warn', 'settings: rejected an invalid change', merged.error.issues)
      return this.current
    }
    this.current = merged.data
    this.write(this.current)
    return this.current
  }

  private read(): Settings {
    if (!existsSync(this.options.path)) return { ...DEFAULT_SETTINGS }
    try {
      const parsed = SettingsSchema.safeParse(JSON.parse(readFileSync(this.options.path, 'utf8')))
      if (parsed.success) return parsed.data
      // Partially valid is still usable: the schema fills every missing or bad
      // field with its default rather than discarding the whole file.
      this.log('warn', 'settings: file had invalid fields; defaults used for those', parsed.error.issues)
      return { ...DEFAULT_SETTINGS }
    } catch (err) {
      this.log('error', 'settings: unreadable file; starting from defaults', err)
      return { ...DEFAULT_SETTINGS }
    }
  }

  private write(settings: Settings): void {
    try {
      mkdirSync(dirname(this.options.path), { recursive: true })
      const temp = `${this.options.path}.tmp`
      writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      renameSync(temp, this.options.path) // atomic on APFS
    } catch (err) {
      // In-memory settings still apply for this run; they just will not persist.
      this.log('error', 'settings: could not be saved', err)
    }
  }
}
