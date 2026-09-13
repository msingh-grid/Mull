import { appendFile } from 'node:fs/promises'

/**
 * Latency ledger.
 *
 * docs/PLAN.md sets hard budgets (key-up -> transcript < 400 ms, inserted
 * < 300 ms after that). A budget nobody measures is a wish, so every utterance
 * appends one JSON line with its stage timings. `npm run bench:report` reads
 * this file; nothing else in the app does.
 */

export interface BenchStages {
  /** Hold duration: key-down to key-up. */
  captureMs: number
  /** Audio seconds captured (not wall clock). */
  audioSeconds: number
  /** Key-up to transcript in hand. Budget: 400 ms. */
  asrMs: number
  cleanupMs: number
  /** Transcript to text on screen. Budget: 300 ms. */
  insertMs: number
  /** Key-up to inserted, end to end. */
  totalMs: number
}

export interface DictationRow extends BenchStages {
  at: string
  kind: 'dictation'
  provider: string
  model: string
  chars: number
  app: string | null
  outcome: 'applied' | 'blocked' | 'discarded' | 'failed'
  reason?: string
  /** Strategy that finally worked, or null when nothing did. */
  strategy?: string | null
  /**
   * The whole chain walk, e.g. `ax:ax-unsupported,paste:ok` — this column is
   * what docs/INSERTION-MATRIX.md is filled in from.
   */
  attempts?: string
}

/**
 * One trip through the edit lane (M4).
 *
 * Separate from the dictation row because they measure different things: a
 * dictation's clock starts at key-up and is dominated by ASR, an edit's starts
 * when the lane is handed the instruction and is dominated by the engine.
 * Folding them into one row would have made every stage column mean "or null,
 * depending", which is how a ledger stops being readable.
 *
 * Note what is *not* here: the text. Lengths are recorded, contents never are —
 * `bench.jsonl` sits in plain sight in Application Support, and a latency log
 * is no place for what someone was writing.
 */
export interface EditRow {
  at: string
  kind: 'edit'
  /** Which engine served it: 'agent' | 'api-key' | 'fake' | 'signed-out'. */
  engine: string
  model: string
  app: string | null
  outcome: 'applied' | 'cancelled' | 'refused' | 'failed' | 'unavailable'
  reason?: string
  strategy?: string | null
  instructionChars: number
  beforeChars: number
  afterChars: number
  changes: number
  /** Instruction to first streamed token. Budget: 1200 ms (docs/05 §6). */
  firstTokenMs: number | null
  /** Instruction to the complete proposal. */
  engineMs: number
  /** Apply to text on screen; 0 when the proposal was never applied. */
  insertMs: number
  totalMs: number
}

export type BenchRow = DictationRow | EditRow

/** `Omit` over a union keeps only the shared keys, so it has to distribute. */
export type BenchDraft<T = BenchRow> = T extends unknown ? Omit<T, 'at'> : never

export class Bench {
  constructor(
    private readonly path: string,
    private readonly onError: (err: unknown) => void = () => {}
  ) {}

  /** Fire-and-forget: benchmarking must never add latency to the thing it measures. */
  record(row: BenchDraft): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`
    void appendFile(this.path, line, 'utf8').catch(this.onError)
  }
}

/** Budget check used by the smoke script and M1-VERIFY. */
export function withinBudget(stages: BenchStages): { ok: boolean; breaches: string[] } {
  const breaches: string[] = []
  if (stages.asrMs > 400) breaches.push(`key-up→transcript ${Math.round(stages.asrMs)} ms > 400 ms`)
  if (stages.insertMs > 300) breaches.push(`transcript→inserted ${Math.round(stages.insertMs)} ms > 300 ms`)
  return { ok: breaches.length === 0, breaches }
}

/**
 * The edit lane's budget (docs/05-electron-architecture.md §6): the first diff
 * tokens have to be on screen inside 1.2 s, or the preview stops feeling like
 * an instrument responding and starts feeling like a request sent off
 * somewhere. `npm run bench:engine` is what checks it against a real engine.
 */
export const FIRST_TOKEN_BUDGET_MS = 1_200

export function withinEditBudget(row: Pick<EditRow, 'firstTokenMs'>): {
  ok: boolean
  breaches: string[]
} {
  const breaches: string[] = []
  if (row.firstTokenMs !== null && row.firstTokenMs > FIRST_TOKEN_BUDGET_MS) {
    breaches.push(
      `instruction→first token ${Math.round(row.firstTokenMs)} ms > ${FIRST_TOKEN_BUDGET_MS} ms`
    )
  }
  return { ok: breaches.length === 0, breaches }
}
