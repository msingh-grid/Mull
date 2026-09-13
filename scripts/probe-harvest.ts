/**
 * What does the AX harvest actually see in the app in front of you?
 *
 * Stage 1 was verified against TextEdit. Slack is Electron, and the model's own
 * reply in the field was "still just the window title is showing — no message
 * text", so this asks the sidecar the same question and prints the raw answer.
 *
 *   npx tsx scripts/probe-harvest.ts "Slack"
 *
 * Activates the named app, waits for it to come forward, then harvests.
 */
import { execFileSync } from 'node:child_process'
import { SidecarClient } from '../src/main/services/sidecar'
import { resolveSidecarPath } from '../src/main/locations'

const app = process.argv[2] ?? 'Slack'

async function main(): Promise<void> {
  const client = new SidecarClient({ binaryPath: resolveSidecarPath({ repoRoot: process.cwd() }) })
  await client.start()

  const permissions = await client.checkPermissions({})
  console.log('permissions', permissions, '\n')

  console.log(`activating ${app}…`)
  execFileSync('osascript', ['-e', `tell application "${app}" to activate`])
  await new Promise((r) => setTimeout(r, 1_200))

  // Poll: Chromium builds its tree asynchronously once asked, so the question
  // is not only "does it work" but "how long does it take".
  for (let i = 0; i < 12; i += 1) {
    const t = Date.now()
    const c = await client.windowContext({ maxChars: 12_000, screenshot: false })
    const chars = c.blocks.reduce((n, b) => n + b.text.length, 0)
    console.log(`  +${i * 500}ms  blocks ${String(c.blocks.length).padStart(4)}  chars ${String(chars).padStart(6)}  (${Date.now() - t}ms)`)
    if (c.blocks.length > 3) break
    await new Promise((r) => setTimeout(r, 500))
  }

  const started = Date.now()
  const context = await client.windowContext({ maxChars: 12_000, screenshot: false })
  console.log(`\nwindowContext in ${Date.now() - started}ms`)
  console.log('app        ', context.app)
  console.log('title      ', context.windowTitle)
  console.log('stoppedBy  ', context.stoppedBy)
  console.log('harvestMs  ', context.harvestMs)
  console.log('truncated  ', context.truncated)
  console.log('blocks     ', context.blocks.length)
  console.log('chars      ', context.blocks.reduce((n, b) => n + b.text.length, 0))
  console.log('')
  for (const block of context.blocks) {
    const marks = [block.focused ? 'focus' : '', block.selected ? 'sel' : ''].filter(Boolean)
    console.log(
      `  ${block.role.padEnd(18)} ${marks.join(',').padEnd(9)} ${JSON.stringify(
        block.text.slice(0, 90)
      )}${block.label ? `   label=${JSON.stringify(block.label)}` : ''}`
    )
  }

  await client.dispose()
  process.exit(0)
}

void main()
