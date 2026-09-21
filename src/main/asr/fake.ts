import type { AsrProvider, AsrResult, TranscribeOptions } from './types'

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
    private readonly msPerAudioSecond = 40,
    /**
     * What to report as confidence. High by default so the fake exercises the
     * ordinary path; tests drive the low-confidence branches by passing a
     * number under the threshold in `pipeline/dictation.ts`.
     */
    private readonly confidence: number | null = 0.9
  ) {}

  async ready(): Promise<boolean> {
    return true
  }

  /** `options` is accepted and ignored: the fake has nothing to bias. */
  async transcribe(
    pcm: Float32Array,
    sampleRate: number,
    _options?: TranscribeOptions
  ): Promise<AsrResult> {
    const audioSeconds = pcm.length / sampleRate
    const started = Date.now()
    await new Promise((r) => setTimeout(r, Math.round(audioSeconds * this.msPerAudioSecond)))
    return {
      text: this.phrase,
      durationMs: Date.now() - started,
      model: 'fake',
      confidence: this.confidence
    }
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }
}
