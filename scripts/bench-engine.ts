/**
 * Does the edit lane meet its budget?
 *
 * docs/05-electron-architecture.md §6 sets 1.2 s from instruction to the first
 * diff tokens, and docs/PLAN.md makes the consequence explicit: if the
 * subscription lane cannot hold it, the default flips to the API key. That is
 * a measurement, not a hunch, and this is the thing that measures it.
 *
 *   npm run bench:engine
 *   ANTHROPIC_API_KEY=sk-ant-… npm run bench:engine
 *   MULL_CODEX_CLI=/path/to/codex npm run bench:engine
 *   MULL_BENCH_RUNS=5 npm run bench:engine
 *
 * Claude credentials come from the environment, never from the app's encrypted
 * store: this runs under plain node, where `safeStorage` does not exist. With
 * nothing set, the Claude subscription lane still runs if this Mac is signed
 * in to Claude Code. The Codex lane uses only the installed CLI's ChatGPT login,
 * exactly as the app does.
 */
import { AgentEngine } from '../src/main/engine/agent'
import { ApiKeyEngine } from '../src/main/engine/api-key'
import { CodexCliEngine, inspectCodexCli } from '../src/main/engine/codex'
import { detectClaudeCodeLogin } from '../src/main/engine/select'
import { FIRST_TOKEN_BUDGET_MS } from '../src/main/bench'
import { diffText } from '../src/main/pipeline/diff'
import type { Engine } from '../src/main/engine/types'
import { resolveCodexCliPath } from '../src/main/locations'
import { CODEX_MODEL_IDS } from '../src/shared/settings'

const RUNS = Number(process.env['MULL_BENCH_RUNS'] ?? 3)

/** Real shapes of real edits: a hedge, a wall, a list, a tone change. */
const FIXTURES: Array<{ instruction: string; text: string }> = [
  {
    instruction: 'make this crisp',
    text: 'I’m so sorry to bother you again, but I was just wondering if maybe we still need your sign-off on the terms doc whenever you get a chance, no rush at all.'
  },
  {
    instruction: 'tighten this up',
    text: 'The main thing I wanted to say is that the migration is basically done, there are a few things left that we still need to sort out, mostly around the auth layer, and I think we should be able to ship it by the end of next week assuming nothing else comes up.'
  },
  {
    instruction: 'turn this into bullet points',
    text: 'We agreed to move the launch to March, Priya is taking over the vendor conversation, and Dan will rewrite the onboarding copy before the review on the 12th.'
  },
  {
    instruction: 'fix the grammar',
    text: 'Their going to send over the revised numbers tommorow, and me and Sam will of reviewed them before the call.'
  },
  {
    instruction: 'make it sound less apologetic',
    text: 'Sorry, I know this is a lot to ask and I hate to be a bother, but would it maybe be possible to get the invoice sometime this week if that’s not too much trouble?'
  }
]

interface Sample {
  firstTokenMs: number | null
  totalMs: number
  changes: number
  ok: boolean
  error?: string
}

