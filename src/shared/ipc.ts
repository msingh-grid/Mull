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
  /**
   * What the action actually produced, when it produced something to read.
   *
   * The answer from an `ask` or a plan, or the reason one could not be given.
   * It exists because the summary alone describes the *request* — "Looked ·
   * Slack · 'what did Anil say'" — and a user glancing at the panel afterwards
   * got the question back rather than the answer. The answer had been on the
   * card a moment earlier and then went nowhere, recoverable only by opening
   * the journal.
   *
   * Null for the lanes whose product is text they already inserted: a
   * dictation's result is on screen in the app, and repeating it here would be
   * saying the same thing twice.
   */
  result?: string | null
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
  /**
   * Whether the writing lanes may think before answering — armed from the HUD.
   *
   * On the panel rather than only in Settings because it is a decision made in
   * the moment, about the sentence you are on the point of saying. "Turn this
   * thread into a project plan" is worth the seconds; "make this less
   * apologetic" is not, and nobody opens a preferences window between the two.
   */
  thinking: boolean
  /** False when the active engine cannot honour Mull's thinking toggle. */
  thinkingAvailable?: boolean
  /**
   * Whether a plan card starts itself instead of waiting for Run — armed from
   * the HUD, beside `thinking`, and for the same reason.
   *
   * It belongs next to the utterance rather than in a preferences window: "open
   * LinkedIn in a new tab" wants to go the moment it is said, and "reply to
   * Anil and send it" wants reading first. Which one you are about to say is
   * known a second before you press the key and nowhere else.
   */
  autoRun: boolean
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
  thinking: false,
  thinkingAvailable: true,
  autoRun: false,
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
  /** HUD -> main: arm or disarm thinking for the writing lanes. */
  hudSetThinking: 'mull:hud:set-thinking',
  /** HUD -> main: arm or disarm starting a run without pressing Run. */
  hudSetAutoRun: 'mull:hud:set-auto-run',

  /**
   * HUD renderer -> main: the user clicked into the transcript to correct it.
   *
   * Two things have to change for a panel that is never focusable to accept
   * typing: the window takes focus for as long as the correction lasts, and the
   * card's global ⏎ / esc are handed back so those keys mean "commit" and
   * "abandon" in the field rather than "apply" and "cancel" on the card.
   */
  hudEditBegin: 'mull:hud:edit-begin',
  /**
   * HUD renderer -> main: the correction is over.
   *
   * A string re-runs the utterance from those words; null leaves the open card
   * exactly as it was. Either way main puts focus back in the app the user was
   * dictating into before anything else happens — insertion writes to whatever
   * holds the caret, and the panel was holding it a moment ago.
   */
  hudEditEnd: 'mull:hud:edit-end',

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

  /**
   * settings -> main: what Mull has learned about driving each application.
   *
   * Its own three verbs rather than a field on the settings object, because it
   * is a list that grows on its own and the pane needs to delete one row of it.
   * Everything Mull learns has to be readable and deletable by the person whose
   * applications it learned in — the same promise the journal makes about
   * actions, made about notes.
   */
  skillsList: 'mull:skills:list',
  skillsForget: 'mull:skills:forget',
  skillsClear: 'mull:skills:clear',

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
  /** settings -> main: every model on offer, and which of them are on disk. */
  modelList: 'mull:model:list',
  /** settings/onboarding -> main: fetch one. Never happens without a click. */
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
  /**
   * settings -> main: sign in through the browser, the way `claude setup-token`
   * does. Main opens the browser and listens on a loopback port; the token it
   * ends up with never crosses back over this bridge.
   */
  engineSignInBrowser: 'mull:engine:sign-in-browser',
  /** settings -> main: stop waiting for a browser that is not coming back. */
  engineSignInCancel: 'mull:engine:sign-in-cancel',
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
