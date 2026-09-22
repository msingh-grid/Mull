/**
 * Speech-model status and the models a user may choose between, as the
 * settings and onboarding panes see them.
 *
 * Implementation: src/main/services/model.ts, which is also what
 * scripts/fetch-model.ts runs — one downloader, one definition of "installed".
 */

/**
 * The speech models Mull offers, and the one place their ids are written.
 *
 * whisper.cpp ships a dozen of these; two are offered. Both are English-only,
 * because dictation into an English composer is what Mull does and the
 * multilingual weights cost accuracy on it for capability nobody here uses.
 * The choice between the two is the ordinary one — a bigger model hears
 * unusual words and messy rooms better, and takes longer to say so — and it
 * is a choice because the right answer depends on the Mac and the room, which
 * Mull cannot see.
 */
export const SPEECH_MODEL_IDS = ['base.en', 'small.en'] as const

export type SpeechModelId = (typeof SPEECH_MODEL_IDS)[number]

export const DEFAULT_SPEECH_MODEL: SpeechModelId = 'base.en'

export interface SpeechModelChoice {
  id: SpeechModelId
  file: string
  /** What the pane calls it. */
  label: string
  /** Download size, for a sentence written before anything is on disk. */
  approxMB: number
  /** The trade, in one line. */
  note: string
}

export const SPEECH_MODELS: readonly SpeechModelChoice[] = [
  {
    id: 'base.en',
    file: 'ggml-base.en.bin',
    label: 'Base · English',
    approxMB: 148,
    note: 'Fast. Transcribes a sentence in well under a second on Apple silicon.'
  },
  {
    id: 'small.en',
    file: 'ggml-small.en.bin',
    label: 'Small · English',
    approxMB: 488,
    note: 'Noticeably better on names, jargon and a noisy room. Roughly two to three times slower.'
  }
]

export function speechModelChoice(id: string): SpeechModelChoice | null {
  return SPEECH_MODELS.find((model) => model.id === id) ?? null
}

export interface ModelStatus {
  /** The id it was asked about — `base.en`, `small.en`. */
  name: string
  file: string
  path: string
  /** A `.part` file or a truncated download does not count. */
  installed: boolean
  bytes: number
  /** Where whisper-cli was found, or where it would be looked for. */
  whisperCli: string
  whisperInstalled: boolean
}

export interface DownloadProgress {
  received: number
  /** 0 when the server did not send a length; show bytes instead of a bar. */
  total: number
}
