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
  /**
   * What Mull is doing right now, in three or four words.
   *
   * THINKING can last twenty seconds — a cold session, a long screen
   * transcript, a classifier answering at its measured p50 of 5.4s — and for
   * all of it the panel used to say one unchanging word. That is
   * indistinguishable from a hang, and the user reasonably reported it as one.
   *
   * So this is the same story the log's trace tells, in the one place the user
   * is already looking: "reading the window", "asking the model", "writing".
   * Null outside a working phase.
   */
  stage: string | null
  /**
   * When the current stage began, epoch ms. The panel counts up from it past a
   * couple of seconds, so a long wait is visibly a wait rather than a freeze.
   */
  stageAt: number | null
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
  stage: null,
  stageAt: null,
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
  /**
   * HUD renderer -> main: the pointer entered or left the panel.
   *
   * The window is click-through over its transparent stage, and `forward: true`
   * still delivers mouse moves — so the renderer is the only thing that knows
   * when the pointer is actually over the 480px of paper. Main mirrors this
   * into `setIgnoreMouseEvents`, which is what makes the panel grabbable
   * without the rest of the window eating clicks meant for the app beneath.
   */
  hudHover: 'mull:hud:hover',
  /** HUD renderer -> main: drag the panel. Screen coordinates. */
  hudDragStart: 'mull:hud:drag-start',
  hudDragMove: 'mull:hud:drag-move',
  hudDragEnd: 'mull:hud:drag-end',
  /** any renderer -> main: put the HUD back where it started. */
  hudResetPosition: 'mull:hud:reset-position',

  /** journal window -> main: most recent entries (newest first). */
  journalRecent: 'mull:journal:recent',
  /** any renderer -> main: undo the last undoable entry (same path as ⌥Z). */
  journalUndo: 'mull:journal:undo',
  /** journal window -> main: undo one specific entry. */
  journalUndoEntry: 'mull:journal:undo-entry',
  /** journal window -> main: the marks for one entry, diffed in main. */
  journalDetail: 'mull:journal:detail',
  /**
   * journal window -> main: the screenshot kept for one entry, as a data URL.
   *
   * Separate from `journalDetail` because it is a couple of hundred kilobytes
   * and only wanted when a row is open and the user clicks to look. The
   * transcript rides on the entry itself; only the picture costs anything.
   */
  journalCapture: 'mull:journal:capture',
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

  /** settings -> main: which engine is serving edits, and how it is doing. */
  engineStatus: 'mull:engine:status',
  /**
   * settings -> main: save a credential. The secret goes one way only —
   * nothing ever sends it back, and `engineStatus` reports presence, not value.
   */
  engineSignIn: 'mull:engine:sign-in',
  engineSignOut: 'mull:engine:sign-out',
  /** settings -> main: one real round trip, so a saved credential is proven. */
  engineTest: 'mull:engine:test',

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
