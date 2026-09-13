/**
 * IPC channel names + the shapes that cross them.
 *
 * Two renderers talk to main:
 *  - the HUD renderer (read-only in M1: it renders whatever HudState says)
 *  - the hidden capture renderer (mic -> Float32 PCM chunks -> main)
 *
 * Keep every channel name in this file so the preload allow-list and the main
 * handlers can never drift apart.
 */

/** Mic capture format. The AudioContext is opened at this rate so Chromium
 *  does the resampling for us and main only ever sees 16 kHz mono. */
export const CAPTURE_SAMPLE_RATE = 16_000

/** Utterances shorter than this are treated as an accidental key tap. */
export const MIN_UTTERANCE_MS = 350

/** Hard stop so a stuck key can't record forever. */
export const MAX_UTTERANCE_MS = 120_000

export type HudPhase =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'inserting'
  | 'applied'
  | 'blocked'
  | 'error'

export interface HudLastAction {
  /** Short human summary, e.g. 'Dictation · Mail'. */
  summary: string
  /** Epoch ms. */
  at: number
  chars: number
  /** Journal entry this action wrote, if any. */
  entryId: string | null
  /** Whether ⌥Z can still take it back — the HUD only offers undo when true. */
  undoable: boolean
}

export interface HudState {
  phase: HudPhase
  /** Live or final transcript. Empty in idle. */
  transcript: string
  /** True while `transcript` is still growing. */
  partial: boolean
  /** Frontmost app at the moment capture started. */
  app: { bundleId: string; name: string } | null
  /** Warning line (secure input, missing permission, ASR failure). */
  notice: string | null
  lastAction: HudLastAction | null
}

export const IDLE_HUD_STATE: HudState = {
  phase: 'idle',
  transcript: '',
  partial: false,
  app: null,
  notice: null,
  lastAction: null
}

export const IPC = {
  /** main -> HUD renderer: full HudState on every change. */
  hudState: 'mull:hud-state',
  /** HUD renderer -> main: pull current state on mount. */
  hudStateGet: 'mull:hud-state:get',

  /** main -> capture renderer: begin/end microphone capture. */
  captureStart: 'mull:capture:start',
  captureStop: 'mull:capture:stop',
  /** capture renderer -> main: worklet is live (or failed to go live). */
  captureReady: 'mull:capture:ready',
  /** capture renderer -> main: one Float32 PCM chunk at CAPTURE_SAMPLE_RATE. */
  captureChunk: 'mull:capture:chunk',
  /** capture renderer -> main: getUserMedia / worklet failure. */
  captureError: 'mull:capture:error',

  /** journal window -> main: most recent entries (newest first). */
  journalRecent: 'mull:journal:recent',
  /** any renderer -> main: undo the last undoable entry (same path as ⌥Z). */
  journalUndo: 'mull:journal:undo',

  /** Dev affordance: trigger an utterance without the hotkey. */
  devTrigger: 'mull:dev:trigger',

  ping: 'mull:ping'
} as const

export interface CaptureReadyPayload {
  ok: boolean
  /** Actual context sample rate — should equal CAPTURE_SAMPLE_RATE. */
  sampleRate: number
  error?: string
}
