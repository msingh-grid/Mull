import { contextBridge, ipcRenderer } from 'electron'

/**
 * The typed API surface exposed to renderers as `window.mull`.
 * M1: versions + ping round-trip only. Real IPC (transcript stream, intent
 * chips, diff apply/cancel, journal queries) lands in M3+.
 */
export interface MullApi {
  versions: {
    electron: string
    chrome: string
    node: string
  }
  /** IPC round-trip smoke test; resolves to 'pong'. */
  ping: () => Promise<string>
}

const api: MullApi = {
  versions: {
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown'
  },
  ping: () => ipcRenderer.invoke('mull:ping') as Promise<string>
}

contextBridge.exposeInMainWorld('mull', api)
