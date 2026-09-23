/**
 * Does `find` now tell the truth about an unreachable list?
 *
 * The check on the fix for the twenty-turn flail: with Slack's DM autocomplete
 * open, `find` used to answer "nothing matches" about words plainly on screen.
 * This drives the real tool against the real window and prints what the model
 * would be told.
 *
 *   npx tsx scripts/probe-findmiss.ts Slack "Divyanshu"
 */
import { execFileSync } from 'node:child_process'
import { SidecarClient } from '../src/main/services/sidecar'
import { resolveSidecarPath } from '../src/main/locations'
import { ActionExecutor } from '../src/main/pipeline/actions'
import { find, type ToolContext } from '../src/main/pipeline/agent-tools'

const appName = process.argv[2] ?? 'Slack'
const query = process.argv[3] ?? 'Divyanshu'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const client = new SidecarClient({ binaryPath: resolveSidecarPath({ repoRoot: process.cwd() }) })
  await client.start()
  const bundleId = execFileSync('osascript', ['-e', `id of app "${appName}"`]).toString().trim()
  await client.activateApp({ bundleId })
  await wait(1_200)

  const scan = await client.uiTargets({ maxTargets: 400, deadlineMs: 2_000 })
  const box = scan.targets.find(
    (t) => t.kind === 'type' && /search|jump to|channel or user/i.test(`${t.title} ${t.help ?? ''}`)
  )
  if (!box) {
    console.log('no search control found')
    process.exit(1)
  }
  await client.pressTarget({ harvestId: scan.harvestId, index: box.index, expectRole: box.role, expectTitle: box.title })
  await wait(900)
  await client.insertText({ text: query, strategy: 'type' })
  await wait(2_500)
  await client.activateApp({ bundleId })
  await wait(600)

  const context: ToolContext = {
    sidecar: client,
    executor: new ActionExecutor({ sidecar: client }),
    plan: { app: { bundleId, name: appName }, goal: 'probe', groupId: 'probe' },
    stopped: () => false,
    scan: null,
    pressed: null,
    read: null,
    steps: 0,
    front: { bundleId, name: appName }
  }

  /**
   * Pick a phrase that is genuinely on screen and genuinely not a control.
   *
   * Driving the app into the failing state by hand is flaky — Slack's overlay
   * closes on a focus change — so the miss path is provoked instead: read the
   * window, find a line whose words appear in no target label, and ask for it.
   * That is the same shape as the autocomplete failure and reproduces without
   * any timing at all.
   */
  const read = await client.windowContext({ maxChars: 8_000, screenshot: false })
  const fresh = await client.uiTargets({ maxTargets: 400, deadlineMs: 2_000 })
  const labels = fresh.targets.map((t) => `${t.title} ${t.help ?? ''} ${t.value ?? ''}`.toLowerCase()).join(' | ')
  const onlyText = read.blocks
    .map((b) => b.text.trim())
    .filter((t) => t.length > 3 && t.length < 40 && !labels.includes(t.toLowerCase()))
  const chosen = process.argv[3] ? query : (onlyText[0] ?? query)
  console.log(`asking for “${chosen}” — on screen, in no target label`)

  const out = await find(context, { query: chosen }, wait)
  console.log(`\n── what the model is told ──\n${out.text}\n`)
  console.log(`── what the card shows ──\n${out.detail}`)

  await client.dispose()
  process.exit(0)
}

void main()
