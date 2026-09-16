/**
 * The narrow slice of SQLite the stores actually use.
 *
 * Two implementations satisfy it without either side knowing: `better-sqlite3`
 * in the app (compiled against Electron's ABI by `npm run rebuild:native`), and
 * node's built-in `node:sqlite` in tests. That is the point — a store tested
 * through this interface never depends on a native module matching the runtime
 * that happens to be executing the test suite.
 *
 * Positional `?` parameters only: the two drivers disagree about the spelling of
 * named parameters, and this is not an argument worth having in every query.
 */

export interface SqlStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

/**
 * Open the app's database with better-sqlite3.
 *
 * Required lazily so that importing a store under plain node (vitest, scripts/)
 * does not drag in a native module built for Electron.
 */
export function openSqlite(path: string): SqlDatabase {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as new (
    path: string
  ) => SqlDatabase & { pragma(s: string): unknown }
  const db = new Database(path)
  // WAL survives a hard quit with the journal intact; NORMAL is the right
  // durability trade for a log nobody bills against.
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  return db
}
