import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  shell,
  systemPreferences
} from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import {
  CAPTURE_SAMPLE_RATE,
  IPC,
  type CaptureReadyPayload,
  type HudAction,
  type HudState,
  type MullWindow
} from '@shared/ipc'
import type { PlanStep } from '@shared/hud'
import type { JournalEntryView } from '@shared/types'
import type { SidecarApi } from '@shared/sidecar-api'
import { benchPath, journalPath, resolveSidecarPath, settingsPath } from './locations'
import { Bench } from './bench'
import { selectAsrProvider } from './asr'
import { FakeSidecar, SidecarClient } from './services/sidecar'
import { HotkeyService } from './services/hotkey'
import { describeInsertionReason, InsertionService } from './services/insertion'
import { UndoService } from './services/undo'
import { ChordScope } from './services/chords'
import { HudController } from './services/hud'
import { TrayPresence } from './services/tray'
import { PermissionsService } from './services/permissions'
import { downloadModel, modelStatus } from './services/model'
import { SettingsStore } from './store/settings'
import { JournalStore } from './store/journal'
import { openSqlite } from './store/sqlite'
import { DictationPipeline } from './pipeline/dictation'
import { appliedText, diffText } from './pipeline/diff'
import { FakeEngine } from './engine/fake'
import type { Engine } from './engine/types'
import type { AsrProvider } from './asr/types'
import type { AboutInfo } from '@shared/about'
import type { PermissionKey } from '@shared/permissions'
import type { Settings } from '@shared/settings'
import { SIDECAR_PROTOCOL_VERSION } from '@shared/sidecar-api'

log.initialize()

let hudWindow: BrowserWindow | null = null
let captureWindow: BrowserWindow | null = null
let pipeline: DictationPipeline | null = null
let hotkey: HotkeyService | null = null
let journal: JournalStore | null = null
let undo: UndoService | null = null
let insertion: InsertionService | null = null
let hud: HudController | null = null
let chords: ChordScope | null = null
let tray: TrayPresence | null = null
let engine: Engine | null = null
let settings: SettingsStore | null = null
let permissions: PermissionsService | null = null
/** Filled in at boot; the about pane reports what is actually running. */
let runtime = { hotkeyMode: 'unavailable', asrProvider: 'none', sidecarVersion: null as string | null }
let sidecar: SidecarApi & { dispose?: () => Promise<void> }
let asr: AsrProvider

/** Windows whose renderer exists. Each M3 stage adds one. */
const BUILT_WINDOWS: MullWindow[] = ['journal', 'settings']

const WINDOW_SIZES: Record<MullWindow, { width: number; height: number; minWidth: number }> = {
  journal: { width: 760, height: 620, minWidth: 560 },
  settings: { width: 640, height: 560, minWidth: 520 },
  onboarding: { width: 720, height: 640, minWidth: 640 }
}

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
 * The HUD (docs/DESIGN.md §6.1).
 *
 * A non-activating panel: `type: 'panel'` plus `focusable: false` means it can
 * show, and even be clicked, without ever taking the caret from the app you
 * are dictating into — the first interaction rule (§7.1), and the reason the
 * Apply/Cancel chords are global shortcuts rather than keydown handlers.
 *
 * The window is a fixed, transparent stage sized to the tallest the panel ever
 * gets; the panel itself is bottom-anchored inside it and grows upward. Sizing
 * the window to the content instead would mean a `setBounds` on every state
 * change, and the whole panel would visibly jitter as chips and cards arrive.
 *
 * Because the stage is mostly empty transparent pixels, it starts fully
 * click-through. HudController turns that off for exactly as long as a card is
 * open (see services/hud.ts).
 */
function createHudWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const width = 520
  const height = 420

  const hud = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height),
    show: false,
    frame: false,
    type: 'panel',
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false, // the panel casts its own (--shadow-hud)
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
  hud.setIgnoreMouseEvents(true, { forward: true })
  load(hud, 'index.html')
  hud.once('ready-to-show', () => hud.showInactive())
  hud.on('closed', () => {
    hudWindow = null
  })
  return hud
}

/**
 * Mull's ordinary windows: journal, settings, onboarding (§6.8).
 *
 * One per name, reused rather than duplicated — clicking "Journal…" twice
 * should raise the journal, not open a second one.
 */
