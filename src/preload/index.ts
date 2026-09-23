import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type CaptureReadyPayload,
  type HudAction,
  type HudState,
  type MullWindow
} from '@shared/ipc'
import type { DiffCard, DiffSegment } from '@shared/hud'
import type { AboutInfo } from '@shared/about'
import type { Settings } from '@shared/settings'
import type { PermissionKey, PermissionsSnapshot } from '@shared/permissions'
import type { DownloadProgress, ModelStatus } from '@shared/model'
import type { EngineStatus, EngineTestResult } from '@shared/engine'
import type { JournalEntryView } from '@shared/types'
import type { SkillRecord } from '@shared/skills'

/**
 * The bridge. Renderers get exactly these functions and nothing else — no
 * ipcRenderer, no node. Channel names come from @shared/ipc so this allow-list
 * cannot drift from the main-process handlers.
 */
export interface MullApi {
  versions: { electron: string; chrome: string; node: string }
  ping: () => Promise<string>
  hud: {
    /** Subscribe to state pushes. Returns an unsubscribe function. */
    onState: (handler: (state: HudState) => void) => () => void
    /** Pull the current state (for first paint). */
    getState: () => Promise<HudState>
    /** Answer the open card. Same path as the ⏎ / esc global chords. */
    action: (action: HudAction) => Promise<void>
    /** Dev-only: run one utterance without touching the keyboard. */
    devTrigger: (ms?: number) => Promise<void>
    /** The pointer entered or left the panel; main mirrors it into clickability. */
    hover: (over: boolean) => void
    /** Drag the panel. Screen coordinates; main clamps and remembers. */
    dragStart: (pointer: { x: number; y: number }) => void
    dragMove: (pointer: { x: number; y: number }) => void
    dragEnd: () => void
    /** Put the panel back at the bottom centre. */
    resetPosition: () => Promise<void>
    /** Dev-only: open a FakeEngine card so the surfaces can be exercised. */
    devCard: (kind: 'diff' | 'plan') => Promise<void>
    /**
     * Correct what Mull heard, before deciding on the card it produced.
     *
     * `editBegin` asks main for the keyboard — the panel is not focusable
     * otherwise, and the card's global ⏎ / esc would swallow the two keys the
     * field needs. `editEnd` gives it back: a string re-runs the utterance from
     * those words, null leaves everything as it was.
     */
    editBegin: () => void
    editEnd: (text: string | null) => Promise<void>
  }
  /** Mull has no Dock icon; windows are opened by name. */
  windows: {
    open: (window: MullWindow) => Promise<void>
  }
  hudThinking: (on: boolean) => Promise<void>
  hudAutoRun: (on: boolean) => Promise<void>
  journal: {
    /** Newest entries first, each with its change count. */
    recent: (limit?: number) => Promise<JournalEntryView[]>
    /** The diff marks for one entry; computed in main, never here. */
    detail: (id: string) => Promise<{ segments: DiffSegment[] } | null>
    /** The screenshot kept for one entry, as a data URL. Null if there isn't one. */
    capture: (id: string) => Promise<string | null>
    /** Same path as ⌥Z; the result message is also shown on the HUD. */
    undoLast: () => Promise<{ ok: boolean; message: string }>
    /** Undo one specific entry, with the same refusal gates as ⌥Z. */
    undoEntry: (id: string) => Promise<{ ok: boolean; message: string }>
    /** Main pushes this whenever an entry is written or undone. */
    onChanged: (handler: () => void) => () => void
  }
  /** What Mull has learned about driving each application (`settings.skills`). */
  skills: {
    /** Everything, grouped by application. Empty when the feature is off. */
    list: () => Promise<SkillRecord[]>
    /** Forget one note. */
    forget: (id: string) => Promise<void>
    /** Forget all of them. */
    clear: () => Promise<void>
  }
  settings: {
    get: () => Promise<Settings>
    /** Returns the settings as the store made of them, not as you sent them. */
    set: (patch: Partial<Settings>) => Promise<Settings>
    onChanged: (handler: (settings: Settings) => void) => () => void
  }
  permissions: {
    /** What macOS actually granted, right now. */
    get: () => Promise<PermissionsSnapshot>
    /** Opens the System Settings pane. Never decides whether it worked. */
    open: (key: PermissionKey) => Promise<void>
  }
  model: {
    /** Defaults to the model Settings has selected. */
    status: (name?: string) => Promise<ModelStatus>
    /** Every model on offer, in catalog order. */
    list: () => Promise<ModelStatus[]>
    download: (name?: string) => Promise<{ ok: boolean; message: string }>
    onProgress: (handler: (progress: DownloadProgress) => void) => () => void
  }
  /**
   * The edit engine. Secrets travel one way only: `signIn` sends one, and
   * nothing here can read one back — `status` reports whether a credential
   * exists, never what it is.
   */
  engine: {
    status: () => Promise<EngineStatus | null>
    signIn: (
      kind: 'subscription' | 'api-key',
      secret: string
    ) => Promise<{ ok: boolean; message: string }>
    /**
     * Sign in through the browser. Resolves when the browser comes back, which
     * is however long the person takes — the pane says so while it waits.
     */
    signInBrowser: () => Promise<{ ok: boolean; message: string }>
    /** Give up on a browser that never came back. */
    cancelSignIn: () => Promise<void>
    signOut: (kind: 'subscription' | 'api-key') => Promise<unknown>
    /** One real round trip — proof the credential works, not that it saved. */
    test: () => Promise<EngineTestResult>
  }
  /** Versions and paths, for the about pane and bug reports. */
  about: () => Promise<AboutInfo>
  onboarding: {
    /** The canonical edit as a real card — page 2 shows the actual marks. */
    sample: () => Promise<DiffCard | null>
    /** Stamp completion so it stops opening on launch. */
    done: () => Promise<void>
  }
  capture: {
    onStart: (handler: () => void) => void
    onStop: (handler: () => void) => void
    chunk: (pcm: Float32Array) => void
    ready: (payload: CaptureReadyPayload) => void
    error: (message: string) => void
  }
}

