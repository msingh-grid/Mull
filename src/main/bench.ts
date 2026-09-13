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

export interface BenchRow extends BenchStages {
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

export class Bench {
  constructor(
    private readonly path: string,
    private readonly onError: (err: unknown) => void = () => {}
  ) {}

  /** Fire-and-forget: benchmarking must never add latency to the thing it measures. */
  record(row: Omit<BenchRow, 'at'>): void {
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