async function run(engine: Engine, fixture: (typeof FIXTURES)[number]): Promise<Sample> {
  const startedAt = Date.now()
  let firstTokenMs: number | null = null
  try {
    const result = await engine.transform(
      { instruction: fixture.instruction, text: fixture.text, app: null },
      () => {
        firstTokenMs ??= Date.now() - startedAt
      }
    )
    return {
      firstTokenMs,
      totalMs: Date.now() - startedAt,
      changes: diffText(fixture.text, result.text).changes,
      ok: true
    }
  } catch (err) {
    return {
      firstTokenMs,
      totalMs: Date.now() - startedAt,
      changes: 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] as number
}

function ms(value: number): string {
  return Number.isNaN(value) ? '   —  ' : `${Math.round(value).toString().padStart(5)}ms`
}

async function measure(label: string, engine: Engine): Promise<void> {
  console.log(`\n── ${label} · ${engine.model ?? 'no model'} ─────────────────────────────`)

  const classifier: number[] = []
  for (let pass = 0; pass < RUNS; pass += 1) {
    const startedAt = Date.now()
    try {
      await engine.classify({
        transcript: 'make this crisp',
        app: null,
        selection: FIXTURES[0]!.text,
        fieldText: null,
        fieldTruncated: false,
        context: null,
        targets: []
      })
      classifier.push(Date.now() - startedAt)
    } catch (err) {
      console.log(`  ✕ classifier: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const samples: Sample[] = []
  for (let pass = 0; pass < RUNS; pass += 1) {
    for (const fixture of FIXTURES) {
      const sample = await run(engine, fixture)
      samples.push(sample)
      const mark = sample.ok ? (sample.changes > 0 ? '✓' : '·') : '✕'
      console.log(
        `  ${mark} ${ms(sample.firstTokenMs ?? NaN)} first  ${ms(sample.totalMs)} total  ` +
          `${String(sample.changes).padStart(2)} changes  “${fixture.instruction}”` +
          (sample.error ? `\n      ${sample.error}` : '')
      )
    }
  }

  const ok = samples.filter((sample) => sample.ok)
  const first = ok.map((sample) => sample.firstTokenMs).filter((v): v is number => v !== null)
  const total = ok.map((sample) => sample.totalMs)

  console.log(
    `\n  classifier   p50 ${ms(percentile(classifier, 50))}  p95 ${ms(percentile(classifier, 95))}`
  )
  console.log(
    `  first token  p50 ${ms(percentile(first, 50))}  p95 ${ms(percentile(first, 95))}` +
      `   (budget ${FIRST_TOKEN_BUDGET_MS}ms)`
  )
  console.log(`  complete     p50 ${ms(percentile(total, 50))}  p95 ${ms(percentile(total, 95))}`)
  console.log(`  succeeded    ${ok.length}/${samples.length}`)

  const p50 = percentile(first, 50)
  if (!Number.isNaN(p50)) {
    console.log(
      p50 <= FIRST_TOKEN_BUDGET_MS
        ? `  WITHIN BUDGET`
        : `  OVER BUDGET by ${Math.round(p50 - FIRST_TOKEN_BUDGET_MS)}ms — see docs/PLAN.md "flip edit lane to ApiKeyEngine"`
    )
  }
  // A sample with zero changes is not a failure, but a lane that never changes
  // anything is — it means the prompt is being ignored, not that the writing
  // was already perfect five times running.
  const changed = ok.filter((sample) => sample.changes > 0).length
  if (ok.length > 0 && changed === 0) console.log('  WARNING: nothing was edited in any sample')

  await engine.dispose?.()
}

async function main(): Promise<void> {
  const model = process.env['MULL_BENCH_MODEL'] ?? 'claude-sonnet-5'
  const apiKey = process.env['ANTHROPIC_API_KEY']
  const oauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? null
  const detected = detectClaudeCodeLogin()
  const codex = inspectCodexCli(resolveCodexCliPath())

  console.log(`bench:engine · model ${model} · ${RUNS} passes × ${FIXTURES.length} fixtures`)

  let ran = 0
  if (oauthToken || detected) {
    ran += 1
    const agent = new AgentEngine({ oauthToken, model })
    // Warm it exactly as the app does, so the numbers are the numbers a user
    // sees rather than a measurement of subprocess startup.
    agent.warm()
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await measure(`subscription${oauthToken ? '' : ' (detected Claude Code login)'}`, agent)
  } else {
    console.log('\n── subscription ── skipped: no CLAUDE_CODE_OAUTH_TOKEN and no Claude Code login')
  }

  if (apiKey) {
    ran += 1
    await measure('api key', new ApiKeyEngine({ apiKey, model }))
  } else {
    console.log('\n── api key ── skipped: set ANTHROPIC_API_KEY to measure this lane')
  }

  if (codex.path && codex.compatible && codex.loggedIn) {
    ran += 1
    await measure(
      'Codex subscription',
      new CodexCliEngine({
        codexPath: codex.path,
        model: CODEX_MODEL_IDS.terra,
        classifierModel: CODEX_MODEL_IDS.terra
      })
    )
  } else {
    console.log(`\n── Codex subscription ── skipped: ${codex.reason ?? 'not available'}`)
  }

  if (ran === 0) {
    console.log('\nNothing to measure. Sign in to Claude Code or Codex, or set ANTHROPIC_API_KEY.')
    process.exitCode = 1
  }
}

void main().then(
  () => {
    // The Agent SDK's subprocess can outlive the last await; nothing here is
    // waiting on it, so say so rather than hanging the terminal.
    process.exit(process.exitCode ?? 0)
  },
  (err: unknown) => {
    console.error('bench:engine failed', err)
    process.exit(1)
  }
)
