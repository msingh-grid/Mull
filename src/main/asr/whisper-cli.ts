import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeWav } from '../audio/wav'
import type { AsrProvider, AsrResult } from './types'

/**
 * whisper.cpp via its `whisper-cli` binary.
 *
 * Why a subprocess and not an in-process native binding: `smart-whisper` (the
 * binding the plan named) does not compile against this Node/toolchain combo
 * — node-gyp fails in its binding.cc. The CLI gives us the same local, offline
 * model with zero native build steps, and it already runs off the main thread
 * by virtue of being another process, which is what the utilityProcess in the
 * plan existed to achieve. The cost is per-utterance process spawn (~40-80 ms)
 * and no partial results; both are recorded in bench.jsonl and are the first
 * thing an in-process provider would buy back.
 */

export interface WhisperCliOptions {
  binaryPath: string
  modelPath: string
  /** Decoder threads. Defaults to 4 — enough on Apple silicon, leaves headroom. */
  threads?: number
  /** Language hint; 'auto' lets whisper detect. */
  language?: string
  /** Abort the child if it outlives this. */
  timeoutMs?: number
}

/** Strip `[00:00:00.000 --> 00:00:02.000]` prefixes and whisper's log noise. */
export function parseWhisperStdout(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('whisper_') && !line.startsWith('main:'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export class WhisperCliProvider implements AsrProvider {
  readonly name = 'whisper-cli'
  unavailableReason: string | null = null

  private readonly threads: number
  private readonly language: string
  private readonly timeoutMs: number

  constructor(private readonly options: WhisperCliOptions) {
    this.threads = options.threads ?? 4
    this.language = options.language ?? 'en'
    this.timeoutMs = options.timeoutMs ?? 60_000
  }

  async ready(): Promise<boolean> {
    if (!existsSync(this.options.binaryPath)) {
      this.unavailableReason = `whisper-cli not found at ${this.options.binaryPath} — run: brew install whisper-cpp`
      return false
    }
    if (!existsSync(this.options.modelPath)) {
      this.unavailableReason = `speech model not found at ${this.options.modelPath} — run: npm run fetch:model`
      return false
    }
    this.unavailableReason = null
    return true
  }

  async transcribe(pcm: Float32Array, sampleRate: number): Promise<AsrResult> {
    const started = Date.now()
    const dir = await mkdtemp(join(tmpdir(), 'mull-asr-'))
    const wavPath = join(dir, 'utterance.wav')
    try {
      await writeFile(wavPath, encodeWav(pcm, sampleRate))
      const stdout = await this.run(wavPath)
      return {
        text: parseWhisperStdout(stdout),
        durationMs: Date.now() - started,
        model: this.options.modelPath.split('/').pop() ?? 'unknown'
      }
    } finally {
      // Audio never outlives the transcription. This is the privacy claim in
      // the onboarding copy, enforced in code.
      await rm(dir, { recursive: true, force: true })
    }
  }

  private run(wavPath: string): Promise<string> {
    const args = [
      '-m', this.options.modelPath,
      '-f', wavPath,
      '-t', String(this.threads),
      '-nt', // no timestamps
      '-np', // no progress prints
      '--output-txt', 'false'
    ]
    if (this.language !== 'auto') args.push('-l', this.language)

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.options.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`whisper-cli timed out after ${this.timeoutMs} ms`))
      }, this.timeoutMs)

      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString('utf8')
      })
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(out)
        else reject(new Error(`whisper-cli exited ${code}: ${err.slice(-400)}`))
      })
    })
  }

  async dispose(): Promise<void> {
    /* each transcription owns its own child process */
  }
}