const appWindows = new Map<MullWindow, BrowserWindow>()

function openAppWindow(name: MullWindow): BrowserWindow {
  const existing = appWindows.get(name)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    ...WINDOW_SIZES[name],
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  load(win, `${name}.html`)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => appWindows.delete(name))
  appWindows.set(name, win)
  return win
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
  tray?.setPhase(state.phase)
}

/** Tell any open journal window that the record changed under it. */
function notifyJournalChanged(): void {
  const win = appWindows.get('journal')
  if (win && !win.isDestroyed()) win.webContents.send(IPC.journalChanged)
}

/**
 * Open a FakeEngine card (tray → Preview demo).
 *
 * This is the M3 substitute for M4's engine, and it is deliberately not a
 * mime: applying an edit card runs the **real** insertion path, so the demo
 * exercises exactly what the engine will exercise later — including the
 * journal entry and ⌥Z. The plan card is the exception and says so in its own
 * title, because executing commands is M5's and nothing here can run one.
 */
async function showDemoCard(kind: 'diff' | 'plan'): Promise<void> {
  if (!hud || !engine) return

  const { app: target } = await sidecar.frontmostApp({}).catch(() => ({ app: null }))
  const appInfo = target ? { bundleId: target.bundleId, name: target.name } : null

  if (kind === 'plan') {
    const plan = await engine.plan({ instruction: 'demo', app: appInfo })
    const steps: PlanStep[] = plan.steps.map((step, index) => ({
      id: `demo-${index}`,
      verb: step.verb,
      object: step.object,
      state: 'pending'
    }))
    hud.openCard({ kind: 'plan', steps, context: 'demo — nothing runs' }, (action) => {
      log.info(`demo plan card: ${action}`)
    })
    return
  }

  const before = CANONICAL_DEMO_TEXT
  hud.openCard({ kind: 'diff', app: appInfo?.name ?? null, segments: [], changes: 0 }, () => {})

  // Stream it in, exactly as the real engine will.
  const result = await engine.transform({ instruction: 'make this crisp', text: before, app: appInfo }, (partial) => {
    const { segments, changes } = diffText(before, partial)
    hud?.updateCard({ kind: 'diff', app: appInfo?.name ?? null, segments, changes })
  })

  const final = diffText(before, result.text)
  hud.openCard(
    { kind: 'diff', app: appInfo?.name ?? null, segments: final.segments, changes: final.changes },
    (action) => {
      if (action !== 'apply') return
      void applyEdit(appliedText(final.segments), appInfo)
    }
  )
}

/** What Apply on an edit card does: insert, verify, journal, offer ⌥Z. */
async function applyEdit(
  text: string,
  target: { bundleId: string; name: string } | null
): Promise<void> {
  if (!insertion) return
  const outcome = await insertion.insert(text, target)

  if (!outcome.inserted) {
    pipeline?.announce('error', describeInsertionReason(outcome.reason))
    return
  }

  const summary = `Edit · ${target?.name ?? 'this app'}`
  const entry = journal?.append({
    intent: { kind: 'edit', instruction: 'make this crisp', target: 'selection', transcript: '' },
    app: target,
    before: null,
    after: text,
    strategyUsed: outcome.strategyUsed,
    status: 'applied',
    summary,
    verified: outcome.verified,
    caret: outcome.caret,
    // Same bar as dictation: undo only where the write was read back.
    undoable: outcome.verified === true && outcome.caret !== null
  })
  if (entry) notifyJournalChanged()

  pipeline?.announce('applied', 'Edit applied.', {
    summary,
    at: Date.now(),
    chars: text.length,
    entryId: entry?.id ?? null,
    undoable: entry?.undoable ?? false
  })
}

