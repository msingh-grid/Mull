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


/**
 * The provider in use, behind a reference that never changes.
 *
 * The dictation pipeline is handed its ASR once, at boot, and keeps it for the
 * life of the process — which was fine while the model was a constant and is
 * wrong now that Settings can switch it. Rather than rebuild the pipeline
 * around a new provider (and with it the hotkey, the HUD and everything else
 * holding a reference), the pipeline holds this, and `swap` changes what it
 * points at. The next utterance uses the new model; one already in flight
 * finishes on the old one, because it is holding the provider it started with.
 */
export class SwitchableAsrProvider implements AsrProvider {
  constructor(private provider: AsrProvider) {}

  get name(): string {
    return this.provider.name
  }

  get unavailableReason(): string | null {
    return this.provider.unavailableReason
  }

  ready(): Promise<boolean> {
    return this.provider.ready()
  }

  transcribe(pcm: Float32Array, sampleRate: number): ReturnType<AsrProvider['transcribe']> {
    return this.provider.transcribe(pcm, sampleRate)
  }

  /** Returns the provider that was retired, already disposed. */
  async swap(next: AsrProvider): Promise<AsrProvider> {
    const previous = this.provider
    if (previous === next) return previous
    this.provider = next
    await previous.dispose()
    return previous
  }

  dispose(): Promise<void> {
    return this.provider.dispose()
  }
}
