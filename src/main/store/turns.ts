import type { RecentTurn } from '../services/turns'
import type { SqlDatabase } from './sqlite'

/**
 * The last few things the user said, across a relaunch.
 *
 * `services/turns.ts` is the memory and this is only its disk. That split is
 * deliberate and the direction of it matters: the store never decides what is
 * worth keeping, how many turns there are or when one has gone stale — it is
 * handed whatever the memory currently holds and writes exactly that down.
 * Every bound lives in one file, next to the argument for it.
 *
 * ### Why there is a disk at all now
 *
 * There was not, and the docstring in `services/turns.ts` used to argue that
 * there should not be: everything here leaves the Mac on the next instruction,
 * so a shorter life was a smaller promise to keep. What changed is the shape of
 * a follow-up. "And what about Priya" arrives seconds later and never needed
 * this; "did that ever go through?" arrives after the user has restarted Mull
 * to pick up a new build, and a memory that lives in a process is empty exactly
 * when the question is hardest to answer without it.
 *
 * So the turns survive a quit, and the **TTL is what keeps the old promise** —
 * a row that is read back after its window has passed is dropped on the way in,
 * not merely hidden. See `MULL_TTL` at the call site and the cutoff below.
 *
 * ### Replace-all, rather than a log
 *
 * `save` deletes the table and rewrites it. A turn has no stable identity — the
 * memory clamps it on `open` and fills its outcome in later — so an upsert
 * would need one invented here, and a second retention policy to go with it.
 * Six rows written a couple of times per utterance is cheaper than either.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  seq     INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  said    TEXT NOT NULL,
  route   TEXT NOT NULL,
  app     TEXT,
  outcome TEXT,
  goal    TEXT,
  did     TEXT,
  ended   TEXT
);
`

interface Row {
  seq: number
  at: number
  said: string
  route: string
  app: string | null
  outcome: string | null
  goal: string | null
  did: string | null
  ended: string | null
}

export interface TurnStoreOptions {
  now?: () => number
  /** How long a turn stays eligible. Supplied by the memory that owns it. */
  ttlMs: number
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export class TurnStore {
  private readonly now: () => number
  private readonly log: NonNullable<TurnStoreOptions['log']>

  constructor(
    private readonly db: SqlDatabase,
    private readonly options: TurnStoreOptions
  ) {
    this.db.exec(SCHEMA)
    this.now = options.now ?? ((): number => Date.now())
    this.log = options.log ?? ((): void => {})
  }

  /**
   * What is still worth having, oldest first.
   *
   * Expired rows are dropped rather than returned for the memory to prune,
   * because an expired turn that has been read back is already a thing that
   * could be got wrong — and the cheapest way not to get it wrong is for it
   * never to arrive.
   *
   * Never throws. A memory that cannot be read is an empty memory, which is
   * exactly what Mull had before this file existed.
   */
  load(): RecentTurn[] {
    try {
      const cutoff = this.now() - this.options.ttlMs
      const rows = this.db
        .prepare('SELECT * FROM turns WHERE at >= ? ORDER BY seq ASC')
        .all(cutoff) as Row[]
      return rows.map(toTurn)
    } catch (err) {
      this.log('warn', 'turns: could not read the memory back', err)
      return []
    }
  }

  /** Write down what the memory now holds. Never throws; see `load`. */
  save(turns: readonly RecentTurn[]): void {
    try {
      this.db.prepare('DELETE FROM turns').run()
      const insert = this.db.prepare(
        `INSERT INTO turns (seq, at, said, route, app, outcome, goal, did, ended)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      turns.forEach((turn, index) => {
        insert.run(
          index,
          turn.at,
          turn.said,
          turn.route,
          turn.app,
          turn.outcome,
          turn.goal ?? null,
          turn.did ?? null,
          turn.ended ?? null
        )
      })
    } catch (err) {
      this.log('warn', 'turns: could not write the memory down', err)
    }
  }

  /** "Mull, forget that." Empties the disk as well as the memory. */
  clear(): void {
    try {
      this.db.prepare('DELETE FROM turns').run()
    } catch (err) {
      this.log('warn', 'turns: could not clear the memory', err)
    }
  }
}

/**
 * A row, as the memory wants it.
 *
 * The three optional fields are omitted rather than set to null when they are
 * empty, so a turn that came back off disk compares equal to the one that went
 * in — `goal: undefined` and no `goal` at all are the same thing to every
 * reader, and a row that is null in one and absent in the other is a diff
 * nobody meant.
 */
function toTurn(row: Row): RecentTurn {
  return {
    said: row.said,
    route: row.route,
    app: row.app,
    outcome: row.outcome,
    at: row.at,
    ...(row.goal !== null ? { goal: row.goal } : {}),
    ...(row.did !== null ? { did: row.did } : {}),
    ...(row.ended !== null ? { ended: row.ended } : {})
  }
}
