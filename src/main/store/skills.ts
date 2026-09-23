import { randomUUID } from 'node:crypto'
import {
  MAX_SKILLS_PER_APP,
  SAME_LESSON,
  SKILLS_SHOWN,
  normalizeSkill,
  skillOverlap,
  type LearnedSkill,
  type SkillRecord
} from '@shared/skills'
import type { SqlDatabase } from './sqlite'

/**
 * What Mull has learned about driving each application.
 *
 * The journal is the record of what happened; this is the little that survived
 * it. One row is one clause, scoped to one bundle id, with the counters that
 * decide whether it is still worth showing.
 *
 * ### Why it is rows rather than a file
 *
 * A markdown file per app would be more transparent and is the wrong shape for
 * three reasons that all point the same way. Free prose cannot be deduped, so
 * the same lesson accumulates; it cannot be scored, so a lesson that has only
 * ever ridden along with failures stays forever; and it has no bound, so the
 * thing that ends up in a prompt is whatever a model felt like writing. Rows
 * with a unique index, two counters and a cap answer all three, and the
 * settings pane is what keeps the transparency.
 *
 * ### The counters, and what they do not claim
 *
 * `wins` and `losses` do not measure whether a lesson is true — nothing here
 * can know that. They count the runs that were *shown* it and how those ended.
 * That is a weak signal deliberately used weakly: it orders the list and it
 * drops a clause that has ridden along with several failures and no successes.
 * It never promotes a lesson to something stronger than a hint.
 *
 * Lives in `journal.db` beside the journal and the turns, for the same reason
 * they share it: one file to open, one to back up, one to delete.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  id           TEXT PRIMARY KEY,
  bundle_id    TEXT NOT NULL,
  app_name     TEXT,
  kind         TEXT NOT NULL,
  text         TEXT NOT NULL,
  norm         TEXT NOT NULL,
  wins         INTEGER NOT NULL DEFAULT 0,
  losses       INTEGER NOT NULL DEFAULT 0,
  uses         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  from_group   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS skills_norm ON skills (bundle_id, kind, norm);
CREATE INDEX IF NOT EXISTS skills_app ON skills (bundle_id);
`

interface Row {
  id: string
  bundle_id: string
  app_name: string | null
  kind: string
  text: string
  wins: number
  losses: number
  uses: number
  created_at: number
  last_used_at: number | null
}

/**
 * When a clause has earned its way out.
 *
 * Three runs that were shown it and did not arrive, and none that did. Not a
 * proof that the lesson is wrong — the run may have failed for reasons nothing
 * to do with it — which is why the threshold is not one. What it catches is the
 * clause that is *never* present when things go right, and the cost of being
 * wrong about one is that Mull re-learns it the next time it is true.
 */
const LOSSES_BEFORE_FORGETTING = 3

