/**
 * Speech-model status, as the settings and onboarding panes see it.
 *
 * Implementation: src/main/services/model.ts, which is also what
 * scripts/fetch-model.ts runs — one downloader, one definition of "installed".
 */

export interface ModelStatus {
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
