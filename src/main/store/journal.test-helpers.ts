import { DatabaseSync } from 'node:sqlite'
import type { SqlDatabase } from './sqlite'

/**
 * An in-memory database for tests, built on node's own SQLite rather than
 * `better-sqlite3`.
 *
 * The app's copy of better-sqlite3 is compiled against Electron's ABI
 * (`npm run rebuild:native`), so requiring it from vitest is a coin flip on
 * NODE_MODULE_VERSION. `node:sqlite` is always there, always matches, and
 * speaks the same `prepare/run/get/all` dialect the `SqlDatabase` interface
 * narrows to — which is the whole reason that interface exists.
 */
export function memoryDatabase(): SqlDatabase {
  const db = new DatabaseSync(':memory:')
  return db as unknown as SqlDatabase
}
