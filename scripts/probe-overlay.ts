/**
 * Where does an autocomplete overlay live, and can Mull see it?
 *
 * A one-off diagnostic for the failure in `docs/agent/README.md` §4.8's
 * neighbourhood: Slack's DM search shows nine suggestion rows and the agent
 * cannot press any of them. The log says the target list did not change when
 * the overlay opened, which is either a walk that stopped early or a walk that
 * was never pointed at the right window. This tells them apart.
 *
 *   npx tsx scripts/probe-overlay.ts Slack "Divyanshu"
 *
 * It types into a search box and then clears it. Nothing is submitted.
 */
import { execFileSync } from 'node:child_process'
import { SidecarClient } from '../src/main/services/sidecar'
import { resolveSidecarPath } from '../src/main/locations'

const appName = process.argv[2] ?? 'Slack'
const query = process.argv[3] ?? 'Divyanshu'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function windowsOf(app: string): string {
  try {
    return execFileSync('osascript', [
      '-e',
      `tell application "System Events" to tell process "${app}" to get {name, role, subrole} of every window`
    ]).toString().trim()
  } catch (err) {
    return `System Events refused: ${String(err).slice(0, 120)}`
  }
}

async function main(): Promise<void> {
  const client = new SidecarClient({ binaryPath: resolveSidecarPath({ repoRoot: process.cwd() }) })
  await client.start()

  const bundleId = execFileSync('osascript', ['-e', `id of app "${appName}"`]).toString().trim()
  await client.activateApp({ bundleId })
  await wait(1_200)

  const before = await client.uiTargets({ maxTargets: 400, deadlineMs: 2_000 })
  console.log(`\nbefore:  ${before.targets.length} targets · ${before.nodes ?? '?'} nodes · stoppedBy=${before.stoppedBy}`)
  console.log(`windows: ${windowsOf(appName)}`)

  const box = before.targets.find(
    (t) => t.kind === 'type' && /search|jump to|channel or user/i.test(`${t.title} ${t.help ?? ''}`)
  ) ?? before.targets.find((t) => /search|jump to/i.test(`${t.title} ${t.help ?? ''}`))
  if (!box) {
    console.log('no search control found — nothing to open')
    process.exit(1)
  }
  console.log(`\nopening “${box.title}” (${box.role}, kind=${box.kind}, index ${box.index})`)
  await client.pressTarget({ harvestId: before.harvestId, index: box.index, expectRole: box.role, expectTitle: box.title })
  await wait(900)

  await client.insertText({ text: query, strategy: 'type' })
  // Long enough for a network-backed suggestion list to arrive and draw.
  await wait(2_500)

  // Every scan reads whatever is frontmost *now*, so a probe that loses focus
  // measures the wrong application and says so quietly — 0 targets, 6 nodes.
  // Re-assert it, and refuse to report numbers that are not about this app.
  await client.activateApp({ bundleId })
  await wait(600)
  const who = await client.frontmostApp({})
  if (who.app?.bundleId !== bundleId) {
    console.log(`\nfocus went to ${who.app?.name ?? 'nothing'} — numbers would be about the wrong window`)
    process.exit(1)
  }

  const after = await client.uiTargets({ maxTargets: 400, deadlineMs: 2_000 })
  console.log(`\nafter:   ${after.targets.length} targets · ${after.nodes ?? '?'} nodes · stoppedBy=${after.stoppedBy}`)
  console.log(`windows: ${windowsOf(appName)}`)

  const needle = new RegExp(query.split(/\s+/u)[0] ?? query, 'iu')
  const hits = after.targets.filter((t) => needle.test(`${t.title} ${t.help ?? ''} ${t.value ?? ''}`))
  console.log(`\ntargets matching /${needle.source}/i: ${hits.length}`)
  for (const hit of hits.slice(0, 12)) {
    console.log(`  ${String(hit.index).padStart(3)} ${hit.role.padEnd(22)} kind=${(hit.kind ?? '?').padEnd(6)} actions=${(hit.actions ?? []).join(',') || 'none'}  ${hit.title.slice(0, 60)}`)
  }

  // What the *reading* harvest sees, which is a different walk entirely.
  const read = await client.windowContext({ maxChars: 8_000, screenshot: false })
  const blocks = read.blocks ?? []
  const inText = blocks.filter((b) => needle.test(b.text ?? ''))
  console.log(`\nreading harvest: ${blocks.length} blocks, ${inText.length} mentioning it`)
  for (const block of inText.slice(0, 10)) {
    console.log(`  ${block.role.padEnd(18)} ${(block.text ?? '').slice(0, 58)}`)
  }
  // The roles either side of the first hit, which is the cheapest way to see
  // what kind of container the suggestion list is.
  const at = blocks.findIndex((b) => needle.test(b.text ?? ''))
  if (at >= 0) {
    console.log('\naround the first hit:')
    for (const block of blocks.slice(Math.max(0, at - 3), at + 4)) {
      console.log(`  ${block.role.padEnd(18)} ${(block.text ?? '').slice(0, 50)}`)
    }
  }
  const roles = new Map<string, number>()
  for (const block of blocks) roles.set(block.role, (roles.get(block.role) ?? 0) + 1)
  console.log('\nblock roles:', [...roles].map(([r, n]) => `${r}×${n}`).join(' '))

  // What the walk threw away. The question the whole exercise turns on: a row
  // that claims AXPress is one rule away from being offered; one that does not
  // is a different problem entirely.
  const dropped = (after.rejected ?? []).filter((r) => needle.test(r.text))
  console.log(`\nrejected nodes mentioning it: ${dropped.length} of ${(after.rejected ?? []).length} sampled`)
  for (const r of dropped.slice(0, 10)) {
    console.log(
      `  ${r.role.padEnd(16)} parent=${r.parentRole.padEnd(16)} press=${String(r.press).padEnd(5)} inChoices=${String(r.inChoices).padEnd(5)} ${r.text.slice(0, 40)}`
    )
  }
  const parents = new Map<string, number>()
  for (const r of after.rejected ?? []) {
    const key = `${r.parentRole}>${r.role}${r.press ? ' (press)' : ''}`
    parents.set(key, (parents.get(key) ?? 0) + 1)
  }
  console.log('rejected shapes:', [...parents].map(([k, n]) => `${k}×${n}`).join('  '))

  // Tidy up: empty the box so the user's Slack is left as it was.
  await client.navKey({ key: 'escape' } as never).catch(() => {})
  await client.dispose()
  process.exit(0)
}

void main()
