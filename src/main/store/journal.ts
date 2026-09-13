import { randomUUID } from 'node:crypto'
import type { Intent, JournalDraft, JournalEntry, JournalStatus } from '@shared/types'
import type { InsertionStrategy } from '@shared/sidecar-api'
import type { SqlDatabase } from './sqlite'

/**
 * Every change Mull makes, written down.
 *
 * The journal is the pillar the product promise rests on: "you can always see
 * what it did, and take it back". So two rules hold here:
 *
 *  - **Write the failures too.** A journal that only records successes teaches
 *    the user to distrust it the first time something silently doesn't happen.
 *    Failed and refused actions are rows, with their reason.
 *  - **`undoable` is earned, not assumed.** An entry is undoable only when the
 *    sidecar read back what it wrote (`verified === true`) and told us where the
 *    caret ended up. Everything else is a record, not an offer.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL,
  summary       TEXT NOT NULL,
  app_bundle_id TEXT,
  app_name      TEXT,
  before_text   TEXT,
  after_text    TEXT,
  strategy      TEXT,
  verified      INTEGER,
  caret         INTEGER,
  undoable      INTEGER NOT NULL DEFAULT 0,
  undone_at     INTEGER,
  intent        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_at ON entries (at DESC);
CREATE INDEX IF NOT EXISTS entries_undoable ON entries (undoable, at DESC);
`

interface Row {
  id: string
  at: number
  kind: string
  status: string
  summary: string
  app_bundle_id: string | null
  app_name: string | null
  before_text: string | null
  after_text: string | null
  strategy: string | null
  verified: number | null
  caret: number | null
  undoable: number
  undone_at: number | null
  intent: string
}

export class JournalStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => number = () => Date.now()
  ) {
    this.db.exec(SCHEMA)
  }

  append(draft: JournalDraft): JournalEntry {
    const entry: JournalEntry = {
      ...draft,
      id: draft.id ?? randomUUID(),
      at: draft.at ?? this.now(),
      undoneAt: null,
      // Belt and braces: a caller that asks for an undoable entry without the
      // evidence to support one does not get it.
      undoable: draft.undoable && draft.verified === true && draft.caret !== null
    }

    this.db
      .prepare(
        `INSERT INTO entries
           (id, at, kind, status, summary, app_bundle_id, app_name, before_text, after_text,
            strategy, verified, caret, undoable, undone_at, intent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.id,
        entry.at,
        entry.intent.kind,
        entry.status,
        entry.summary,
        entry.app?.bundleId ?? null,
        entry.app?.name ?? null,
        entry.before,
        entry.after,
        entry.strategyUsed,
        entry.verified === null ? null : entry.verified ? 1 : 0,
        entry.caret,
        entry.undoable ? 1 : 0,
        null,
        JSON.stringify(entry.intent)
      )

    return entry
  }

  get(id: string): JournalEntry | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Row | undefined
    return row ? toEntry(row) : null
  }

  recent(limit = 50): JournalEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM entries ORDER BY at DESC, id DESC LIMIT ?')
      .all(limit) as Row[]
    return rows.map(toEntry)
  }

  /**
   * The entry ⌥Z would reverse: the newest applied, still-undoable one.
   * Scoped to an app when given, because undo only ever makes sense where the
   * text actually is.
   */
  lastUndoable(bundleId?: string | null): JournalEntry | null {
    const row = bundleId
      ? (this.db
          .prepare(
            `SELECT * FROM entries
              WHERE undoable = 1 AND undone_at IS NULL AND status = 'applied'
                AND app_bundle_id = ?
              ORDER BY at DESC, id DESC LIMIT 1`
          )
          .get(bundleId) as Row | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM entries
              WHERE undoable = 1 AND undone_at IS NULL AND status = 'applied'
              ORDER BY at DESC, id DESC LIMIT 1`
          )
          .get() as Row | undefined)
    return row ? toEntry(row) : null
  }

  markUndone(id: string, at = this.now()): void {
    this.db
      .prepare(`UPDATE entries SET status = 'undone', undoable = 0, undone_at = ? WHERE id = ?`)
      .run(at, id)
  }

  /** Give up on undoing this one (the document moved on) without undoing it. */
  markNotUndoable(id: string): void {
    this.db.prepare('UPDATE entries SET undoable = 0 WHERE id = ?').run(id)
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }
    return row.n
  }

  /**
   * Keep the newest `keep` entries. The journal is a working record, not an
   * archive of everything the user has ever said — and it holds the text of
   * every dictation, which is reason enough not to grow it forever.
   */
  prune(keep = 2_000): number {
    const before = this.count()
    this.db
      .prepare(
        `DELETE FROM entries WHERE id NOT IN (
           SELECT id FROM entries ORDER BY at DESC, id DESC LIMIT ?
         )`
      )
      .run(keep)
    return before - this.count()
  }

  close(): void {
    this.db.close()
  }
}

function toEntry(row: Row): JournalEntry {
  let intent: Intent
  try {
    intent = JSON.parse(row.intent) as Intent
  } catch {
    intent = { kind: 'dictate', text: row.after_text ?? '' }
  }
  return {
    id: row.id,
    at: row.at,
    intent,
    app: row.app_bundle_id
      ? { bundleId: row.app_bundle_id, name: row.app_name ?? row.app_bundle_id }
      : null,
    before: row.before_text,
    after: row.after_text,
    strategyUsed: (row.strategy as InsertionStrategy | null) ?? null,
    status: row.status as JournalStatus,
    summary: row.summary,
    verified: row.verified === null ? null : row.verified === 1,
    caret: row.caret,
    undoable: row.undoable === 1,
    undoneAt: row.undone_at
  }
}
