/**
 * Does the notebook make runs shorter, or just longer prompts?
 *
 * The go/no-go for `settings.skills`, written the same way `probe-agent.ts`
 * writes the one for the loop itself: the same goals, twice, with the only
 * difference being whether previous runs were allowed to leave notes.
 *
 *   npx tsx scripts/probe-skills.ts Slack                     # the default goals
 *   npx tsx scripts/probe-skills.ts Slack "open the Anil DM"  # your own
 *   npx tsx scripts/probe-skills.ts Slack --rounds 3
 *
 * **The shape of the experiment matters more than the numbers.** A notebook is
 * worth nothing on the first run in an application — there is nothing in it —
 * so a single pass would measure only the cost of an empty `<learned>` block.
 * What is being tested is whether run N+1 is cheaper than run N *because of*
 * run N, so the notebook arm runs each goal several times against a store that
 * is allowed to fill up, and the control arm runs it the same number of times
 * against one that is not.
 *
 * **Pass bar, written down before the numbers arrive:** the notebook arm must
 * arrive at least as often, and take fewer steps on average by the last round.
 * Equal steps is a fail — a feature that changes the prompt and buys nothing is
 * worse than no feature, because it is one more thing to be wrong.
 *
 * It presses things in a real window. Point it at an app you do not mind being
 * navigated; the lane is read-only by construction but it will open things.
 */
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { AgentEngine } from '../src/main/engine/agent'
import { detectClaudeCodeLogin } from '../src/main/engine/select'
import { SidecarClient } from '../src/main/services/sidecar'
import { resolveSidecarPath } from '../src/main/locations'
import { ActionExecutor } from '../src/main/pipeline/actions'
import { AgentLane } from '../src/main/pipeline/agent'
import { SkillStore } from '../src/main/store/skills'
import { AppleScriptApps } from '../src/main/services/apps'
import { AppleScriptMenus } from '../src/main/services/menus'
import { AppleScriptBrowser } from '../src/main/services/browser'
import type { SqlDatabase } from '../src/main/store/sqlite'
import type { PlanCard } from '../src/shared/hud'

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith('--'))
const rest = args.filter((a) => !a.startsWith('--'))
const appName = rest[0] ?? 'Slack'
const roundsFlag = flags.find((f) => f.startsWith('--rounds'))
const rounds = roundsFlag ? Number(roundsFlag.split('=')[1] ?? args[args.indexOf(roundsFlag) + 1]) || 2 : 2
const goals = rest.length > 1 ? rest.slice(1) : DEFAULT_GOALS()

/**
 * Goals that need a route, rather than goals that need one press.
 *
 * A notebook can only save steps where steps were being wasted, so a goal the
 * loop already does in three moves has nothing to teach and nothing to learn.
 * These are the shapes where the first run flails: a search box that does not
 * change the window title, a list that has to be scrolled, a place reachable
 * two different ways.
 */
function DEFAULT_GOALS(): string[] {
  return [
    'find the conversation with the most recent unread message and read it',
    'open the most recent direct message and read what it says'
  ]
}

interface Run {
  arm: 'cold' | 'notebook'
  round: number
  goal: string
  ms: number
  arrived: boolean
  steps: number
  /** How many notes were in front of the model on this run. */
  hints: number
}

