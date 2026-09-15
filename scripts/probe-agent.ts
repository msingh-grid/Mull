/**
 * Is the tool loop better than the questionnaire?
 *
 * The go/no-go for M-A, and it is a gate rather than a demo. The loop costs a
 * new lane, a new vocabulary and a new failure mode; the only thing that
 * justifies that is beating six-step navigation on the goals people actually
 * give it. So both lanes run the same goals against the same live window and
 * the numbers go side by side.
 *
 *   npx tsx scripts/probe-agent.ts Slack                       # the default goals
 *   npx tsx scripts/probe-agent.ts Slack "what did Anil say"   # your own
 *   npx tsx scripts/probe-agent.ts Slack --loop-only
 *
 * **Pass bar, written down before the numbers arrive** (docs/agent/M-A-PLAN.md):
 * the loop must match or beat the questionnaire on whether it *arrived*, within
 * roughly twice its wall-clock. Cost is reported rather than gated — this is the
 * first thing in Mull whose price is not a fixed number of turns, so the point
 * of the column is to find out what that price is.
 *
 * It presses things in a real window. Point it at a Slack or Mail you do not
 * mind being navigated, and read the goals below before running it: the lanes
 * are read-only by construction, but they will open conversations.
 */
import { execFileSync } from 'node:child_process'
import { AgentEngine } from '../src/main/engine/agent'
import { detectClaudeCodeLogin } from '../src/main/engine/select'
import { SidecarClient } from '../src/main/services/sidecar'
import { resolveSidecarPath } from '../src/main/locations'
import { ActionExecutor } from '../src/main/pipeline/actions'
import { AgentLane } from '../src/main/pipeline/agent'
import { NavigateLane } from '../src/main/pipeline/navigate'
import type { PlanCard } from '../src/shared/hud'

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith('--'))
const rest = args.filter((a) => !a.startsWith('--'))
const appName = rest[0] ?? 'Slack'
const goals = rest.length > 1 ? rest.slice(1) : DEFAULT_GOALS()

/** Shapes of real request, not one lucky sentence. */
function DEFAULT_GOALS(): string[] {
  return [
    // The one the questionnaire was built for, and its baseline.
    'open the most recent direct message and read what it says',
    // Needs a search box — the step where the target list collapses and the
    // navigator used to conclude it was stuck.
    'find the conversation with the most recent unread message and read it',
    // Deliberately unanswerable here. Both lanes should say so rather than
    // wander, and the interesting number is how long each takes to admit it.
    'find the message about the Q3 pricing spreadsheet and read what it says'
  ]
}

interface Run {
  lane: 'steps' | 'loop'
  goal: string
  ms: number
  /** Did it come back with prose, rather than an excuse? */
  arrived: boolean
  steps: number
  answer: string | null
  note: string
}

