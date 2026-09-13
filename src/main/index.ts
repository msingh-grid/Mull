import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'

log.initialize()

let hudWindow: BrowserWindow | null = null

/**
 * Placeholder HUD window (M1 skeleton).
 *
 * The real HUD is a non-activating macOS panel so it can float over any app
 * without stealing focus. Target options (enabled in M3, per
 * docs/05-electron-architecture.md §1):
 *
 *   type: 'panel',            // NSPanel — non-activating; pair with
 *                             // hud.setAlwaysOnTop(true, 'screen-saver') and
 *                             // hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
 *
 * For M1 we keep the same frameless/transparent/focusable:false shape but the
 * window stays hidden — it only proves the renderer builds and loads.
 */
function createHudWindow(): BrowserWindow {
  const hud = new BrowserWindow({
    width: 420,
    height: 160,
    show: false, // hidden placeholder until Phase D lands the HUD design (M3)
    frame: false,
    transparent: true,
    focusable: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Float above everything, including full-screen apps ('screen-saver' level).
  hud.setAlwaysOnTop(true, 'screen-saver')

  if (process.env['ELECTRON_RENDERER_URL']) {
    void hud.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void hud.loadFile(join(__dirname, '../renderer/index.html'))
  }

  hud.on('closed', () => {
    hudWindow = null
  })

  return hud
}

ipcMain.handle('mull:ping', () => 'pong')

void app.whenReady().then(() => {
  log.info('mull main ready', { electron: process.versions.electron })
  hudWindow = createHudWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      hudWindow = createHudWindow()
    }
  })
})

// Quit cleanly. (The shipping app will live in the menu bar and NOT quit on
// window-all-closed; for the M1 skeleton a clean exit is the requirement.)
app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  hudWindow?.destroy()
})
