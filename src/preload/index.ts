import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type CaptureReadyPayload,
  type HudAction,
  type HudState,
  type MullWindow
} from '@shared/ipc'
import type { DiffSegment } from '@shared/hud'
import type { AboutInfo } from '@shared/about'
import type { Settings } from '@shared/settings'
import type { PermissionKey, PermissionsSnapshot } from '@shared/permissions'
import type { DownloadProgress, ModelStatus } from '@shared/model'
import type { JournalEntryView } from '@shared/types'

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
    /** Dev-only: open a FakeEngine card so the surfaces can be exercised. */
    devCard: (kind: 'diff' | 'plan') => Promise<void>
  }
  /** Mull has no Dock icon; windows are opened by name. */
  windows: {
    open: (window: MullWindow) => Promise<void>
  }
  journal: {
    /** Newest entries first, each with its change count. */
    recent: (limit?: number) => Promise<JournalEntryView[]>
    /** The diff marks for one entry; computed in main, never here. */
    detail: (id: string) => Promise<{ segments: DiffSegment[] } | null>
    /** Same path as ⌥Z; the result message is also shown on the HUD. */
    undoLast: () => Promise<{ ok: boolean; message: string }>
    /** Undo one specific entry, with the same refusal gates as ⌥Z. */
    undoEntry: (id: string) => Promise<{ ok: boolean; message: string }>
    /** Main pushes this whenever an entry is written or undone. */
    onChanged: (handler: () => void) => () => void
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
    status: () => Promise<ModelStatus>
    download: () => Promise<{ ok: boolean; message: string }>
    onProgress: (handler: (progress: DownloadProgress) => void) => () => void
  }
  /** Versions and paths, for the about pane and bug reports. */
  about: () => Promise<AboutInfo>
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
    devCard: (kind) => ipcRenderer.invoke(IPC.devCard, kind) as Promise<void>
  },

  windows: {
    open: (window) => ipcRenderer.invoke(IPC.windowOpen, window) as Promise<void>
  },

  journal: {
    recent: (limit) => ipcRenderer.invoke(IPC.journalRecent, limit) as Promise<JournalEntryView[]>,
    detail: (id) =>
      ipcRenderer.invoke(IPC.journalDetail, id) as Promise<{ segments: DiffSegment[] } | null>,
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
    status: () => ipcRenderer.invoke(IPC.modelStatus) as Promise<ModelStatus>,
    download: () =>
      ipcRenderer.invoke(IPC.modelDownload) as Promise<{ ok: boolean; message: string }>,
    onProgress: (handler) => {
      const listener = (_event: unknown, progress: DownloadProgress): void => handler(progress)
      ipcRenderer.on(IPC.modelProgress, listener)
      return () => ipcRenderer.removeListener(IPC.modelProgress, listener)
    }
  },

  about: () => ipcRenderer.invoke(IPC.about) as Promise<AboutInfo>,

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