const CANONICAL_DEMO_TEXT =
  'I’m so sorry to bother you again, but I was just wondering if maybe we still need your sign-off on the terms doc whenever you get a chance, no rush at all.'

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
  client.on('ready', ({ sidecarVersion }) => {
    runtime = { ...runtime, sidecarVersion }
  })
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

  // A journal that can't open must not take dictation down with it: the loop
  // still works, it just stops remembering. Undo is disabled in that state
  // rather than guessing.
  try {
    journal = new JournalStore(openSqlite(journalPath()))
    const pruned = journal.prune()
    if (pruned > 0) log.info(`journal pruned ${pruned} old entries`)
  } catch (err) {
    log.error('journal unavailable — actions will not be recorded or undoable', err)
    journal = null
  }

  settings = new SettingsStore({ path: settingsPath(), log: logFn })
  permissions = new PermissionsService({
    sidecar,
    microphoneStatus: () => systemPreferences.getMediaAccessStatus('microphone'),
    openExternal: (url) => void shell.openExternal(url),
    log: logFn
  })

  insertion = new InsertionService({ sidecar, log: logFn })
  undo = journal ? new UndoService({ sidecar, journal, log: logFn }) : null
  engine = new FakeEngine()

  chords = new ChordScope({ globalShortcut, log: logFn })
  hud = new HudController({
    chords,
    log: logFn,
    port: {
      send: pushHudState,
      setInteractive: (interactive) => {
        // Click-through unless there is something to click. `forward: true`
        // keeps hover state alive in the panel while it is transparent.
        hudWindow?.setIgnoreMouseEvents(!interactive, { forward: true })
      }
    }
  })

  tray = new TrayPresence({
    available: BUILT_WINDOWS,
    openWindow: (name) => void openAppWindow(name),
    undoLast: () => void runUndo(),
    demoCard: (kind) => void showDemoCard(kind),
    quit: () => app.quit()
  })
  tray.start()

  pipeline = new DictationPipeline(
    {
      sidecar,
      asr,
      bench,
      insertion,
      journal: journal ?? undefined,
      onState: (state) => hud?.setPipelineState(state),
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
  runtime = {
    hotkeyMode: mode,
    asrProvider: selection.degradedReason ? 'fake (degraded)' : 'whisper-cli',
    sidecarVersion: runtime.sidecarVersion
  }
  tray?.setStatus(
    mode === 'unavailable' ? 'Hotkey unavailable' : mode === 'toggle' ? '⌥Space to start/stop' : 'Hold ⌥Space to dictate'
  )
  if (mode === 'unavailable') {
    pushHudState({
      ...pipeline.getState(),
      notice:
        '⌥Space is unavailable. Grant Input Monitoring in System Settings → Privacy & Security, then restart Mull.'
    })
  }

  // ⌥Z — undo the last thing Mull did. Registered globally (not as a menu item)
  // because the user is never in Mull's window when they want it, and consumed
  // here so the chord doesn't reach the app underneath as a stray Ω.
  if (undo) {
    const registered = globalShortcut.register('Alt+Z', () => {
      void runUndo()
    })
    if (!registered) log.warn('⌥Z is already claimed by another app — undo has no shortcut')
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

/** One undo attempt, with its result shown on the HUD either way. */
async function runUndo(): Promise<{ ok: boolean; message: string }> {
  if (!undo) {
    const message = 'Undo is unavailable — Mull couldn’t open its journal.'
    pipeline?.announce('error', message)
    return { ok: false, message }
  }
  try {
    const outcome = await undo.undoLast()
    if (outcome.ok) notifyJournalChanged()
    pipeline?.announce(
      outcome.ok ? 'applied' : 'error',
      outcome.message,
      // A successful undo retires the action it reversed.
      outcome.ok ? null : undefined
    )
    return { ok: outcome.ok, message: outcome.message }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('undo failed', err)
    pipeline?.announce('error', `Couldn’t undo: ${message}`)
    return { ok: false, message }
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle(IPC.ping, () => 'pong')
/**
 * Entries for the journal window, each carrying its change count.
 *
 * The count is computed here rather than in the renderer so the app has one
 * diff implementation: the number on a row and the marks inside it come from
 * the same call, and cannot describe different edits.
 */
ipcMain.handle(IPC.journalRecent, (_event, limit?: number): JournalEntryView[] => {
  const entries = journal?.recent(limit ?? 50) ?? []
  return entries.map((entry) => ({
    ...entry,
    changes:
      entry.before !== null && entry.after !== null
        ? diffText(entry.before, entry.after).changes
        : null
  }))
})

ipcMain.handle(IPC.journalDetail, (_event, id: string) => {
  const entry = journal?.get(id)
  if (!entry) return null
  return { segments: diffText(entry.before ?? '', entry.after ?? '').segments }
})

ipcMain.handle(IPC.journalUndo, () => runUndo())

ipcMain.handle(IPC.journalUndoEntry, async (_event, id: string) => {
  if (!undo) return { ok: false, message: 'Undo is unavailable — Mull couldn’t open its journal.' }
  const outcome = await undo.undo(id)
  if (outcome.ok) notifyJournalChanged()
  // The HUD says so too: an undo triggered from the journal window still
  // happened in whatever app the user is looking at.
  pipeline?.announce(outcome.ok ? 'applied' : 'error', outcome.message)
  return { ok: outcome.ok, message: outcome.message }
})

// The controller's state, not the pipeline's: first paint must include an open
// card, or a HUD that reloads mid-preview would come back showing nothing.
ipcMain.handle(IPC.hudStateGet, () => hud?.getState() ?? pipeline?.getState() ?? null)

ipcMain.handle(IPC.hudAction, (_event, action: HudAction) => {
  hud?.act(action)
})

ipcMain.handle(IPC.windowOpen, (_event, name: MullWindow) => {
  if (!BUILT_WINDOWS.includes(name)) {
    log.warn(`window "${name}" has not been built yet`)
    return
  }
  openAppWindow(name)
})

ipcMain.handle(IPC.devCard, (_event, kind: 'diff' | 'plan') => showDemoCard(kind))

// ---------------------------------------------------------------------------
// Settings, permissions, model
// ---------------------------------------------------------------------------

ipcMain.handle(IPC.settingsGet, () => settings?.get() ?? null)

ipcMain.handle(IPC.settingsSet, (_event, patch: Partial<Settings>) => {
  const next = settings?.set(patch) ?? null
  if (next) {
    // Every window stamps its own theme, so the change has to reach all of
    // them — including the HUD, which has its own "page in the dark" rule.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.settingsChanged, next)
    }
    applyLaunchAtLogin(next)
  }
  return next
})

ipcMain.handle(IPC.permissionsGet, () => permissions?.snapshot() ?? null)
ipcMain.handle(IPC.permissionsOpen, (_event, key: PermissionKey) => permissions?.open(key))

ipcMain.handle(IPC.modelStatus, () => modelStatus())

/**
 * Download the speech model. Only ever from a click — onboarding page 4 and
 * the settings pane are the two callers, and both are explicit.
 */
ipcMain.handle(IPC.modelDownload, async (event) => {
  try {
    await downloadModel('base.en', (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.modelProgress, progress)
    })
    return { ok: true, message: 'The model is ready. Reopen Mull to start using it.' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('model download failed', err)
    return { ok: false, message: `Download failed: ${message}` }
  }
})

ipcMain.handle(IPC.about, async (): Promise<AboutInfo> => {
  const snapshot = await permissions?.snapshot()
  const model = await modelStatus()
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    sidecarVersion: runtime.sidecarVersion,
    sidecarProtocol: runtime.sidecarVersion ? SIDECAR_PROTOCOL_VERSION : null,
    hotkeyMode: runtime.hotkeyMode,
    asrProvider: runtime.asrProvider,
    paths: {
      journal: journalPath(),
      settings: settingsPath(),
      bench: benchPath(),
      model: model.path,
      whisperCli: model.whisperCli,
      logs: log.transports.file.getFile().path
    },
    missingPermissions: (snapshot?.permissions ?? [])
      .filter((permission) => !permission.granted)
      .map((permission) => permission.key)
  }
})

/** macOS login items. Failing to set one is a warning, never fatal. */
function applyLaunchAtLogin(next: Settings): void {
  try {
    if (app.getLoginItemSettings().openAtLogin !== next.launchAtLogin) {
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
    }
  } catch (err) {
    log.warn('could not update the login item', err)
  }
}

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
  // Give ⏎ and esc back to the rest of the Mac before we go.
  chords?.release()
  tray?.stop()
  pipeline?.dispose()
  // What this session learned about each app's insertion behaviour — the raw
  // material for docs/INSERTION-MATRIX.md.
  const learned = insertion?.learned() ?? []
  if (learned.length > 0) log.info('insertion: unsupported strategies observed', learned)
  journal?.close()
  void asr?.dispose()
  void sidecar?.dispose?.()
  hudWindow?.destroy()
  captureWindow?.destroy()
})
