/**
 * Can Mull actually address the controls of an arbitrary Mac app?
 *
 * This is Step 0 of Stage 5 and it is a gate, not a warm-up. The whole design
 * rests on one claim — *every AX application has controls, and controls have
 * labels* — and that claim is either true across native and Chromium apps alike
 * or the design is wrong. Stage 1 was verified against TextEdit and turned out
 * to be blind in every Electron app, so this one asks seven.
 *
 *   npx tsx scripts/probe-targets.ts                 # the default seven
 *   npx tsx scripts/probe-targets.ts Slack Mail      # just these
 *   npx tsx scripts/probe-targets.ts --verbose       # print every target
 *
 * **Pass bar, written down before the numbers arrive:** the frontmost window's
 * primary navigation — sidebar rows and the search control — must be
 * addressable with usable labels in at least Mail, Finder, Notes and Slack.
 * Anything less and the model has nothing to point at.
 */
import { execFileSync } from 'node:child_process'
import { SidecarClient } from '../src/main/services/sidecar'
import { resolveSidecarPath } from '../src/main/locations'
import type { UiTarget } from '../src/shared/sidecar-api'

/** Native and Chromium both, because the whole question is generality. */
const DEFAULT_APPS = ['Finder', 'Notes', 'Mail', 'Messages', 'Slack', 'Code', 'Google Chrome']

const verbose = process.argv.includes('--verbose')
const named = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const apps = named.length > 0 ? named : DEFAULT_APPS

/** Roughly: would a model reading this list know what it is choosing? */
function searchy(target: UiTarget): boolean {
  return /search|find|filter|jump to|go to/i.test(`${target.title} ${target.help ?? ''}`)
}

async function main(): Promise<void> {
  const client = new SidecarClient({ binaryPath: resolveSidecarPath({ repoRoot: process.cwd() }) })
  await client.start()

  const permissions = await client.checkPermissions({})
  console.log('permissions', permissions, '\n')

  const summary: string[] = []

  for (const app of apps) {
    // Through the sidecar rather than `osascript … to activate`, which is what
    // `probe-harvest.ts` does and what this script did first. macOS refuses a
    // background process the right to pull a *second* app forward, so the
    // AppleScript route switched once and then silently did nothing — seven
    // apps all reporting Finder's eleven buttons. `NSRunningApplication`
    // through the sidecar is both reliable and the same call the executor makes.
    let bundleId: string
    try {
      bundleId = execFileSync('osascript', ['-e', `id of app "${app}"`]).toString().trim()
    } catch {
      console.log(`${app.padEnd(16)} not installed`)
      continue
    }
    const activated = await client.activateApp({ bundleId })
    if (!activated.activated) {
      console.log(`${app.padEnd(16)} would not activate: ${activated.reason}`)
      continue
    }
    await new Promise((r) => setTimeout(r, 1_200))

    // Chromium builds its tree asynchronously once asked, so the first scan of
    // an Electron app reports `tree-warming` rather than an empty window. Ask
    // again, exactly as `captureContext` does on the real path.
    let scan = await client.uiTargets({ maxTargets: 200, deadlineMs: 1_200 })
    for (let attempt = 0; scan.stoppedBy === 'tree-warming' && attempt < 4; attempt += 1) {
      await new Promise((r) => setTimeout(r, 400))
      scan = await client.uiTargets({ maxTargets: 200, deadlineMs: 1_200 })
    }

    const press = scan.targets.filter((t) => t.kind === 'press')
    const type = scan.targets.filter((t) => t.kind === 'type')
    const search = scan.targets.filter(searchy)

    const line =
      `${(scan.app?.name ?? app).padEnd(16)} ` +
      `press ${String(press.length).padStart(4)}  ` +
      `type ${String(type.length).padStart(3)}  ` +
      `search ${String(search.length).padStart(2)}  ` +
      `${String(scan.scanMs).padStart(5)}ms  ${scan.stoppedBy}`
    console.log(line)
    summary.push(line)

    if (verbose) {
      for (const target of scan.targets) {
        console.log(
          `    ${String(target.index).padStart(3)} ${target.kind.padEnd(6)} ` +
            `${target.role.padEnd(18)} ${JSON.stringify(target.title.slice(0, 64))}` +
            `${target.enabled ? '' : '  (disabled)'}`
        )
      }
    } else {
      // A sample is what tells you whether the labels are usable or whether
      // they are four hundred copies of "button".
      for (const target of scan.targets.slice(0, 6)) {
        console.log(`    ${target.kind.padEnd(6)} ${JSON.stringify(target.title.slice(0, 60))}`)
      }
      if (search.length > 0) {
        console.log(`    search → ${JSON.stringify(search[0]!.title.slice(0, 60))}`)
      }
    }
    console.log('')
  }

  console.log('— summary —')
  for (const line of summary) console.log(line)

  await client.dispose()
  process.exit(0)
}

void main()
