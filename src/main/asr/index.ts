import { existsSync } from 'node:fs'
import { resolveWhisperCli, vadModelPath } from '../locations'
import { resolveModelPath } from '../services/model'
import { FakeAsrProvider } from './fake'
import { WhisperCliProvider } from './whisper-cli'
import type { AsrProvider } from './types'

export type { AsrProvider, AsrResult, TranscribeOptions } from './types'
export { FakeAsrProvider } from './fake'
export { WhisperCliProvider, parseWhisperStdout, parseWhisperJson, MAX_PROMPT_CHARS } from './whisper-cli'

export interface AsrSelection {
  provider: AsrProvider
  /** Null when the preferred provider was selected; set when we degraded. */
  degradedReason: string | null
  /**
   * Set when the model actually loaded is not the one asked for — an install
   * that predates the small.en default still has base.en and keeps working,
   * but the settings pane should say so rather than quietly appear correct.
   */
  fallbackFrom: string | null
}

/**
 * Pick a provider, preferring real local ASR and degrading loudly.
 *
 * `MULL_ASR=fake` forces the fake — that is how the smoke script and any
 * CI-ish run exercise the whole pipeline without a model on disk.
 */
export async function selectAsrProvider(options?: {
  binaryPath?: string
  modelPath?: string
  /** `settings.speechModel`; ignored when `modelPath` is given outright. */
  speechModel?: string
  vadModelPath?: string | null
}): Promise<AsrSelection> {
  if (process.env['MULL_ASR'] === 'fake') {
    return { provider: new FakeAsrProvider(), degradedReason: null, fallbackFrom: null }
  }

  const preferred = options?.speechModel ?? 'small.en'
  const modelPath = options?.modelPath ?? resolveModelPath(preferred)
  const vad = options?.vadModelPath === undefined ? vadModelPath() : options.vadModelPath

  const whisper = new WhisperCliProvider({
    binaryPath: options?.binaryPath ?? resolveWhisperCli(),
    modelPath,
    vadModelPath: vad && existsSync(vad) ? vad : null
  })

  if (await whisper.ready()) {
    const loaded = modelPath.split('/').pop() ?? ''
    const wanted = `ggml-${preferred}.bin`
    return {
      provider: whisper,
      degradedReason: null,
      fallbackFrom: loaded !== wanted ? loaded : null
    }
  }

  return {
    provider: new FakeAsrProvider(),
    degradedReason: whisper.unavailableReason ?? 'whisper unavailable',
    fallbackFrom: null
  }
}
