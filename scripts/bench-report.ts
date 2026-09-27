/**
 * What the latency ledger says, in aggregate.
 *
 * `src/main/bench.ts` appends one line per utterance to `bench.jsonl` and has
 * always pointed here for the reading of it. This is that reading: outcomes and
 * why things did not land, then the stage timings as median / p90 / max, and
 * how many rows breached the same budgets `withinBudget` and
 * `withinEditBudget` enforce — one definition of "too slow", not two.
 *
 *   npm run bench:report                 # the app's own ledger
 *   npm run bench:report -- path.jsonl   # any other copy
 *
 * The ledger holds lengths and timings, never text, so neither does this. App
 * identifiers are counted; nothing else about a row is printed.
 */
import { existsSync, readFileSync } from 'node:fs'
import { benchPath } from '../src/main/locations'
import {
  withinBudget,
  withinEditBudget,
  type BenchRow,
  type DictationRow,
  type EditRow
} from '../src/main/bench'

const path = process.argv[2] ?? benchPath()
if (!existsSync(path)) {
  console.error(`No ledger at ${path} — it is written the first time Mull hears something.`)
  process.exit(1)
}

const rows: BenchRow[] = []
let unreadable = 0
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    rows.push(JSON.parse(line) as BenchRow)
  } catch {
    unreadable += 1
  }
}

function tally(values: (string | null | undefined)[]): string {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v ?? '—', (counts.get(v ?? '—') ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ')
}

function spread(label: string, values: (number | null | undefined)[]): void {
  const xs = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
  if (xs.length === 0) return
  const at = (p: number): number => xs[Math.min(xs.length - 1, Math.round(p * (xs.length - 1)))]!
  console.log(
    `  ${label.padEnd(14)} n=${String(xs.length).padEnd(4)} median ${Math.round(at(0.5))} ms · p90 ${Math.round(at(0.9))} ms · max ${Math.round(xs[xs.length - 1]!)} ms`
  )
}

const dates = rows.map((r) => r.at.slice(0, 10)).sort()
console.log(`${path}`)
console.log(
  `${rows.length} rows${unreadable ? ` (${unreadable} unreadable)` : ''}, ${dates[0] ?? '—'} → ${dates[dates.length - 1] ?? '—'}\n`
)

const dictation = rows.filter((r): r is DictationRow => r.kind === 'dictation')
if (dictation.length) {
  console.log(`Dictation · ${dictation.length}`)
  console.log(`  outcome        ${tally(dictation.map((r) => r.outcome))}`)
  console.log(`  reason         ${tally(dictation.filter((r) => r.reason).map((r) => r.reason))}`)
  console.log(`  model          ${tally(dictation.map((r) => r.model))}`)
  console.log(`  app            ${tally(dictation.map((r) => r.app))}`)
  const applied = dictation.filter((r) => r.outcome === 'applied')
  spread('key-up→text', applied.map((r) => r.totalMs))
  spread('asr', applied.map((r) => r.asrMs))
  spread('insert', applied.map((r) => r.insertMs))
  spread('classify', dictation.map((r) => r.classifyMs))
  const breached = applied.filter((r) => !withinBudget(r).ok).length
  console.log(`  over budget    ${breached} of ${applied.length} applied\n`)
}

const edits = rows.filter((r): r is EditRow => r.kind === 'edit')
if (edits.length) {
  console.log(`Edit · ${edits.length}`)
  console.log(`  outcome        ${tally(edits.map((r) => r.outcome))}`)
  console.log(`  reason         ${tally(edits.filter((r) => r.reason).map((r) => r.reason))}`)
  console.log(`  engine         ${tally(edits.map((r) => r.engine))}`)
  console.log(`  app            ${tally(edits.map((r) => r.app))}`)
  spread('first token', edits.map((r) => r.firstTokenMs))
  spread('engine', edits.filter((r) => r.outcome !== 'unavailable').map((r) => r.engineMs))
  spread('classify', edits.map((r) => r.classifyMs))
  const breached = edits.filter((r) => !withinEditBudget(r).ok).length
  console.log(`  over budget    ${breached} of ${edits.length}\n`)
}
