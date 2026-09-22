import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeWav, padUtterance } from '../audio/wav'
import type { AsrProvider, AsrResult, TranscribeOptions } from './types'

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
 *
 * Decoder settings are deliberately left at the binary's defaults — beam size
 * 5, best-of 5, temperature 0.0 with 0.2 fallback increments. Beam search was
 * never the missing piece; what this file adds on top of a bare invocation is
 * the three things the *caller* knows and whisper does not: which proper nouns
 * are on screen (`--prompt`), where the speech actually is (`--vad`), and that
 * the clip is push-to-talk shaped and needs padding.
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
  /**
   * Silero VAD model. When present, `--vad` trims the non-speech either side
   * of the utterance before decoding, which is the direct fix for whisper's
   * habit of inventing a sentence out of a short clip floating in 28 s of
   * padding. Null or missing simply skips the flag — the VAD model is a
   * separate ~900 KB download and its absence must never break transcription.
   */
  vadModelPath?: string | null
}

/**
 * A decoded token as whisper-cli reports it in `--output-json-full`.
 * `p` is the token probability; `text` carries special tokens like `[_BEG_]`
 * that must not count toward either the transcript or its confidence.
 */
interface WhisperToken {
  text?: string
  p?: number
}

interface WhisperSegment {
  text?: string
  tokens?: WhisperToken[]
}

/** Whisper's special tokens are bracketed and are not speech. */
function isSpecialToken(text: string): boolean {
  return /^\s*\[_.*_\]\s*$/.test(text)
}

/**
 * Pull the transcript and a confidence out of whisper-cli's JSON.
 *
 * Preferred over scraping stdout: the old line-filtering had to guess which
 * lines were log noise and which were speech, and a transcript that happened
 * to begin "main:" would have been silently dropped. The JSON also carries the
 * per-token probabilities, which is the only place a confidence signal exists.
 */
export function parseWhisperJson(raw: string): { text: string; confidence: number | null } {
  const doc = JSON.parse(raw) as { transcription?: WhisperSegment[] }
  const segments = doc.transcription ?? []
  const text = segments
    .map((s) => (s.text ?? '').trim())
    .filter((t) => t.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  const probabilities: number[] = []
  for (const segment of segments) {
    for (const token of segment.tokens ?? []) {
      if (typeof token.p !== 'number') continue
      if (token.text && isSpecialToken(token.text)) continue
      probabilities.push(token.p)
    }
  }
  const confidence =
    probabilities.length > 0
      ? probabilities.reduce((a, b) => a + b, 0) / probabilities.length
      : null

  return { text, confidence }
}

/**
 * Strip `[00:00:00.000 --> 00:00:02.000]` prefixes and whisper's log noise.
 *
 * Only reached when the JSON sidecar could not be read — kept as the fallback
 * so a whisper build that writes no JSON still produces a transcript rather
 * than an error.
 */
export function parseWhisperStdout(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('whisper_') && !line.startsWith('main:'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whisper reads the prompt as text preceding the utterance, so a long or
 * sentence-shaped prompt gets continued into the transcript. A short noun list
 * biases without leaking. The flag's own ceiling is n_text_ctx/2 tokens; this
 * is well inside it.
 */
export const MAX_PROMPT_CHARS = 220

export class WhisperCliProvider implements AsrProvider {
  readonly name = 'whisper-cli'
  unavailableReason: string | null = null

  private readonly threads: number
  private readonly language: string
  private readonly timeoutMs: number

  constructor(private readonly options: WhisperCliOptions) {
    this.threads = options.threads ?? 4
    this.language = options.language ?? 'en'
    // Must outlive the longest utterance the pipeline will hand over
    // (MAX_UTTERANCE_MS, 120 s) multiplied by the worst realtime factor we
    // expect. It used to be 60 s, i.e. shorter than a maximal hold, so the one
    // utterance most expensive to repeat was the one that got SIGKILLed.
    this.timeoutMs = options.timeoutMs ?? 180_000
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

  async transcribe(
    pcm: Float32Array,
    sampleRate: number,
    options?: TranscribeOptions
  ): Promise<AsrResult> {
    const started = Date.now()
    const dir = await mkdtemp(join(tmpdir(), 'mull-asr-'))
    const wavPath = join(dir, 'utterance.wav')
    const jsonBase = join(dir, 'utterance')
    try {
      await writeFile(wavPath, encodeWav(padUtterance(pcm, sampleRate), sampleRate))
      const stdout = await this.run(wavPath, jsonBase, options?.prompt)

      let text: string
      let confidence: number | null = null
      try {
        const parsed = parseWhisperJson(await readFile(`${jsonBase}.json`, 'utf8'))
        text = parsed.text
        confidence = parsed.confidence
      } catch {
        // A whisper build that wrote no JSON still owes us a transcript.
        text = parseWhisperStdout(stdout)
      }

      await this.keepAudioIfAsked(wavPath, text)
      return {
        text,
        durationMs: Date.now() - started,
        model: this.options.modelPath.split('/').pop() ?? 'unknown',
        confidence
      }
    } finally {
      // Audio never outlives the transcription. This is the privacy claim in
      // the onboarding copy, enforced in code. The single exception is
      // MULL_ASR_KEEP_AUDIO, an env var with no UI and no setting: it exists so
      // a developer can replay a real failing utterance through
      // `scripts/probe-asr.ts`, and it is off in every shipped build because
      // nothing in the app can turn it on.
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** Copy the utterance out for offline replay when MULL_ASR_KEEP_AUDIO is set. */
  private async keepAudioIfAsked(wavPath: string, text: string): Promise<void> {
    const keepDir = process.env['MULL_ASR_KEEP_AUDIO']
    if (!keepDir) return
    try {
      await mkdir(keepDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await copyFile(wavPath, join(keepDir, `${stamp}.wav`))
      // The .txt beside it is what probe-asr.ts reads as the expected
      // transcript — so the corpus starts as "what Mull heard" and is corrected
      // by hand to "what was said".
      await writeFile(join(keepDir, `${stamp}.txt`), `${text}\n`, 'utf8')
    } catch {
      /* debugging aid: never let it break an utterance */
    }
  }

  private run(wavPath: string, jsonBase: string, prompt?: string): Promise<string> {
    const args = [
      '-m', this.options.modelPath,
      '-f', wavPath,
      '-t', String(this.threads),
      '-nt', // no timestamps
      '-np', // no progress prints
      '-sns', // suppress non-speech tokens ([BLANK_AUDIO], (music), ...)
      '--output-txt', 'false',
      '--output-json-full', 'true',
      '-of', jsonBase
    ]
    if (this.language !== 'auto') args.push('-l', this.language)

    const vad = this.options.vadModelPath
    if (vad && existsSync(vad)) args.push('--vad', '-vm', vad)

    const trimmed = prompt?.trim().slice(0, MAX_PROMPT_CHARS)
    if (trimmed) args.push('--prompt', trimmed)

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
