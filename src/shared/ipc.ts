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
import type { HudCard, HudChip } from './hud'

export type { HudAction } from './hud'

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
  /** A diff or plan card is open, waiting on ⏎ / esc (docs/DESIGN.md §6.1). */
  | 'preview'

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
  /** Classification chips, in display order. Empty in idle. */
  chips: HudChip[]
  /** The open proposal, if any. Nothing applies until the user says so. */
  card: HudCard | null
}

export const IDLE_HUD_STATE: HudState = {
  phase: 'idle',
  transcript: '',
  partial: false,
  app: null,
  notice: null,
  lastAction: null,
  chips: [],
  card: null
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

  /** HUD renderer -> main: the user pressed Apply or Cancel on the open card. */
  hudAction: 'mull:hud:action',

  /** journal window -> main: most recent entries (newest first). */
  journalRecent: 'mull:journal:recent',
  /** any renderer -> main: undo the last undoable entry (same path as ⌥Z). */
  journalUndo: 'mull:journal:undo',
  /** journal window -> main: undo one specific entry. */
  journalUndoEntry: 'mull:journal:undo-entry',
  /** journal window -> main: the marks for one entry, diffed in main. */
  journalDetail: 'mull:journal:detail',
  /** main -> journal window: the journal changed; re-read it. */
  journalChanged: 'mull:journal:changed',

  /** any renderer -> main: bring one of Mull's own windows up. */
  windowOpen: 'mull:window:open',

  /** settings/onboarding -> main: read or change settings. */
  settingsGet: 'mull:settings:get',
  settingsSet: 'mull:settings:set',
  /** main -> every renderer: settings changed (theme, hotkey, …). */
  settingsChanged: 'mull:settings:changed',

  /** settings/onboarding -> main: what macOS actually granted. */
  permissionsGet: 'mull:permissions:get',
  /** settings/onboarding -> main: open the System Settings pane for one. */
  permissionsOpen: 'mull:permissions:open',

  /** settings/onboarding -> main: is the speech model here? */
  modelStatus: 'mull:model:status',
  /** onboarding -> main: fetch it. Never happens without a click. */
  modelDownload: 'mull:model:download',
  /** main -> requesting renderer: download progress. */
  modelProgress: 'mull:model:progress',

  /** settings/onboarding -> main: versions, paths, hotkey mode. */
  about: 'mull:about',

  /**
   * onboarding -> main: the canonical edit, as a real diff card.
   * Computed by the same engine + differ the HUD uses, so page 2 shows the
   * app's actual marks rather than a picture of them.
   */
  sampleEdit: 'mull:sample:edit',
  /** onboarding -> main: the user finished (or skipped to the end). */
  onboardingDone: 'mull:onboarding:done',

  /** Dev affordance: trigger an utterance without the hotkey. */
  devTrigger: 'mull:dev:trigger',
  /** Dev affordance: open a FakeEngine card so the surfaces can be exercised. */
  devCard: 'mull:dev:card',

  ping: 'mull:ping'
} as const

/** Mull's own windows, addressable by name (there is no Dock icon to click). */
export type MullWindow = 'journal' | 'settings' | 'onboarding'

export interface CaptureReadyPayload {
  ok: boolean
  /** Actual context sample rate — should equal CAPTURE_SAMPLE_RATE. */
  sampleRate: number
  error?: string
}