async function main(): Promise<void> {
  const client = new SidecarClient({ binaryPath: resolveSidecarPath({ repoRoot: process.cwd() }) })
  await client.start()

  const permissions = await client.checkPermissions({})
  if (!permissions.accessibility) {
    console.log('no Accessibility grant — nothing below would mean anything')
    process.exit(1)
  }

  const detected = detectClaudeCodeLogin()
  if (!detected) {
    console.log('not signed in to Claude Code — the loop lane needs the subscription')
    process.exit(1)
  }
  const engine = new AgentEngine({ model: 'claude-sonnet-5' })

  let bundleId: string
  try {
    bundleId = execFileSync('osascript', ['-e', `id of app "${appName}"`]).toString().trim()
  } catch {
    console.log(`${appName} is not installed`)
    process.exit(1)
  }

  const runs: Run[] = []
  const lanes: Array<'steps' | 'loop'> = flags.includes('--loop-only')
    ? ['loop']
    : flags.includes('--steps-only')
      ? ['steps']
      : ['steps', 'loop']

  for (const goal of goals) {
    for (const lane of lanes) {
      // Both lanes start from the same place, or the comparison is worthless.
      await client.activateApp({ bundleId })
      await wait(1_200)
      runs.push(await once(lane, goal))
      // Let the app settle, and let anything the last run opened close.
      await wait(800)
    }
  }

  report(runs)
  await engine.dispose()
  await client.dispose()
  process.exit(0)

  // -------------------------------------------------------------------------

  /**
   * One goal, one lane, driven exactly as the app drives it.
   *
   * The card is the only output either lane produces, so this fakes the HUD port
   * and reads the last card — which is also a check worth having: a lane that
   * answers but never draws is broken in a way the numbers would not show.
   */
  async function once(lane: 'steps' | 'loop', goal: string): Promise<Run> {
    const cards: PlanCard[] = []
    let settle: (() => void) | null = null
    const finished = new Promise<void>((resolve) => {
      settle = resolve
    })
    const executor = new ActionExecutor({ sidecar: client })
    const hud = {
      openCard: (card: PlanCard, onAction: (action: 'apply' | 'cancel') => void) => {
        cards.push(card)
        // Run, immediately — there is nobody here to press it.
        setTimeout(() => onAction('apply'), 0)
      },
      updateCard: (card: PlanCard) => {
        cards.push(card)
        if (card.running === false && cards.length > 1) settle?.()
      },
      closeCard: () => settle?.(),
      announce: () => {}
    }

    const request = { goal, transcript: goal, app: { bundleId, name: appName } }
    const startedAt = Date.now()

    if (lane === 'steps') {
      const it = new NavigateLane({ sidecar: client, engine, executor, hud: hud as never })
      await it.propose(request)
    } else {
      const it = new AgentLane({
        sidecar: client,
        engine,
        executor,
        run: (run) => engine.runAgent(run),
        hud: hud as never
      })
      await it.propose(request)
    }

    await Promise.race([finished, wait(180_000)])
    const last = cards[cards.length - 1]
    return {
      lane,
      goal,
      ms: Date.now() - startedAt,
      arrived: Boolean(last?.answer),
      steps: last?.steps.length ?? 0,
      answer: last?.answer ?? null,
      note: last?.note ?? ''
    }
  }
}

function report(runs: Run[]): void {
  console.log('\n— runs —')
  for (const run of runs) {
    console.log(
      `${run.lane.padEnd(6)} ${String(run.steps).padStart(2)} steps  ` +
        `${String(run.ms).padStart(6)}ms  ${run.arrived ? 'answered' : 'gave up '}  ` +
        `${run.goal.slice(0, 44)}`
    )
    if (run.answer) console.log(`       ↳ ${run.answer.replace(/\s+/gu, ' ').slice(0, 110)}`)
    else console.log(`       ↳ ${run.note.slice(0, 110)}`)
  }

  console.log('\n— the bar —')
  for (const lane of ['steps', 'loop'] as const) {
    const mine = runs.filter((run) => run.lane === lane)
    if (mine.length === 0) continue
    const arrived = mine.filter((run) => run.arrived).length
    const ms = Math.round(mine.reduce((total, run) => total + run.ms, 0) / mine.length)
    console.log(
      `${lane.padEnd(6)} arrived ${arrived}/${mine.length}   mean ${String(ms).padStart(6)}ms`
    )
  }

  const steps = runs.filter((r) => r.lane === 'steps')
  const loop = runs.filter((r) => r.lane === 'loop')
  if (steps.length === 0 || loop.length === 0) return

  const arrivedSteps = steps.filter((r) => r.arrived).length
  const arrivedLoop = loop.filter((r) => r.arrived).length
  const meanSteps = steps.reduce((t, r) => t + r.ms, 0) / steps.length
  const meanLoop = loop.reduce((t, r) => t + r.ms, 0) / loop.length

  // Stated as a verdict rather than left to the reader, because the whole point
  // of writing the bar down in advance was to not argue with the numbers after.
  const better = arrivedLoop >= arrivedSteps
  const quick = meanLoop <= meanSteps * 2
  console.log(
    `\nverdict: ${better && quick ? 'PASS' : 'FAIL'} — ` +
      `arrived ${arrivedLoop} vs ${arrivedSteps}, ` +
      `${(meanLoop / meanSteps).toFixed(1)}× the wall-clock (bar: ≥ and ≤2×)`
  )
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

void main()
