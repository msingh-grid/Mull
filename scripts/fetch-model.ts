/**
 * Download the local speech model.
 *
 * Run this yourself — it is ~466 MB and nothing in the app fetches it silently:
 *
 *   npm run fetch:model            # ggml-small.en.bin (default)
 *   npm run fetch:model -- base.en # smaller and ~2x faster, less accurate
 *   npm run fetch:vad              # Silero VAD, ~900 KB, optional
 *
 * The file lands next to the app's own data so an uninstall takes it with it.
 * The fetching itself lives in src/main/services/model.ts, shared with
 * onboarding page 4 — one implementation, so the CLI and the app cannot end up
 * disagreeing about where a model goes or when a partial file counts as one.
 */
import { downloadModel, humanBytes, modelStatus } from '../src/main/services/model'

async function main(): Promise<void> {
  const requested = process.argv[2] ?? 'small.en'
  const before = await modelStatus(requested)

  if (before.installed) {
    console.log(`Already downloaded: ${before.path} (${humanBytes(before.bytes)})`)
    return
  }

  console.log(`Downloading ${before.file}\n  to   ${before.path}`)

  await downloadModel(requested, ({ received, total }) => {
    const pct = total ? ` (${((received / total) * 100).toFixed(0)}%)` : ''
    process.stdout.write(`\r  ${humanBytes(received)}${pct}          `)
  })

  const after = await modelStatus(requested)
  process.stdout.write('\n')
  console.log(`Done. ${humanBytes(after.bytes)} written.`)

  if (!after.whisperInstalled) {
    console.log('\nNext: install whisper.cpp’s CLI —')
    console.log('  brew install whisper-cpp')
  }
}

main().catch((err: unknown) => {
  console.error('\nfetch-model failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
