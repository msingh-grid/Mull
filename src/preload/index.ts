import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type CaptureReadyPayload, type HudState } from '@shared/ipc'
import type { JournalEntry } from '@shared/types'

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
    /** Dev-only: run one utterance without touching the keyboard. */
    devTrigger: (ms?: number) => Promise<void>
  }
  journal: {
    /** Newest entries first. */
    recent: (limit?: number) => Promise<JournalEntry[]>
    /** Same path as ⌥Z; the result message is also shown on the HUD. */
    undoLast: () => Promise<{ ok: boolean; message: string }>
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
    devTrigger: (ms) => ipcRenderer.invoke(IPC.devTrigger, ms) as Promise<void>
  },

  journal: {
    recent: (limit) => ipcRenderer.invoke(IPC.journalRecent, limit) as Promise<JournalEntry[]>,
    undoLast: () =>
      ipcRenderer.invoke(IPC.journalUndo) as Promise<{ ok: boolean; message: string }>
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
