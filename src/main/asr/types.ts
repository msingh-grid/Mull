/**
 * The ASR seam.
 *
 * M1 ships two implementations — a fake (tests, and the degraded path when no
 * model is installed) and a whisper.cpp CLI provider. The interface is the
 * contract every future provider honours, including an in-process one when a
 * native binding builds cleanly on the toolchain (see docs/M1-VERIFY.md).
 */

export interface AsrResult {
  text: string
  /** Wall-clock time inside the provider, ms. */
  durationMs: number
  /** Which model produced it (path basename, or 'fake'). */
  model: string
  /**
   * Mean per-token probability, 0..1, or null when the provider cannot say.
   *
   * Whisper is not calibrated, so this is a relative signal and not a
   * probability that the sentence is right: it separates "heard it cleanly"
   * from "guessed", which is the only distinction the Fn lane needs before it
   * hands a goal string to an agent. Thresholds live with the caller
   * (`pipeline/dictation.ts`), never here.
   */
  confidence: number | null
}

/**
 * What the pipeline knows and whisper does not.
 *
 * Only `prompt` so far, and it earns the whole option bag: whisper decodes a
 * proper noun it has no reason to prefer ("Slack" over "slack"/"left"/"black")
 * far better when told the word is on screen. Measured on a synthesised
 * "open the eng platform channel": base.en alone returns "the end platform",
 * base.en with the surrounding app names in the prompt returns "#eng-platform".
 */
export interface TranscribeOptions {
  /**
   * Proper nouns visible right now — app names, channel names, people.
   *
   * A noun list, never a sentence: whisper treats this as preceding text and
   * will happily continue prose that it was given, which shows up as prompt
   * words leaking into the transcript.
   */
  prompt?: string
}

export interface AsrProvider {
  /** Stable id for logs, bench rows and the HUD notice. */
  readonly name: string
  /** False when the provider can't run (missing binary/model); never throws. */
  ready(): Promise<boolean>
  /** Why `ready()` is false, phrased for a human. Null when ready. */
  readonly unavailableReason: string | null
  transcribe(pcm: Float32Array, sampleRate: number, options?: TranscribeOptions): Promise<AsrResult>
  dispose(): Promise<void>
}
