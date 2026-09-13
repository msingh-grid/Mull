import { defaultModelPath, resolveWhisperCli } from '../locations'
import { FakeAsrProvider } from './fake'
import { WhisperCliProvider } from './whisper-cli'
import type { AsrProvider } from './types'

export type { AsrProvider, AsrResult } from './types'
export { FakeAsrProvider } from './fake'
export { WhisperCliProvider, parseWhisperStdout } from './whisper-cli'

export interface AsrSelection {
  provider: AsrProvider
  /** Null when the preferred provider was selected; set when we degraded. */
  degradedReason: string | null
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
}): Promise<AsrSelection> {
  if (process.env['MULL_ASR'] === 'fake') {
    return { provider: new FakeAsrProvider(), degradedReason: null }
  }

  const whisper = new WhisperCliProvider({
    binaryPath: options?.binaryPath ?? resolveWhisperCli(),
    modelPath: options?.modelPath ?? defaultModelPath()
  })

  if (await whisper.ready()) {
    return { provider: whisper, degradedReason: null }
  }

  return {
    provider: new FakeAsrProvider(),
    degradedReason: whisper.unavailableReason ?? 'whisper unavailable'
  }
}