async function main(): Promise<void> {
  const client = new SidecarClient({ binaryPath: resolveSidecarPath({ repoRoot: process.cwd() }) })
  await client.start()

  const permissions = await client.checkPermissions({})
  if (!permissions.accessibility) {
    console.log('no Accessibility grant — nothing below would mean anything')
    process.exit(1)
  }
  if (!detectClaudeCodeLogin()) {
    console.log('not signed in to Claude Code — the loop lane needs the subscription')
    process.exit(1)
  }

  let bundleId: string
  try {
    bundleId = execFileSync('osascript', ['-e', `id of app "${appName}"`]).toString().trim()
  } catch {
    console.log(`${appName} is not installed`)
    process.exit(1)
  }

  const engine = new AgentEngine({ model: 'claude-sonnet-5' })
  // A throwaway database, never the user's. The notebook arm's whole point is
  // that it accumulates, so it must start empty and must not survive.
  const skills = new SkillStore(new DatabaseSync(':memory:') as unknown as SqlDatabase)

  const runs: Run[] = []
  for (let round = 1; round <= rounds; round += 1) {
    for (const goal of goals) {
      for (const arm of ['cold', 'notebook'] as const) {
        await client.activateApp({ bundleId })
        await wait(1_200)
        runs.push(await once(arm, round, goal))
        await wait(800)
      }
    }
  }

  report(runs)
  await engine.dispose()
  await client.dispose()
  process.exit(0)

  // -------------------------------------------------------------------------

  async function once(arm: 'cold' | 'notebook', round: number, goal: string): Promise<Run> {
    const cards: PlanCard[] = []
    let settle: (() => void) | null = null
    const finished = new Promise<void>((resolve) => {
      settle = resolve
    })
    let hints = 0

    const lane = new AgentLane({
      sidecar: client,
      engine,
      executor: new ActionExecutor({ sidecar: client }),
      browser: new AppleScriptBrowser(),
      apps: new AppleScriptApps(),
      menus: new AppleScriptMenus(),
      run: (run) => {
        hints = run.skills?.length ?? 0
        return engine.runAgent(run)
      },
      // The one difference between the two arms. The control is given the same
      // store and told not to use it, rather than given none — so the only
      // thing that varies is the feature, not the shape of the lane.
      skills,
      useSkills: () => arm === 'notebook',
      hud: {
        openCard: (card: PlanCard, onAction: (action: 'apply' | 'cancel') => void) => {
          cards.push(card)
          setTimeout(() => onAction('apply'), 0)
        },
        updateCard: (card: PlanCard) => {
          cards.push(card)
          if (card.running === false && cards.length > 1) settle?.()
        },
        closeCard: () => settle?.(),
        announce: () => {}
      } as never
    })

    const startedAt = Date.now()
    await lane.propose({ goal, transcript: goal, app: { bundleId, name: appName } })
    await Promise.race([finished, wait(180_000)])
    // The distillation is fired and not awaited by design, so give it a moment
    // to land before the next round reads the notebook it was meant to fill.
    if (arm === 'notebook') await wait(4_000)

    const last = cards[cards.length - 1]
    return {
      arm,
      round,
      goal,
      ms: Date.now() - startedAt,
      arrived: Boolean(last?.answer),
      steps: last?.steps.length ?? 0,
      hints
    }
  }
}

function report(runs: Run[]): void {
  console.log('\n— runs —')
  for (const run of runs) {
    console.log(
      `r${run.round} ${run.arm.padEnd(8)} ${String(run.steps).padStart(2)} steps  ` +
        `${String(run.ms).padStart(6)}ms  ${run.arrived ? 'answered' : 'gave up '}  ` +
        `${run.hints} hint${run.hints === 1 ? ' ' : 's'}  ${run.goal.slice(0, 40)}`
    )
  }

  const rounds = [...new Set(runs.map((run) => run.round))].sort()
  console.log('\n— by round —')
  for (const round of rounds) {
    for (const arm of ['cold', 'notebook'] as const) {
      const mine = runs.filter((run) => run.round === round && run.arm === arm)
      if (mine.length === 0) continue
      console.log(
        `r${round} ${arm.padEnd(8)} arrived ${mine.filter((r) => r.arrived).length}/${mine.length}  ` +
          `mean ${mean(mine.map((r) => r.steps)).toFixed(1)} steps  ` +
          `${Math.round(mean(mine.map((r) => r.ms)))}ms`
      )
    }
  }

  // The verdict is about the *last* round, because that is the only one where
  // the notebook has anything in it. Round one is the cost of the feature with
  // none of the benefit, and is reported above so that cost is visible.
  const last = rounds[rounds.length - 1]
  const cold = runs.filter((r) => r.round === last && r.arm === 'cold')
  const warm = runs.filter((r) => r.round === last && r.arm === 'notebook')
  if (cold.length === 0 || warm.length === 0) return

  const arrivedOk = warm.filter((r) => r.arrived).length >= cold.filter((r) => r.arrived).length
  const shorter = mean(warm.map((r) => r.steps)) < mean(cold.map((r) => r.steps))
  console.log(
    `\nverdict: ${arrivedOk && shorter ? 'PASS' : 'FAIL'} — by round ${last}, ` +
      `${mean(warm.map((r) => r.steps)).toFixed(1)} steps vs ${mean(cold.map((r) => r.steps)).toFixed(1)}, ` +
      `arrived ${warm.filter((r) => r.arrived).length} vs ${cold.filter((r) => r.arrived).length} ` +
      `(bar: fewer steps, and no worse at arriving)`
  )
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

void main()
