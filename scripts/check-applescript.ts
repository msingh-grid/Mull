import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BROWSERS } from '../src/shared/agent'
import { AppleScriptApps } from '../src/main/services/apps'
import { AppleScriptMenus } from '../src/main/services/menus'
import { AppleScriptBrowser } from '../src/main/services/browser'
import type { RunScript } from '../src/main/services/osascript'

/**
 * Do the browser scripts actually compile?
 *
 * The one question `browser.test.ts` cannot answer, and the reason this file
 * exists rather than being another `describe` block. Vitest can assert that the
 * right dialect went to the right browser and that no URL was spliced into a
 * script — but every one of those assertions passes just as happily against
 * AppleScript that is not valid AppleScript, because nothing in the test suite
 * ever hands the text to a compiler.
 *
 * That is not a hypothetical gap. The first version of these scripts addressed
 * the browser as `tell application id (item 1 of argv)`, which reads perfectly
 * and fails on every invocation: AppleScript loads an application's vocabulary
 * — `tabs`, `active tab index`, `title of t` — **at compile time**, from that
 * application's dictionary, and with a variable target it has no dictionary to
 * load. Twelve green unit tests, and four of the six scripts could not compile.
 *
 * `osacompile` compiles without running, so this sends no Apple Event, drives
 * no browser and raises no consent dialog. It is safe to run on any Mac.
 *
 *     npx tsx scripts/check-applescript.ts
 *
 * ### Why it only checks installed browsers
 *
 * Compiling `tell application id "com.brave.Browser"` needs Brave's dictionary,
 * so on a Mac without Brave it fails with -1728 — a fact about this machine, not
 * about the script. So the ones that are not installed are skipped and *said*,
 * rather than silently passing. Run it on a Mac with more browsers to cover
 * more of the table; the two dialects are what matter, and Chrome and Safari
 * between them cover both.
 */

const dir = mkdtempSync(join(tmpdir(), 'mull-osa-'))
const captured: Array<{ script: string[]; args: string[] }> = []
const run: RunScript = async (script, args) => {
  captured.push({ script, args })
  // Enough of a record for `parseTab` to accept, so a call does not abort the
  // sweep before the later scripts have been captured.
  return ['1','x','https://x.example/','true'].join('\u001f')
}

const browser = new AppleScriptBrowser({ run })
const apps = new AppleScriptApps({ run })
const menus = new AppleScriptMenus({ run })

/** Is this browser on this Mac? Without it, there is no dictionary to compile against. */
function installed(bundleId: string): boolean {
  try {
    const found = execFileSync(
      '/usr/bin/mdfind',
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return found.trim().length > 0
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const skipped: string[] = []

  /**
   * Always checked, unlike the browsers.
   *
   * System Events ships with macOS, so there is no "not installed" case to skip
   * around — and it is the script most worth compiling, because it is the only
   * one using the `whose` clause, which is where AppleScript's filter syntax is
   * at its least forgiving.
   */
  await apps.list().catch(() => undefined)

  /**
   * Always checked, for the same reason, and with more to get wrong.
   *
   * `READ` is the most intricate script in Mull — a nested `tell` into a menu, a
   * `name of every menu of every menu item` that returns a list of lists, and
   * indexed access across three parallel lists. None of that is checkable by a
   * unit test, because the failure is a *compile* failure inside AppleScript's
   * own grammar rather than anything TypeScript can see.
   */
  await menus.list('Finder').catch(() => undefined)
  await menus.choose('Finder', 'File', 'New Finder Window').catch(() => undefined)

  for (const [bundleId, { name }] of Object.entries(BROWSERS)) {
    if (!installed(bundleId)) {
      skipped.push(`${name} (${bundleId})`)
      continue
    }
    await browser.tabs(bundleId)
    await browser.switchTab(bundleId, 2)
    await browser.openUrl({ bundleId, url: 'https://example.com/', newTab: true })
  }

  let failed = 0
  for (const [n, { script }] of captured.entries()) {
    const target = script.find((line) => line.startsWith('tell application')) ?? '?'
    try {
      execFileSync(
        '/usr/bin/osacompile',
        ['-o', join(dir, `s${n}.scpt`), ...script.flatMap((line) => ['-e', line])],
        { stdio: 'pipe' }
      )
      console.log(`  ok    ${target}  ${script.length} lines`)
    } catch (err) {
      failed += 1
      const said = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? String(err)
      console.log(`  FAIL  ${target}\n        ${said}`)
      console.log(script.map((line, i) => `        ${String(i + 1).padStart(2)} ${line}`).join('\n'))
    }
  }

  rmSync(dir, { recursive: true, force: true })

  if (skipped.length > 0) {
    console.log(`\n  not installed, so not checked: ${skipped.join(', ')}`)
  }
  console.log(
    failed > 0
      ? `\n${failed} of ${captured.length} scripts do not compile`
      : `\nall ${captured.length} scripts compile`
  )
  process.exit(failed > 0 ? 1 : 0)
}

void main()
