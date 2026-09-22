/**
 * Which ASR configuration actually hears you?
 *
 * Every other lever in the speech path was chosen from a number; this one was
 * being chosen from intuition, and intuition was wrong. The first measurement
 * taken with this probe contradicted the obvious guess outright: on clean
 * audio `ggml-base.en.bin` — the model blamed for a mistranscription — returns
 * "Open any Slack channel" perfectly, and a 3x larger model bought nothing,
 * while adding the on-screen app names to `--prompt` fixed a proper noun that
 * the larger model got wrong without them.
 *
 * So this prints a table rather than a verdict. Cells are word error rate
 * against a hand-corrected transcript, and milliseconds.
 *
 * Building a corpus:
 *
 *   MULL_ASR_KEEP_AUDIO=~/mull-corpus npm run dev      # speak; each hold
 *                                                       # writes a .wav and a
 *                                                       # .txt of what Mull heard
 *   $EDITOR ~/mull-corpus/*.txt                         # correct them to what
 *                                                       # you actually said
 *   npx tsx scripts/probe-asr.ts ~/mull-corpus
 *
 * Real holds are the point. `say`-synthesised speech is far too clean to
 * exercise a noise suppressor or a clipped onset, which is where the failures
 * that prompted all of this actually live.
 *
 * Optional: a `.prompt` file beside a clip supplies the `--prompt` text for the
 * biased rows, standing in for what the harvest would have produced.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { modelsDir, resolveWhisperCli, vadModelPath } from '../src/main/locations'

interface Variant {
  label: string
  model: string
  /** Extra flags on top of the baseline invocation. */
  flags: string[]
  /** Pass the clip's `.prompt` file as `--prompt`. */
  biased: boolean
}

const VARIANTS: Variant[] = [
  { label: 'base.en', model: 'ggml-base.en.bin', flags: [], biased: false },
  { label: 'base.en +prompt', model: 'ggml-base.en.bin', flags: [], biased: true },
  { label: 'small.en', model: 'ggml-small.en.bin', flags: [], biased: false },
  { label: 'small.en +prompt', model: 'ggml-small.en.bin', flags: [], biased: true },
  { label: 'small.en +prompt +vad', model: 'ggml-small.en.bin', flags: ['--vad'], biased: true },
  { label: 'small.en +prompt +sns', model: 'ggml-small.en.bin', flags: ['-sns'], biased: true }
]

/** Compare like a listener would: words, lowercased, punctuation ignored. */
function normalise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9#@\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Levenshtein over words — the standard WER, insertions and deletions included. */
export function wordErrorRate(expected: string, actual: string): number {
  const a = normalise(expected)
  const b = normalise(actual)
  if (a.length === 0) return b.length === 0 ? 0 : 1

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost
      )
    }
    prev = row
  }
  return (prev[b.length] ?? 0) / a.length
}

function run(binary: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', rej)
    child.on('close', (code) =>
      code === 0 ? res(out) : rej(new Error(`whisper-cli exited ${code}: ${err.slice(-300)}`))
    )
  })
}

async function main(): Promise<void> {
  const dir = resolve(process.argv[2] ?? '')
  if (!process.argv[2] || !existsSync(dir)) {
    console.error('usage: npx tsx scripts/probe-asr.ts <corpus-dir>')
    console.error('  a directory of <name>.wav with a matching <name>.txt of what was said')
    process.exit(1)
  }

  const binary = resolveWhisperCli()
  if (!existsSync(binary)) {
    console.error(`whisper-cli not found at ${binary} — brew install whisper-cpp`)
    process.exit(1)
  }

  const clips = readdirSync(dir)
    .filter((f) => f.endsWith('.wav'))
    .map((f) => {
      const stem = f.slice(0, -4)
      const expectedPath = join(dir, `${stem}.txt`)
      const promptPath = join(dir, `${stem}.prompt`)
      return {
        stem,
        wav: join(dir, f),
        expected: existsSync(expectedPath) ? readFileSync(expectedPath, 'utf8').trim() : null,
        prompt: existsSync(promptPath) ? readFileSync(promptPath, 'utf8').trim() : null
      }
    })
    .filter((c) => c.expected !== null)

  if (clips.length === 0) {
    console.error(`no <name>.wav + <name>.txt pairs in ${dir}`)
    process.exit(1)
  }

  const vad = vadModelPath()
  console.log(`corpus: ${clips.length} clips from ${dir}`)
  console.log(`binary: ${binary}\n`)

  const summary: { label: string; wer: number; ms: number; skipped: boolean }[] = []

  for (const variant of VARIANTS) {
    const modelPath = join(modelsDir(), variant.model)
    if (!existsSync(modelPath)) {
      summary.push({ label: variant.label, wer: NaN, ms: NaN, skipped: true })
      continue
    }
    if (variant.flags.includes('--vad') && !existsSync(vad)) {
      summary.push({ label: variant.label, wer: NaN, ms: NaN, skipped: true })
      continue
    }

    console.log(`── ${variant.label} ${'─'.repeat(Math.max(0, 46 - variant.label.length))}`)
    let totalWer = 0
    let totalMs = 0

    for (const clip of clips) {
      const args = [
        '-m', modelPath,
        '-f', clip.wav,
        '-t', '4', '-nt', '-np', '-l', 'en',
        '--output-txt', 'false'
      ]
      if (variant.flags.includes('--vad')) args.push('--vad', '-vm', vad)
      if (variant.flags.includes('-sns')) args.push('-sns')
      if (variant.biased && clip.prompt) args.push('--prompt', clip.prompt)

      const started = Date.now()
      const stdout = await run(binary, args)
      const ms = Date.now() - started
      const heard = stdout.replace(/\s+/g, ' ').trim()
      const wer = wordErrorRate(clip.expected as string, heard)

      totalWer += wer
      totalMs += ms
      const mark = wer === 0 ? '  ' : wer < 0.25 ? ' ~' : ' !'
      console.log(`${mark} ${(wer * 100).toFixed(0).padStart(3)}%  ${String(ms).padStart(5)}ms  ${heard}`)
    }

    const wer = totalWer / clips.length
    const ms = totalMs / clips.length
    console.log(`   mean WER ${(wer * 100).toFixed(1)}%  mean ${ms.toFixed(0)}ms\n`)
    summary.push({ label: variant.label, wer, ms, skipped: false })
  }

  console.log('summary'.padEnd(26) + 'WER'.padStart(8) + 'mean ms'.padStart(10))
  for (const row of summary) {
    if (row.skipped) {
      console.log(`${row.label.padEnd(26)}${'(model not installed)'.padStart(18)}`)
      continue
    }
    console.log(
      `${row.label.padEnd(26)}${`${(row.wer * 100).toFixed(1)}%`.padStart(8)}${row.ms.toFixed(0).padStart(10)}`
    )
  }
  console.log('\nLower WER wins; the ms column is what it costs the dictation lane.')
}

void main()