const api: MullApi = {
  versions: {
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown'
  },
  ping: () => ipcRenderer.invoke(IPC.ping) as Promise<string>,

  hud: {
    onState: (handler) => {
      const listener = (_event: unknown, state: HudState): void => handler(state)
      ipcRenderer.on(IPC.hudState, listener)
      return () => ipcRenderer.removeListener(IPC.hudState, listener)
    },
    getState: () => ipcRenderer.invoke(IPC.hudStateGet) as Promise<HudState>,
    action: (action) => ipcRenderer.invoke(IPC.hudAction, action) as Promise<void>,
    devTrigger: (ms) => ipcRenderer.invoke(IPC.devTrigger, ms) as Promise<void>,
    hover: (over) => ipcRenderer.send(IPC.hudHover, over),
    dragStart: (pointer) => ipcRenderer.send(IPC.hudDragStart, pointer),
    dragMove: (pointer) => ipcRenderer.send(IPC.hudDragMove, pointer),
    dragEnd: () => ipcRenderer.send(IPC.hudDragEnd),
    resetPosition: () => ipcRenderer.invoke(IPC.hudResetPosition) as Promise<void>,
    devCard: (kind) => ipcRenderer.invoke(IPC.devCard, kind) as Promise<void>,
    editBegin: () => ipcRenderer.send(IPC.hudEditBegin),
    editEnd: (text) => ipcRenderer.invoke(IPC.hudEditEnd, text) as Promise<void>
  },

  windows: {
    open: (window) => ipcRenderer.invoke(IPC.windowOpen, window) as Promise<void>
  },

  hudThinking: (on) => ipcRenderer.invoke(IPC.hudSetThinking, on) as Promise<void>,
  hudAutoRun: (on) => ipcRenderer.invoke(IPC.hudSetAutoRun, on) as Promise<void>,

  journal: {
    recent: (limit) => ipcRenderer.invoke(IPC.journalRecent, limit) as Promise<JournalEntryView[]>,
    detail: (id) =>
      ipcRenderer.invoke(IPC.journalDetail, id) as Promise<{ segments: DiffSegment[] } | null>,
    capture: (id) => ipcRenderer.invoke(IPC.journalCapture, id) as Promise<string | null>,
    undoLast: () =>
      ipcRenderer.invoke(IPC.journalUndo) as Promise<{ ok: boolean; message: string }>,
    undoEntry: (id) =>
      ipcRenderer.invoke(IPC.journalUndoEntry, id) as Promise<{ ok: boolean; message: string }>,
    onChanged: (handler) => {
      const listener = (): void => handler()
      ipcRenderer.on(IPC.journalChanged, listener)
      return () => ipcRenderer.removeListener(IPC.journalChanged, listener)
    }
  },

  skills: {
    list: () => ipcRenderer.invoke(IPC.skillsList) as Promise<SkillRecord[]>,
    forget: (id) => ipcRenderer.invoke(IPC.skillsForget, id) as Promise<void>,
    clear: () => ipcRenderer.invoke(IPC.skillsClear) as Promise<void>
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<Settings>,
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch) as Promise<Settings>,
    onChanged: (handler) => {
      const listener = (_event: unknown, settings: Settings): void => handler(settings)
      ipcRenderer.on(IPC.settingsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.settingsChanged, listener)
    }
  },

  permissions: {
    get: () => ipcRenderer.invoke(IPC.permissionsGet) as Promise<PermissionsSnapshot>,
    open: (key) => ipcRenderer.invoke(IPC.permissionsOpen, key) as Promise<void>
  },

  model: {
    status: (name) => ipcRenderer.invoke(IPC.modelStatus, name) as Promise<ModelStatus>,
    list: () => ipcRenderer.invoke(IPC.modelList) as Promise<ModelStatus[]>,
    download: (name) =>
      ipcRenderer.invoke(IPC.modelDownload, name) as Promise<{ ok: boolean; message: string }>,
    onProgress: (handler) => {
      const listener = (_event: unknown, progress: DownloadProgress): void => handler(progress)
      ipcRenderer.on(IPC.modelProgress, listener)
      return () => ipcRenderer.removeListener(IPC.modelProgress, listener)
    }
  },

  engine: {
    status: () => ipcRenderer.invoke(IPC.engineStatus) as Promise<EngineStatus | null>,
    signIn: (kind, secret) =>
      ipcRenderer.invoke(IPC.engineSignIn, kind, secret) as Promise<{
        ok: boolean
        message: string
      }>,
    signInBrowser: () =>
      ipcRenderer.invoke(IPC.engineSignInBrowser) as Promise<{ ok: boolean; message: string }>,
    cancelSignIn: () => ipcRenderer.invoke(IPC.engineSignInCancel) as Promise<void>,
    signOut: (kind) => ipcRenderer.invoke(IPC.engineSignOut, kind) as Promise<unknown>,
    test: () => ipcRenderer.invoke(IPC.engineTest) as Promise<EngineTestResult>
  },

  about: () => ipcRenderer.invoke(IPC.about) as Promise<AboutInfo>,

  onboarding: {
    sample: () => ipcRenderer.invoke(IPC.sampleEdit) as Promise<DiffCard | null>,
    done: () => ipcRenderer.invoke(IPC.onboardingDone) as Promise<void>
  },

  capture: {
    onStart: (handler) => {
      ipcRenderer.on(IPC.captureStart, () => handler())
    },
    onStop: (handler) => {
      ipcRenderer.on(IPC.captureStop, () => handler())
    },
    chunk: (pcm) => ipcRenderer.send(IPC.captureChunk, pcm),
    ready: (payload) => ipcRenderer.send(IPC.captureReady, payload),
    error: (message) => ipcRenderer.send(IPC.captureError, message)
  }
}

contextBridge.exposeInMainWorld('mull', api)
