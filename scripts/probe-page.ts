/**
 * Watch one window's accessibility tree as it wakes up.
 *
 * Every other probe here asks *what is in this window* once. This one asks the
 * same question on a clock, because the failure it was written for is not about
 * what the tree contains — it is about **when**.
 *
 * The symptom, from `main.log`:
 *
 *     act.open  n=4  detail=calendar.google.com                        ok=true
 *     act.find  n=5  detail="“Create event” — nothing"                 ok=true
 *     act.look  n=6  detail="2 blocks · 138 chars · 18 targets"        ok=true
 *     act.find  n=7  detail="“Create” — nothing"                       ok=true
 *     act.open  n=8  detail=calendar.google.com                        ok=true   ← round two
 *
 * Eighteen targets is Chrome's own furniture — the tab strip, Back, Reload, New
 * Tab — and not one element of the page. The model cannot tell that from a page
 * with eighteen buttons on it, so it concludes it navigated wrong, opens the URL
 * again, and resets the very tree it was waiting for. That is the loop.
 *
 * Run it against the thing that fails:
 *
 *   npx tsx scripts/probe-page.ts                                # frontmost, 10s
 *   npx tsx scripts/probe-page.ts --open https://calendar.google.com
 *   npx tsx scripts/probe-page.ts --app Slack --seconds 20
 *   npx tsx scripts/probe-page.ts --open https://mail.google.com --dump
 *
 * `--open` is the important one: it navigates first and starts the clock at the
 * navigation, which is the window the real run is inside. What you are looking
 * for is the row where `web` stops being 0. Everything before that row is time
 * in which Mull would have handed the model a toolbar and called it a page.
 *
 * Reads only. It opens a URL if asked and otherwise presses nothing.
 */
import { execFileSync } from 'node:child_process'
import { SidecarClient } from '../src/main/services/sidecar'
import { resolveSidecarPath } from '../src/main/locations'
import { AppleScriptBrowser } from '../src/main/services/browser'
import type { UiTarget } from '../src/shared/sidecar-api'

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? null : (process.argv[at + 1] ?? null)
}

const url = flag('open')
const app = flag('app')
const seconds = Number(flag('seconds') ?? 10)
const every = Number(flag('every') ?? 400)
const dump = process.argv.includes('--dump')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Sample {
  at: number
  blocks: number
  chars: number
  readNodes: number | null
  readStop: string
  targets: number
  nodes: number | null
  web: number | null
  webAreas: number | null
  duplicates: number | null
  clipped: number | null
  deepest: number | null
  chromium: boolean
  wake: string
  scanStop: string
  scanMs: number
  title: string | null
}

/** `?` rather than `0` when the sidecar predates the field — see the schema. */
function n(value: number | null | undefined): string {
  return value === null || value === undefined ? '?' : String(value)
}

