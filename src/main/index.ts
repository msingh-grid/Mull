import { app, BrowserWindow, globalShortcut, ipcMain, screen, systemPreferences } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import { CAPTURE_SAMPLE_RATE, IPC, type CaptureReadyPayload, type HudState } from '@shared/ipc'
import type { SidecarApi } from '@shared/sidecar-api'
import { benchPath, resolveSidecarPath } from './locations'
import { Bench } from './bench'
import { selectAsrProvider } from './asr'
import { FakeSidecar, SidecarClient } from './services/sidecar'
import { HotkeyService } from './services/hotkey'
import { DictationPipeline } from './pipeline/dictation'
import type { AsrProvider } from './asr/types'

log.initialize()

let hudWindow: BrowserWindow | null = null
let captureWindow: BrowserWindow | null = null
let pipeline: DictationPipeline | null = null
let hotkey: HotkeyService | null = null
let sidecar: SidecarApi & { dispose?: () => Promise<void> }
let asr: AsrProvider

const logFn = (level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void => {
  if (meta === undefined) log[level](message)
  else log[level](message, meta)
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function rendererEntry(page: string): { url?: string; file?: string } {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) return { url: `${devServer}/${page}` }
  return { file: join(__dirname, `../renderer/${page}`) }
}

function load(win: BrowserWindow, page: string): void {
  const entry = rendererEntry(page)
  if (entry.url) void win.loadURL(entry.url)
  else if (entry.file) void win.loadFile(entry.file)
}

/**
 * The HUD.
 *
 * M1 shape only: bottom-centre, always on top, non-focusable so it never steals
 * the caret from the app you are dictating into. It is deliberately unstyled —
 * M3 replaces the contents with the Studio Paper panel (docs/DESIGN.md §6.1)
 * and switches this to `type: 'panel'` with a transparent background.
 */
function createHudWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const width = 480
  const height = 132

  const hud = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - 24),
    show: false,
    frame: false,
    transparent: false,
    focusable: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  hud.setAlwaysOnTop(true, 'screen-saver')
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  load(hud, 'index.html')
  hud.once('ready-to-show', () => hud.showInactive())
  hud.on('closed', () => {
    hudWindow = null
  })
  return hud
}

/** Invisible renderer that owns the microphone (see src/renderer/capture.ts). */
function createCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  load(win, 'capture.html')
  win.on('closed', () => {
    captureWindow = null
  })
  return win
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function pushHudState(state: HudState): void {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.webContents.send(IPC.hudState, state)
  }
}

async function createSidecar(): Promise<SidecarApi & { dispose?: () => Promise<void> }> {
  const binaryPath = resolveSidecarPath({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: app.getAppPath()
  })

  if (!SidecarClient.binaryExists(binaryPath)) {
    log.warn(`sidecar binary missing at ${binaryPath} — run: npm run build:sidecar`)
    return new FakeSidecar()
  }

  const client = new SidecarClient({ binaryPath, onLog: logFn })
  try {
    await client.start()
    return client
  } catch (err) {
    log.error('sidecar failed to start; falling back to the fake', err)
    await client.dispose()
    return new FakeSidecar()
  }
}

async function bootstrap(): Promise<void> {
  captureWindow = createCaptureWindow()
  hudWindow = createHudWindow()

  sidecar = await createSidecar()
  const selection = await selectAsrProvider()
  asr = selection.provider
  if (selection.degradedReason) {
    log.warn(`ASR degraded to the fake provider: ${selection.degradedReason}`)
  }

  const bench = new Bench(benchPath(), (err) => log.warn('bench write failed', err))

  pipeline = new DictationPipeline(
    {
      sidecar,
      asr,
      bench,
      onState: pushHudState,
      log: logFn,
      capture: {
        start: () => captureWindow?.webContents.send(IPC.captureStart),
        stop: () => captureWindow?.webContents.send(IPC.captureStop)
      }
    },
    CAPTURE_SAMPLE_RATE
  )

  if (selection.degradedReason) {
    pushHudState({ ...pipeline.getState(), notice: selection.degradedReason })
  }

  hotkey = new HotkeyService({
    onStart: () => pipeline?.begin(),
    onStop: () => pipeline?.end(),
    log: logFn
  })
  const mode = hotkey.start(globalShortcut)
  if (mode === 'unavailable') {
    pushHudState({
      ...pipeline.getState(),
      notice:
        '⌥Space is unavailable. Grant Input Monitoring in System Settings → Privacy & Security, then restart Mull.'
    })
  }

  // Permission state is logged once at boot so M1-VERIFY has something to
  // compare against when insertion silently does nothing.
  const perms = await sidecar.checkPermissions({}).catch(() => null)
  log.info('permissions', {
    ...perms,
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    hotkeyMode: mode
  })
  if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
    void systemPreferences.askForMediaAccess('microphone')
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle(IPC.ping, () => 'pong')
ipcMain.handle(IPC.hudStateGet, () => pipeline?.getState() ?? null)

ipcMain.on(IPC.captureChunk, (_event, data: Float32Array | ArrayBufferView) => {
  const pcm =
    data instanceof Float32Array
      ? data
      : new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)
  pipeline?.pushChunk(pcm)
})

ipcMain.on(IPC.captureReady, (_event, payload: CaptureReadyPayload) => {
  if (payload.ok) {
    pipeline?.setSampleRate(payload.sampleRate)
    log.info('capture ready', payload)
  } else {
    log.error('capture failed', payload)
  }
})

ipcMain.on(IPC.captureError, (_event, message: string) => {
  log.error('capture error', message)
})

/** Dev affordance: `window.mull.hud.devTrigger(1200)` runs one utterance. */
ipcMain.handle(IPC.devTrigger, async (_event, ms?: number) => {
  pipeline?.begin()
  await new Promise((r) => setTimeout(r, ms ?? 1_200))
  pipeline?.end()
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

void app.whenReady().then(() => {
  log.info('mull main ready', { electron: process.versions.electron })
  void bootstrap().catch((err: unknown) => log.error('bootstrap failed', err))

  app.on('activate', () => {
    if (!hudWindow) hudWindow = createHudWindow()
  })
})

// Mull lives in the background: closing the HUD must not quit the app once the
// menu-bar item exists (M6). For M1 the HUD is the only window, so we keep the
// process alive explicitly rather than letting Electron's default quit us.
app.on('window-all-closed', () => {
  /* stay resident */
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('before-quit', () => {
  hotkey?.stop(globalShortcut)
  pipeline?.dispose()
  void asr?.dispose()
  void sidecar?.dispose?.()
  hudWindow?.destroy()
  captureWindow?.destroy()
})
