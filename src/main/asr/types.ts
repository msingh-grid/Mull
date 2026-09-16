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
}

export interface AsrProvider {
  /** Stable id for logs, bench rows and the HUD notice. */
  readonly name: string
  /** False when the provider can't run (missing binary/model); never throws. */
  ready(): Promise<boolean>
  /** Why `ready()` is false, phrased for a human. Null when ready. */
  readonly unavailableReason: string | null
  transcribe(pcm: Float32Array, sampleRate: number): Promise<AsrResult>
  dispose(): Promise<void>
}