async function main(): Promise<void> {
  const client = new SidecarClient({ binaryPath: resolveSidecarPath({ repoRoot: process.cwd() }) })
  await client.start()

  const permissions = await client.checkPermissions({})
  if (!permissions.accessibility) {
    console.log('no accessibility grant for this process — nothing below would mean anything.')
    console.log('System Settings → Privacy & Security → Accessibility, for whatever runs this.')
    await client.dispose()
    process.exit(1)
  }

  if (app) {
    const bundleId = execFileSync('osascript', ['-e', `id of app "${app}"`]).toString().trim()
    // Through the sidecar, not AppleScript: macOS refuses a background process
    // the right to pull a second app forward, and the AppleScript route fails
    // silently rather than loudly. See the note in probe-targets.ts.
    const activated = await client.activateApp({ bundleId })
    if (!activated.activated) {
      console.log(`${app} would not come forward: ${activated.reason}`)
      await client.dispose()
      process.exit(1)
    }
    await sleep(1_000)
  }

  const front = await client.frontmostApp({})
  console.log(`watching ${front.app?.name ?? 'whatever is in front'} — ${front.windowTitle ?? ''}`)

  if (url) {
    const browser = new AppleScriptBrowser()
    const bundleId = front.app?.bundleId ?? null
    const tab = await browser.openUrl({
      bundleId: browser.supports(bundleId) ? bundleId : null,
      url,
      newTab: false
    })
    console.log(`opened ${tab.url}\n`)
  }

  console.log(
    '   t     read                              scan\n' +
      '         blocks chars nodes stoppedBy      targets nodes  web docs  dup clip deep stoppedBy      ms  wake'
  )

  const startedAt = Date.now()
  const samples: Sample[] = []

  while (Date.now() - startedAt < seconds * 1_000) {
    const read = await client.windowContext({ maxChars: 6_000, screenshot: false })
    const scan = await client.uiTargets({ maxTargets: 300, deadlineMs: 2_000 })
    const chars = read.blocks.reduce((sum, block) => sum + block.text.length, 0)
    const sample: Sample = {
      at: Date.now() - startedAt,
      blocks: read.blocks.length,
      chars,
      readNodes: read.nodes ?? null,
      readStop: read.stoppedBy,
      targets: scan.targets.length,
      nodes: scan.nodes ?? null,
      web: scan.webNodes ?? null,
      webAreas: scan.webAreas ?? null,
      duplicates: scan.duplicates ?? null,
      clipped: scan.clipped ?? null,
      deepest: scan.deepest ?? null,
      chromium: scan.chromium ?? false,
      wake: scan.wake ?? '?',
      scanStop: scan.stoppedBy,
      scanMs: scan.scanMs,
      title: scan.windowTitle
    }
    samples.push(sample)

    console.log(
      `${String(sample.at).padStart(5)}ms ` +
        `${String(sample.blocks).padStart(6)} ${String(sample.chars).padStart(5)} ` +
        `${n(sample.readNodes).padStart(5)} ${sample.readStop.padEnd(14)} ` +
        `${String(sample.targets).padStart(7)} ${n(sample.nodes).padStart(5)} ` +
        `${n(sample.web).padStart(4)} ${n(sample.webAreas).padStart(4)} ` +
        `${n(sample.duplicates).padStart(4)} ` +
        `${n(sample.clipped).padStart(4)} ${n(sample.deepest).padStart(4)} ` +
        `${sample.scanStop.padEnd(14)} ${String(sample.scanMs).padStart(4)}  ${sample.wake}`
    )

    await sleep(every)
  }

  // The number the whole script exists to produce. Everything before it is time
  // the agent spends being told, in good faith, that the page has no Create
  // button on it.
  console.log('')
  const warm = samples.find((s) => (s.webAreas ?? 0) > 0)
  const unsupported = samples.some((s) => s.chromium && s.wake === 'unsupported')
  if (unsupported) {
    console.log(
      'this browser refuses AXManualAccessibility — Mull has no lever to wake its ' +
        'renderer, so a cold page here will not warm by being asked again.'
    )
  }
  if (samples.some((s) => s.chromium)) {
    console.log(
      warm
        ? `page first visible at +${warm.at}ms (${warm.webAreas} document(s), ` +
          `${warm.web} web nodes of ${n(warm.nodes)})`
        : `page content never appeared in ${seconds}s — every sample was furniture only`
    )
    const cold = samples.filter((s) => (s.webAreas ?? 0) === 0 && s.scanStop !== 'browser-cold')
    if (cold.length > 0) {
      console.log(
        `${cold.length} of ${samples.length} samples had no page content and did not say ` +
          `'browser-cold' — those are the ones a caller cannot tell from a real answer`
      )
    }
  } else {
    console.log('not a Chromium browser — `web` is expected to be 0 and means nothing here.')
  }

  // The bound that does not announce itself. A walk that clipped subtrees and
  // still called itself complete is the exact shape of this bug.
  const clipped = samples.filter((s) => (s.clipped ?? 0) > 0)
  if (clipped.length > 0) {
    const worst = clipped.reduce((a, b) => ((b.clipped ?? 0) > (a.clipped ?? 0) ? b : a))
    console.log(
      `${clipped.length} of ${samples.length} samples hit the depth bound — up to ` +
        `${worst.clipped} subtrees dropped at depth ${worst.deepest}, and every one of ` +
        `those scans still reported '${worst.scanStop}'.\n` +
        `Re-run with MULL_AX_MAX_DEPTH=200 to see what is under them.`
    )
  }

  const best = samples.reduce((a, b) => (b.targets > a.targets ? b : a), samples[0] as Sample)
  console.log(
    `best sample: +${best.at}ms — ${best.blocks} blocks, ${best.chars} chars, ` +
      `${best.targets} targets, ${n(best.webAreas)} web document(s)`
  )

  if (dump) {
    const scan = await client.uiTargets({ maxTargets: 300, deadlineMs: 2_000 })
    console.log(`\n— every target, as the model would be shown them —`)
    for (const target of scan.targets as UiTarget[]) {
      console.log(
        `  ${String(target.index).padStart(3)} ${target.kind.padEnd(6)} ` +
          `${target.role.padEnd(20)} ${JSON.stringify(target.title.slice(0, 70))}`
      )
    }
  }

  await client.dispose()
  process.exit(0)
}

void main()
