import type { AsrProvider, AsrResult } from './types'

/**
 * Deterministic stand-in for whisper.
 *
 * Two jobs: keep unit tests free of models and Metal, and keep the app usable
 * (and honest about it) when no model is installed. It never pretends to have
 * heard you — it returns a fixed line and the HUD shows the provider name.
 */
export class FakeAsrProvider implements AsrProvider {
  readonly name = 'fake'
  readonly unavailableReason = null

  constructor(
    private readonly phrase = 'This is a simulated transcript from the fake speech provider.',
    /** Simulated compute, ms per second of audio. */
    private readonly msPerAudioSecond = 40
  ) {}

  async ready(): Promise<boolean> {
    return true
  }

  async transcribe(pcm: Float32Array, sampleRate: number): Promise<AsrResult> {
    const audioSeconds = pcm.length / sampleRate
    const started = Date.now()
    await new Promise((r) => setTimeout(r, Math.round(audioSeconds * this.msPerAudioSecond)))
    return {
      text: this.phrase,
      durationMs: Date.now() - started,
      model: 'fake'
    }
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }
}
