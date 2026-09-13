/**
 * Download the local speech model.
 *
 * Run this yourself — it is ~150 MB and nothing in the app fetches it silently:
 *
 *   npm run fetch:model            # ggml-base.en.bin (default)
 *   npm run fetch:model -- small.en
 *
 * The file lands next to the app's own data so an uninstall takes it with it.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { DEFAULT_MODEL_FILE, modelsDir } from '../src/main/locations'

const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

const KNOWN: Record<string, string> = {
  'tiny.en': 'ggml-tiny.en.bin',
  'base.en': 'ggml-base.en.bin',
  'small.en': 'ggml-small.en.bin',
  base: 'ggml-base.bin',
  small: 'ggml-small.bin'
}

function human(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

async function main(): Promise<void> {
  const requested = process.argv[2] ?? 'base.en'
  const file = KNOWN[requested] ?? (requested.endsWith('.bin') ? requested : DEFAULT_MODEL_FILE)
  const dir = modelsDir()
  const target = join(dir, file)
  const partial = `${target}.part`

  await mkdir(dir, { recursive: true })

  const existing = await stat(target).catch(() => null)
  if (existing && existing.size > 1_000_000) {
    console.log(`Already downloaded: ${target} (${human(existing.size)})`)
    return
  }

  const url = `${BASE_URL}/${file}`
  console.log(`Downloading ${file}\n  from ${url}\n  to   ${target}`)

  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`)
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  let lastPrint = 0

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    const now = Date.now()
    if (now - lastPrint > 250) {
      lastPrint = now
      const pct = total ? ` (${((received / total) * 100).toFixed(0)}%)` : ''
      process.stdout.write(`\r  ${human(received)}${pct}          `)
    }
  })

  await pipeline(source, createWriteStream(partial))
  await rename(partial, target)
  process.stdout.write('\n')
  console.log(`Done. ${human(received)} written.`)
  console.log('\nNext: make sure whisper.cpp\'s CLI is installed —')
  console.log('  brew install whisper-cpp')
}

main().catch((err: unknown) => {
  console.error('\nfetch-model failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