export interface SkillStoreOptions {
  now?: () => number
  /** How many to keep per application. See `MAX_SKILLS_PER_APP`. */
  perApp?: number
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export class SkillStore {
  private readonly now: () => number
  private readonly perApp: number
  private readonly log: NonNullable<SkillStoreOptions['log']>

  constructor(
    private readonly db: SqlDatabase,
    options: SkillStoreOptions = {}
  ) {
    this.db.exec(SCHEMA)
    this.now = options.now ?? ((): number => Date.now())
    this.perApp = options.perApp ?? MAX_SKILLS_PER_APP
    this.log = options.log ?? ((): void => {})
  }

  /**
   * Write down what a run taught, if anything.
   *
   * A lesson that is already known is a vote for it rather than a second row:
   * the counter goes up and the text stays as it was first written. That is the
   * one place the dedupe is doing real work — a model asked the same question
   * after ten runs in Slack will produce ten near-identical clauses, and ten
   * rows saying the same thing is how the prompt fills with one idea.
   *
   * Never throws. A lesson that could not be saved is a lesson not learned,
   * which is where every run started.
   */
  learn(
    app: { bundleId: string; name?: string | null },
    items: readonly LearnedSkill[],
    fromGroup?: string | null
  ): void {
    if (items.length === 0) return
    try {
      for (const item of items) {
        const norm = normalizeSkill(item.text)
        if (!norm) continue
        const existing = this.same(app.bundleId, item)
        if (existing) {
          // Learned again. Worth a point, and worth nothing else — rewriting the
          // text would mean the clause a user read in Settings yesterday is not
          // the clause that is in the prompt today.
          this.db.prepare('UPDATE skills SET wins = wins + 1 WHERE id = ?').run(existing)
          continue
        }
        this.db
          .prepare(
            `INSERT INTO skills
               (id, bundle_id, app_name, kind, text, norm, wins, losses, uses, created_at, last_used_at, from_group)
             VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, NULL, ?)`
          )
          .run(
            randomUUID(),
            app.bundleId,
            app.name ?? null,
            item.kind,
            item.text,
            norm,
            this.now(),
            fromGroup ?? null
          )
      }
      this.prune(app.bundleId)
    } catch (err) {
      this.log('warn', 'skills: could not write down what the run learned', err)
    }
  }

  /**
   * Is this lesson already in the notebook, in any wording?
   *
   * Two passes, cheap first. The unique index catches a note re-punctuated or
   * re-cased; the overlap check catches one re-worded, which is the common case
   * and the one that was quietly filling the table. A model asked twice what it
   * learned in Slack writes the same fact two ways and shares no long substring
   * — see `skillOverlap`.
   *
   * Scoped to the same `kind` as well as the same app, because a `do` and an
   * `avoid` built from the same nouns are opposite advice, not one lesson.
   */
  private same(bundleId: string, item: LearnedSkill): string | null {
    const norm = normalizeSkill(item.text)
    const exact = this.db
      .prepare('SELECT id FROM skills WHERE bundle_id = ? AND kind = ? AND norm = ?')
      .get(bundleId, item.kind, norm) as { id: string } | undefined
    if (exact) return exact.id

    const rows = this.db
      .prepare('SELECT id, text FROM skills WHERE bundle_id = ? AND kind = ?')
      .all(bundleId, item.kind) as Array<{ id: string; text: string }>
    for (const row of rows) {
      if (skillOverlap(row.text, item.text) >= SAME_LESSON) return row.id
    }
    return null
  }

  /**
   * What to show a run that is about to start in this application.
   *
   * Ordered by score and then by how recently it was used, which puts the
   * clauses that have actually been present when things went well at the top —
   * and means the tail of the list is what gets cut when the cap bites.
   */
  forApp(bundleId: string | null | undefined, limit = SKILLS_SHOWN): SkillRecord[] {
    if (!bundleId) return []
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM skills WHERE bundle_id = ?
            ORDER BY (wins - 2 * losses) DESC, last_used_at DESC, created_at DESC
            LIMIT ?`
        )
        .all(bundleId, limit) as Row[]
      return rows.map(toRecord)
    } catch (err) {
      this.log('warn', 'skills: could not read what was learned here', err)
      return []
    }
  }

  /** Everything, newest application first — the settings pane reads this. */
  all(): SkillRecord[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM skills
            ORDER BY app_name IS NULL, app_name ASC,
                     (wins - 2 * losses) DESC, created_at DESC`
        )
        .all() as Row[]
      return rows.map(toRecord)
    } catch (err) {
      this.log('warn', 'skills: could not list what has been learned', err)
      return []
    }
  }

  /** These were put in front of a run. Counted whatever the run then does. */
  markUsed(ids: readonly string[]): void {
    if (ids.length === 0) return
    this.run(
      `UPDATE skills SET uses = uses + 1, last_used_at = ? WHERE id IN (${placeholders(ids)})`,
      [this.now(), ...ids]
    )
  }

  /**
   * How the run that was shown these ended.
   *
   * Applied to every clause the run saw rather than to whichever one it
   * followed, because nothing here knows which one it followed. That is the
   * imprecision the threshold in `LOSSES_BEFORE_FORGETTING` is sized for.
   */
  credit(ids: readonly string[], verdict: 'win' | 'loss'): void {
    if (ids.length === 0) return
    const column = verdict === 'win' ? 'wins' : 'losses'
    this.run(
      `UPDATE skills SET ${column} = ${column} + 1 WHERE id IN (${placeholders(ids)})`,
      [...ids]
    )
    this.forgetExpired()
  }

  /** One row, gone, because the user said so. */
  forget(id: string): void {
    this.run('DELETE FROM skills WHERE id = ?', [id])
  }

  /** Everything, gone. The "forget it all" button in Settings. */
  clear(): void {
    this.run('DELETE FROM skills', [])
  }

  count(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM skills').get() as { n: number }
      return row.n
    } catch {
      return 0
    }
  }

  /**
   * Drop what has stopped earning its place, and cap what is left.
   *
   * Decay first, then the ceiling: a row that is about to be forgotten anyway
   * must not be what pushes a good one out of the list.
   */
  prune(bundleId?: string): void {
    try {
      this.db
        .prepare(
          `DELETE FROM skills
            WHERE losses >= ? AND wins = 0${bundleId ? ' AND bundle_id = ?' : ''}`
        )
        .run(...(bundleId ? [LOSSES_BEFORE_FORGETTING, bundleId] : [LOSSES_BEFORE_FORGETTING]))

      const apps = bundleId
        ? [{ bundle_id: bundleId }]
        : (this.db.prepare('SELECT DISTINCT bundle_id FROM skills').all() as Array<{
            bundle_id: string
          }>)
      for (const app of apps) {
        this.db
          .prepare(
            `DELETE FROM skills WHERE bundle_id = ? AND id NOT IN (
               SELECT id FROM skills WHERE bundle_id = ?
                ORDER BY (wins - 2 * losses) DESC, last_used_at DESC, created_at DESC
                LIMIT ?
             )`
          )
          .run(app.bundle_id, app.bundle_id, this.perApp)
      }
    } catch (err) {
      this.log('warn', 'skills: could not prune', err)
    }
  }

  /** Decay, applied after a credit rather than on a timer. */
  private forgetExpired(): void {
    this.run('DELETE FROM skills WHERE losses >= ? AND wins = 0', [LOSSES_BEFORE_FORGETTING])
  }

  /** Every write goes through here, and none of them may throw. */
  private run(sql: string, params: readonly unknown[]): void {
    try {
      this.db.prepare(sql).run(...params)
    } catch (err) {
      this.log('warn', 'skills: write failed', err)
    }
  }
}

function placeholders(ids: readonly string[]): string {
  return ids.map(() => '?').join(', ')
}

function toRecord(row: Row): SkillRecord {
  return {
    id: row.id,
    bundleId: row.bundle_id,
    appName: row.app_name,
    kind: row.kind === 'avoid' ? 'avoid' : 'do',
    text: row.text,
    wins: row.wins,
    losses: row.losses,
    uses: row.uses,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  }
}
