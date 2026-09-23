import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  safeStorage,
  screen,
  shell,
  systemPreferences
} from 'electron'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import log from 'electron-log/main'
import {
  CAPTURE_SAMPLE_RATE,
  IDLE_HUD_STATE,
  IPC,
  type CaptureReadyPayload,
  type HudAction,
  type HudState,
  type MullWindow
} from '@shared/ipc'
import type { PlanStep } from '@shared/hud'
import type { JournalEntryView } from '@shared/types'
import type { SidecarApi } from '@shared/sidecar-api'
import {
  benchPath,
  capturesDir,
  credentialsPath,
  journalPath,
  resolveClaudeCliPath,
  resolveSidecarPath,
  settingsPath
} from './locations'
import { Bench } from './bench'
import { Trace } from './trace'
import { selectAsrProvider, SwitchableAsrProvider } from './asr'
import { FakeSidecar, SidecarClient } from './services/sidecar'
import { HotkeyService } from './services/hotkey'
import { describeInsertionReason, InsertionService } from './services/insertion'
import { UndoService } from './services/undo'
import { ChordScope } from './services/chords'
import { HudController } from './services/hud'
import {
  clampPosition,
  defaultPosition,
  nextPosition,
  type Point
} from './services/hud-position'
import { TrayPresence } from './services/tray'
import { PermissionsService } from './services/permissions'
import { downloadModel, modelPathFor, modelStatus } from './services/model'
import { DEFAULT_SPEECH_MODEL, SPEECH_MODELS } from '@shared/model'
import { SettingsStore } from './store/settings'
import { JournalStore } from './store/journal'
import { CaptureStore } from './store/captures'
import { SkillStore } from './store/skills'
import type { SkillRecord } from '@shared/skills'
import { openSqlite } from './store/sqlite'
import { DictationPipeline } from './pipeline/dictation'
import { SculptLane } from './pipeline/sculpt'
import { NavigateLane } from './pipeline/navigate'
import { AgentLane, type AgentRequest } from './pipeline/agent'
import type { NavigateLaneLike } from './pipeline/dictation'
import { TurnMemory, TTL_MS } from './services/turns'
import { TurnStore } from './store/turns'
import { AppleScriptApps } from './services/apps'
import { AppleScriptMenus } from './services/menus'
import { AppleScriptBrowser } from './services/browser'
import { AskLane } from './pipeline/ask'
import { ActionExecutor } from './pipeline/actions'
import { IntentRouter } from './pipeline/intent'
import { appliedText, diffText } from './pipeline/diff'
import { FakeEngine } from './engine/fake'
import { AgentEngine } from './engine/agent'
import { ApiKeyEngine } from './engine/api-key'
import {
  detectClaudeCodeLogin,
  EngineHolder,
  engineStatus,
  inheritedLogin,
  resolveEngine
} from './engine/select'
import { signInWithBrowser } from './engine/oauth'
import { CredentialsStore, type CredentialKind } from './store/credentials'
import type { Engine } from './engine/types'
import type { EngineTestResult } from '@shared/engine'
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
/** The live edit engine, swappable without a relaunch. */
let engine: EngineHolder | null = null
/** The browser sign-in in flight, if any. One at a time — see the handler. */
let browserSignIn: AbortController | null = null
/**
 * The FakeEngine, kept for the two surfaces that must work with no credentials
 * at all: the tray's preview demo and onboarding page 2. Both are explicitly
 * demonstrations; neither pretends to be an engine.
 */
let demoEngine: Engine | null = null
let credentials: CredentialsStore | null = null
let detectedLogin = false
let captures: CaptureStore | null = null
/**
 * What Mull has learned about driving each application.
 *
 * Opened with the journal and null if that failed — a Mull that cannot write to
 * its database still dictates, edits and navigates; it simply stops learning.
 */
let skills: SkillStore | null = null
let sculpt: SculptLane | null = null
let navigate: NavigateLane | null = null
let agent: AgentLane | null = null
/**
 * The last few things the user said, for reading follow-ups against.
 *
 * Bounded and expiring, unlike the journal — this is the conversation Mull is
 * in, not the record of what it did. See `services/turns.ts`.
 *
 * Built empty here and rebuilt in `bootstrap` once the database is open, so a
 * follow-up survives a relaunch. `let` rather than `const` for that reason, and
 * the rebuild happens before anything is handed a reference to it.
 */
let turns = new TurnMemory()
/** Whichever of the two lanes this utterance belongs to. See `bootstrap`. */
let navigateRouter: NavigateLaneLike | null = null
let ask: AskLane | null = null
let intent: IntentRouter | null = null
let settings: SettingsStore | null = null
let permissions: PermissionsService | null = null
/** Filled in at boot; the about pane reports what is actually running. */
let runtime = {
  hotkeyMode: 'unavailable',
  hotkeyTapReason: null as string | null,
  canInstruct: false,
  asrProvider: 'none',
  sidecarVersion: null as string | null
}
let sidecar: SidecarApi & { dispose?: () => Promise<void> }
let asr: SwitchableAsrProvider
/** Why ASR fell back to the fake, or null. Re-evaluated on every reload. */
let asrDegradedReason: string | null = null
/** Bumped per reload, so an overtaken one drops its provider instead of installing it. */
let asrGeneration = 0

/** Windows whose renderer exists. Each M3 stage adds one. */
const BUILT_WINDOWS: MullWindow[] = ['journal', 'settings', 'onboarding']

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
 * The HUD stage. Fixed, so the panel never jitters as a card arrives.
 *
 * 420 was sized for a diff card and nothing else. A finished navigation carries
 * its steps *and* the answer they found, and at 420 the panel it needed was
 * taller than the window holding it — so the top of the card was simply cut off
 * by the window edge, with no scrollbar anywhere, because the overflow belonged
 * to a window and a window does not scroll.
 *
 * The stage is transparent and click-through everywhere the panel is not, so
 * height costs nothing but the room it leaves on screen. The panel is bounded
 * to it in CSS (`.hud`, max-height) and can no longer be clipped whatever the
 * card holds.
 */
const HUD_SIZE = { width: 520, height: 640 }

/**
 * Why the panel takes mouse events, if it does.
 *
 * Two independent reasons, OR'd together. A card wants clicks for its buttons;
 * a pointer resting on the panel wants them so it can be picked up and dragged.
 * Tracking them separately is what stops one turning the other off — the bug
 * where moving the mouse off an open card made Apply stop responding.
 */
const hudInteraction = { hovered: false, cardOpen: false }

function syncHudInteractive(): void {
  const interactive = hudInteraction.hovered || hudInteraction.cardOpen
  // `forward: true` keeps mouse-move flowing to the renderer even while the
  // window is transparent to clicks — which is how the hover is noticed at all.
  hudWindow?.setIgnoreMouseEvents(!interactive, { forward: true })
}

/** Where the HUD should open: where the user last left it, or bottom centre. */
function hudOrigin(): Point {
  const { workArea } = screen.getPrimaryDisplay()
  const saved = settings?.get().hudPosition ?? null
  return saved ? clampPosition(saved, HUD_SIZE, workArea) : defaultPosition(HUD_SIZE, workArea)
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
  const origin = hudOrigin()

  const hud = new BrowserWindow({
    ...HUD_SIZE,
    x: origin.x,
    y: origin.y,
    show: false,
    frame: false,
    type: 'panel',
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false, // the panel casts its own (--shadow-hud)
    focusable: false,
    resizable: false,
    // Dragged by hand rather than by `-webkit-app-region: drag`, which is not
    // dependable on a non-activating panel. See IPC.hudDragMove below.
    movable: true,
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
 * title, because the real one navigates a live window and a tray menu is not
 * the place to start that.
 *
 * Its steps are a fixed list rather than an engine call. They used to come from
 * `FakeEngine.plan()`, which existed only to feed this menu item — and when
 * Stage 5 replaced `plan()` with `navigate()`, keeping a canned plan alive on
 * the seam would have meant a method no product code calls.
 */
async function showDemoCard(kind: 'diff' | 'plan'): Promise<void> {
  if (!hud || !demoEngine) return
  const engine = demoEngine

  const { app: target } = await sidecar.frontmostApp({}).catch(() => ({ app: null }))
  const appInfo = target ? { bundleId: target.bundleId, name: target.name } : null

  if (kind === 'plan') {
    const steps: PlanStep[] = [
      { verb: 'press', object: '“Search”' },
      { verb: 'type', object: '“Priya”' },
      { verb: 'read', object: 'that conversation' }
    ].map((step, index) => ({ ...step, id: `demo-${index}`, state: 'pending' as const }))
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

  // Before the ASR, because which model transcribes you is a setting now and
  // the provider is built around its path.
  settings = new SettingsStore({ path: settingsPath(), log: logFn })

  sidecar = await createSidecar()
  const selection = await selectAsrProvider({ modelPath: selectedModelPath() })
  asr = new SwitchableAsrProvider(selection.provider)
  asrDegradedReason = selection.degradedReason
  if (selection.degradedReason) {
    log.warn(`ASR degraded to the fake provider: ${selection.degradedReason}`)
  }
  if (selection.fallbackFrom) {
    log.warn(
      `speech model ${settings.get().speechModel} is not installed — using ${selection.fallbackFrom}`
    )
  }

  const bench = new Bench(benchPath(), (err) => log.warn('bench write failed', err))

  // A journal that can't open must not take dictation down with it: the loop
  // still works, it just stops remembering. Undo is disabled in that state
  // rather than guessing.
  try {
    const db = openSqlite(journalPath())
    journal = new JournalStore(db)
    const pruned = journal.prune()
    if (pruned > 0) log.info(`journal pruned ${pruned} old entries`)
    // Two more tables in the same file, and both of them optional in exactly the
    // way the journal is: a Mull that cannot open its database still dictates,
    // still edits and still navigates — it simply stops remembering between
    // launches, which is where it was before any of this existed.
    turns = new TurnMemory({ persistence: new TurnStore(db, { ttlMs: TTL_MS, log: logFn }) })
    skills = new SkillStore(db, { log: logFn })
  } catch (err) {
    log.error('journal unavailable — actions will not be recorded or undoable', err)
    journal = null
  }

  permissions = new PermissionsService({
    sidecar,
    microphoneStatus: () => systemPreferences.getMediaAccessStatus('microphone'),
    openExternal: (url) => void shell.openExternal(url),
    log: logFn
  })

  insertion = new InsertionService({ sidecar, log: logFn })
  undo = journal ? new UndoService({ sidecar, journal, log: logFn }) : null

  demoEngine = new FakeEngine()
  credentials = new CredentialsStore({ path: credentialsPath(), safeStorage, log: logFn })
  detectedLogin = detectClaudeCodeLogin()
  engine = new EngineHolder(
    resolveEngine({
      credentials: credentials.get(),
      settings: settings.get(),
      detectedLogin: usableLogin(),
      // A function, not a value: armed on the HUD a second before the user
      // speaks, and it must apply to that utterance rather than the next launch.
      thinking: () => settings?.get().thinking === true,
      log: logFn,
      claudeCliPath: resolveClaudeCliPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath })
    })
  )
  log.info('engine', {
    kind: engine.name,
    ...engineModels(),
    detectedLogin,
    usingDetectedLogin: usableLogin()
  })
  // Bring the subprocess up now rather than on the first edit, which is the
  // one the user is actually waiting for.
  warmEngine()

  chords = new ChordScope({ globalShortcut, log: logFn })
  hud = new HudController({
    chords,
    log: logFn,
    port: {
      send: pushHudState,
      setInteractive: (interactive) => {
        hudInteraction.cardOpen = interactive
        syncHudInteractive()
      }
    }
  })

  tray = new TrayPresence({
    available: BUILT_WINDOWS,
    openWindow: (name) => void openAppWindow(name),
    undoLast: () => void runUndo(),
    demoCard: (kind) => void showDemoCard(kind),
    resetHudPosition: () => resetHudPosition(),
    quit: () => app.quit()
  })
  tray.start()

  // The edit lane. Its HUD port reads `pipeline` and `hud` at call time, which
  // is what lets it be built before the pipeline that hands work to it.
  captures = new CaptureStore({ dir: capturesDir(), log: logFn })

  sculpt = new SculptLane({
    engine,
    sidecar,
    insertion,
    journal: journal ?? undefined,
    captures,
    trace: () => pipeline?.currentTrace() ?? new Trace(),
    bench,
    onJournalChanged: notifyJournalChanged,
    log: logFn,
    hud: {
      update: (patch) => pipeline?.patchState(patch) ?? false,
      announce: (phase, notice, lastAction) =>
        pipeline?.announce(phase, notice, lastAction) ?? false,
      openCard: (card, onAction) => hud?.openCard(card, onAction),
      updateCard: (card) => hud?.updateCard(card),
      closeCard: () => hud?.closeCard()
    }
  })

  // The navigation lane. Shares the same HUD port, and shares nothing else with
  // the edit lane — it writes no text, and the only thing it can put anywhere is
  // a search query.
  navigate = new NavigateLane({
    engine,
    sidecar,
    executor: new ActionExecutor({
      sidecar,
      journal: journal ?? undefined,
      log: logFn
    }),
    // The plan's own row, and the only one that can carry the picture: the
    // executor's per-step rows are written as each press happens, and the
    // photograph was taken at key-down before there was a plan to attach it to.
    journal: journal ?? undefined,
    captures,
    onJournalChanged: notifyJournalChanged,
    // Read per proposal, like `agentLoop` at the dispatch below: the user can
    // flip it in the settings pane between one utterance and the next.
    autoRun: () => settings?.get().autoRun === true,
    hud: {
      openCard: (card, onAction) => hud?.openCard(card, onAction),
      updateCard: (card) => hud?.updateCard(card),
      closeCard: () => hud?.closeCard(),
      update: (patch) => void pipeline?.patchState(patch),
      // All three arguments. The third was dropped here for as long as this
      // lane has existed, so a finished expedition left the idle panel showing
      // whatever had been *dictated* before it — the user asked a question and
      // the row underneath answered with something they said minutes ago. The
      // lane builds a full `HudLastAction` for exactly this (`navigate.ts`), and
      // the sculpt adapter above has always forwarded it.
      announce: (phase, notice, lastAction, turn) =>
        void pipeline?.announce(phase, notice, lastAction, turn)
    },
    trace: () => pipeline?.currentTrace() ?? new Trace(),
    log: logFn
  })

  /**
   * The same job, with the model driving instead of Mull.
   *
   * Built alongside `navigate` rather than instead of it, because the two are
   * deliberately kept side by side while the loop earns its keep. It gets the
   * same ports — the same card, the same journal, the same executor, the same
   * trace — so the only variable between them is who runs the loop.
   */
  // Captured so the closures below do not have to re-narrow it. The holder is
  // stable for the life of the app — `swap` replaces what is *inside* it — so
  // this stays correct across a sign-in or a model change.
  const holder = engine
  agent = new AgentLane({
    sidecar,
    engine,
    executor: new ActionExecutor({ sidecar, journal: journal ?? undefined, log: logFn }),
    // Made once and shared: it holds no state, and the only thing it owns is
    // knowing how to spell a script. See `services/browser.ts` for why this is
    // here rather than behind a sidecar verb.
    browser: new AppleScriptBrowser(),
    apps: new AppleScriptApps(),
    menus: new AppleScriptMenus(),
    run: (run) => holder.runAgent(run),
    journal: journal ?? undefined,
    captures,
    onJournalChanged: notifyJournalChanged,
    // Read per proposal, like `agentLoop` at the dispatch below: the user can
    // flip it in the settings pane between one utterance and the next.
    autoRun: () => settings?.get().autoRun === true,
    // The notebook, and the switch that arms it — both read per run, so a
    // change in Settings takes effect on the next thing you say. Absent when
    // the database would not open, which is the same degrade the journal makes.
    ...(skills ? { skills } : {}),
    useSkills: () => settings?.get().skills === true,
    hud: {
      openCard: (card, onAction) => hud?.openCard(card, onAction),
      updateCard: (card) => hud?.updateCard(card),
      closeCard: () => hud?.closeCard(),
      update: (patch) => void pipeline?.patchState(patch),
      announce: (phase, notice, lastAction, turn) =>
        void pipeline?.announce(phase, notice, lastAction, turn)
    },
    trace: () => pipeline?.currentTrace() ?? new Trace(),
    log: logFn
  })

  /**
   * Which of the two gets this utterance.
   *
   * Decided per utterance rather than at boot, because both inputs move under
   * the app: `swap` replaces the engine whenever the user signs in, signs out or
   * changes model, and the setting is a checkbox. `dictation.ts` sees only
   * `NavigateLaneLike` — one method — so it needs to know about none of this.
   */
  const agentLane = agent
  const stepLane = navigate
  navigateRouter = {
    propose: (request: AgentRequest) =>
      settings?.get().agentLoop && holder.canRunAgent
        ? agentLane.propose(request)
        : stepLane.propose(request)
  }

  // Questions about the window in front of you. Shares the engine's `answer`
  // turn with the navigation lane — a navigation is this with a walk in front
  // of it — and shares nothing else with any lane that writes, because it has
  // no target and its card has no Apply.
  ask = new AskLane({
    engine,
    journal: journal ?? undefined,
    captures,
    onJournalChanged: notifyJournalChanged,
    trace: () => pipeline?.currentTrace() ?? new Trace(),
    log: logFn,
    hud: {
      openCard: (card, onAction) => hud?.openCard(card, onAction),
      updateCard: (card) => hud?.updateCard(card),
      closeCard: () => hud?.closeCard(),
      update: (patch) => void pipeline?.patchState(patch),
      announce: (phase, notice) => void pipeline?.announce(phase, notice)
    }
  })

  // Decides dictate-vs-edit. `useModel` is read per utterance, so switching to
  // rules-only in Settings takes effect on the next thing you say.
  intent = new IntentRouter({
    engine,
    useModel: () => settings?.get().routing !== 'rules',
    // Read per utterance, so "and what about Priya" is judged against the
    // conversation as it stands rather than as it stood at launch.
    recent: () => turns.recent(),
    // The classifier is usually the longest step in the utterance, so its
    // lines belong in the utterance's own trace rather than in a log of their
    // own — "where did the eleven seconds go" is unanswerable otherwise.
    trace: () => pipeline?.currentTrace() ?? { step: () => {} },
    log: logFn
  })

  pipeline = new DictationPipeline(
    {
      sidecar,
      asr,
      bench,
      insertion,
      journal: journal ?? undefined,
      captures: captures ?? undefined,
      sculpt,
      navigate: navigateRouter,
      ask: ask ?? undefined,
      intent,
      turns,
      // Read per utterance, so changing it in Settings takes effect on the
      // next thing you say rather than the next launch.
      screenContext: () => ({
        mode: settings?.get().context ?? 'off',
        excluded: settings?.get().contextExcluded ?? []
      }),
      onState: (state) => hud?.setPipelineState(state),
      log: logFn,
      capture: {
        start: () => captureWindow?.webContents.send(IPC.captureStart),
        stop: () => captureWindow?.webContents.send(IPC.captureStop)
      }
    },
    CAPTURE_SAMPLE_RATE
  )

  // The toggle is persisted, so the panel has to open showing what is actually
  // armed. Without this it reads `false` on every launch while the engine reads
  // the saved value — a switch that disagrees with the thing it switches.
  pipeline.patchState({
    thinking: settings.get().thinking === true,
    autoRun: settings.get().autoRun === true
  })

  if (selection.degradedReason) {
    pushHudState({ ...pipeline.getState(), notice: selection.degradedReason })
  }

  hotkey = new HotkeyService({
    sidecar,
    onStart: (intent) => {
      // A new utterance withdraws whatever proposal was on screen — answered
      // as a cancel, so it lands in the journal rather than vanishing.
      hud?.cancelOpen()
      pipeline?.begin(intent)
    },
    onStop: () => pipeline?.end(),
    log: logFn
  })
  const mode = await hotkey.start(globalShortcut)
  runtime = {
    hotkeyMode: mode,
    hotkeyTapReason: hotkey.tapReason,
    canInstruct: hotkey.canInstruct,
    asrProvider: describeAsr(),
    sidecarVersion: runtime.sidecarVersion
  }
  tray?.setStatus(describeHotkeyMode(mode))
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

  // First run: meet the instrument before being asked for anything. Opened
  // last so the HUD, tray and hotkey are already live behind it — page 5 is a
  // rehearsal with the real key, and a rehearsal needs the app running.
  if (settings.get().onboardingCompletedAt === null) {
    openAppWindow('onboarding')
  }
}

/**
 * The menu-bar status line: what the keys actually do right now.
 *
 * Two of them since M5b, and the second only exists on the tap rung — so this
 * line is also where someone finds out that Fn is doing nothing because Input
 * Monitoring was never granted.
 */
function describeHotkeyMode(mode: string): string {
  const key = '⌥Space'
  switch (mode) {
    case 'tap':
      return `Hold ${key} to dictate · Fn to ask`
    case 'ptt':
      return `Hold ${key} to dictate · Fn needs Input Monitoring`
    case 'ptt-passive':
      return `Hold ${key} — it also reaches the app`
    case 'toggle':
      return `${key} to start, again to stop`
    default:
      return 'Hotkey unavailable — check Settings'
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
/**
 * What Mull has learned, and the two ways to take it back.
 *
 * Beside the journal handlers because they answer the same promise: anything
 * Mull keeps about the user's applications is readable and deletable by the
 * user. A note that could not be deleted would be the one piece of state in the
 * app that the person it is about has no say over.
 */
ipcMain.handle(IPC.skillsList, (): SkillRecord[] => skills?.all() ?? [])

ipcMain.handle(IPC.skillsForget, (_event, id: string): void => {
  skills?.forget(id)
  log.info('skills: forgot one note')
})

ipcMain.handle(IPC.skillsClear, (): void => {
  skills?.clear()
  log.info('skills: forgot everything')
})

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

/**
 * The picture Mull was looking at when it acted.
 *
 * Read from disk on demand rather than carried on every entry: it is a couple
 * of hundred kilobytes and the list query would pay for it on every row to show
 * a one-line summary. Null when there never was one, when it has been pruned
 * away, or when the file has gone — and the row says which, from the reason
 * stored beside it.
 */
ipcMain.handle(IPC.journalCapture, (_event, id: string) => {
  const entry = journal?.get(id)
  const file = captures?.path(entry?.capture?.imageFile ?? null)
  if (!file) return null
  try {
    return `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
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

ipcMain.on(IPC.hudHover, (_event, hovered: boolean) => {
  hudInteraction.hovered = hovered
  syncHudInteractive()
})

/**
 * Dragging the panel.
 *
 * Done by arithmetic rather than `-webkit-app-region: drag`: the HUD window is
 * `focusable: false`, and app-region dragging on a non-activating panel is not
 * something to stake the feature on. The renderer reports screen coordinates
 * (which `MouseEvent` gives it directly), main remembers where the window was
 * when the pointer went down, and every move is origin + delta, clamped.
 */
let hudDrag: { origin: Point; grab: Point } | null = null

ipcMain.on(IPC.hudDragStart, (_event, pointer: Point) => {
  if (!hudWindow || hudWindow.isDestroyed()) return
  const [x = 0, y = 0] = hudWindow.getPosition()
  hudDrag = { origin: { x, y }, grab: pointer }
})

ipcMain.on(IPC.hudDragMove, (_event, pointer: Point) => {
  if (!hudDrag || !hudWindow || hudWindow.isDestroyed()) return
  const { workArea } = screen.getDisplayNearestPoint(pointer)
  const next = nextPosition(hudDrag.origin, hudDrag.grab, pointer, HUD_SIZE, workArea)
  hudWindow.setPosition(next.x, next.y)
})

ipcMain.on(IPC.hudDragEnd, () => {
  if (!hudDrag || !hudWindow || hudWindow.isDestroyed()) return
  hudDrag = null
  const [x = 0, y = 0] = hudWindow.getPosition()
  // Remembered, so the HUD is still out of the way after a relaunch. Moving it
  // once should be enough.
  settings?.set({ hudPosition: { x, y } })
})

/**
 * Arm or disarm thinking for the writing lanes.
 *
 * Persisted, because someone who turned it on for a hard piece of writing
 * usually has a second one — and because a toggle that silently forgets itself
 * on relaunch is worse than no toggle. The engine reads it per turn and
 * restarts its session when the answer changes (`engine/agent.ts`).
 */
ipcMain.handle(IPC.hudSetThinking, (_event, on: boolean) => {
  settings?.set({ thinking: on === true })
  pushHudState({ ...(pipeline?.getState() ?? IDLE_HUD_STATE), thinking: on === true })
  log.info(`thinking ${on ? 'armed' : 'off'} for the writing lanes`)
})

/**
 * Arm or disarm starting a run without pressing Run.
 *
 * Persisted like `thinking`, and read per proposal by both plan lanes rather
 * than captured at boot — see their `autoRun` dep. `patchState` rather than a
 * bare `pushHudState` so the value survives the pipeline's next draw; the
 * thinking handler above predates `patchState` and gets away with it only
 * because the engine, not the panel, is what reads its answer.
 */
ipcMain.handle(IPC.hudSetAutoRun, (_event, on: boolean) => {
  settings?.set({ autoRun: on === true })
  if (!pipeline?.patchState({ autoRun: on === true })) {
    pushHudState({ ...(pipeline?.getState() ?? IDLE_HUD_STATE), autoRun: on === true })
  }
  log.info(`auto-run ${on ? 'armed' : 'off'} — plans ${on ? 'start themselves' : 'wait for Run'}`)
})

/**
 * Correcting what Mull heard, in the panel itself.
 *
 * Whisper gets names wrong — people, projects, channels — and the transcript
 * the user is looking at is the thing the open card was built from. Saying the
 * whole sentence again to fix one word is a bad trade, so the transcript line
 * is a field: click it, fix the word, press ⏎, and the utterance is routed
 * again from the corrected words.
 *
 * Two things have to be borrowed for the length of the correction, and both are
 * things this app otherwise refuses to take:
 *
 *  - **Focus.** The HUD is deliberately never focusable (docs/DESIGN.md §7.1):
 *    it must not take the caret from the app you are dictating into. A field
 *    cannot be typed into without it, so focus is taken for exactly as long as
 *    the field is open and then handed straight back — by name, to the app the
 *    utterance was about, because insertion writes to whatever holds the caret
 *    and "whatever holds the caret" was Mull a moment ago.
 *  - **⏎ and esc.** They are claimed globally while a card is open, and a
 *    global claim outranks a focused window — so without suspending it, Return
 *    in the field would apply the card instead of committing the correction.
 */
let editingApp: { bundleId: string; name: string } | null = null

ipcMain.on(IPC.hudEditBegin, () => {
  if (!hudWindow || hudWindow.isDestroyed()) return
  // The renderer only offers the field while a card is open, and main checks it
  // again rather than trusting that: this message is the one thing in the app
  // that can take the caret out of somebody's document, and a stale one
  // arriving after a card closed would take it for nothing.
  if (!hud?.hasCard) return
  // Remembered now rather than on the way out: the state can move underneath a
  // correction that takes a while, and the app to go back to is the one the
  // user was in when they spoke.
  editingApp = pipeline?.getState().app ?? null
  hud?.setEditing(true)
  hudWindow.setFocusable(true)
  hudWindow.focus()
  log.info('hud: correcting the transcript', { app: editingApp?.name ?? null })
})

ipcMain.handle(IPC.hudEditEnd, async (_event, text: string | null) => {
  const target = editingApp
  editingApp = null
  if (hudWindow && !hudWindow.isDestroyed()) {
    // Blurred first, then made unfocusable: a window that stops being
    // focusable while it is still the key window is a state macOS has no
    // opinion about, and the panel would keep the caret it is trying to return.
    hudWindow.blur()
    hudWindow.setFocusable(false)
  }
  hud?.setEditing(false)

  // Put the caret back before anything else happens. Awaited rather than fired
  // and forgotten: the next thing on this path may be an Apply that types into
  // whatever is frontmost, and "whatever is frontmost" is the thing being fixed
  // here.
  if (target) {
    try {
      const result = await sidecar?.activateApp({ bundleId: target.bundleId })
      if (result && !result.activated) {
        log.warn('hud: could not put focus back', { app: target.name, reason: result.reason })
      }
    } catch (err) {
      log.warn('hud: activateApp threw on the way out of a correction', err)
    }
  }

  const corrected = typeof text === 'string' ? text.trim() : ''
  if (!corrected) return

  // Same withdrawal a new utterance performs — the open card was built from the
  // words that have just been overruled, so it is answered as a cancel and
  // lands in the journal rather than vanishing.
  hud?.cancelOpen()
  await pipeline?.rerun(corrected)
})

ipcMain.handle(IPC.hudResetPosition, () => resetHudPosition())

/** Back to bottom centre — the way out of "I dragged it somewhere silly". */
function resetHudPosition(): void {
  settings?.set({ hudPosition: null })
  if (!hudWindow || hudWindow.isDestroyed()) return
  const { workArea } = screen.getPrimaryDisplay()
  const home = defaultPosition(HUD_SIZE, workArea)
  hudWindow.setPosition(home.x, home.y)
}

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
  const before = settings?.get()
  const next = settings?.set(patch) ?? null
  if (next) {
    // Which lane and which models are engine-shaping, so the change has to
    // reach the holder — otherwise picking "Fast" would keep using the careful
    // model until the next launch, and quietly. All three model settings are
    // listed because each is baked into the engine at construction: the two
    // session models when the sessions are built, the loop's when `runAgent`
    // reads it.
    const reshaped =
      before !== undefined &&
      before !== null &&
      (before.engine !== next.engine ||
        before.editModel !== next.editModel ||
        before.classifierModel !== next.classifierModel ||
        before.agentModel !== next.agentModel ||
        before.inheritClaudeCodeLogin !== next.inheritClaudeCodeLogin)
    if (reshaped) reloadEngine()
    // The speech model is not engine-shaped — it is the local transcriber, and
    // it lives behind its own holder for the same reason the engine does.
    if (before && before.speechModel !== next.speechModel) void reloadAsr()
    // Every window stamps its own theme, so the change has to reach all of
    // them — including the HUD, which has its own "page in the dark" rule.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.settingsChanged, next)
    }
    applyLaunchAtLogin(next)
  }
  return next
})

/** A warm subprocess is the difference between 1.2 s and 2 s on the first edit. */
function warmEngine(): void {
  const current = engine?.current
  if (current instanceof AgentEngine) current.warm()
}

/**
 * All three models, for the log.
 *
 * `Engine.model` is the edit model alone, so a line saying which engine came
 * up used to say nothing about how routing or the loop were configured — and
 * those are settings-shaped problems, the kind found in a log file afterwards
 * rather than caught in the moment. Undefined keys are omitted by the logger,
 * so a signed-out engine still prints one clean line.
 */
function engineModels(): Record<string, string | null | undefined> {
  const current = engine?.current
  return {
    model: current?.model ?? null,
    classifier: current instanceof AgentEngine || current instanceof ApiKeyEngine
      ? current.classifierModel
      : undefined,
    agent: current instanceof AgentEngine ? current.agentModel : undefined
  }
}

/**
 * Rebuild the engine from whatever the credentials and settings now say.
 *
 * Called after every sign-in, sign-out and model change, so pasting a token
 * takes effect on the next utterance rather than after a relaunch. The holder
 * disposes the engine it replaces, so a warm subprocess never outlives the
 * credential that started it.
 */
function reloadEngine(): void {
  if (!engine || !credentials || !settings) return
  engine.swap(
    resolveEngine({
      credentials: credentials.get(),
      settings: settings.get(),
      detectedLogin: usableLogin(),
      // A function, not a value: armed on the HUD a second before the user
      // speaks, and it must apply to that utterance rather than the next launch.
      thinking: () => settings?.get().thinking === true,
      log: logFn,
      claudeCliPath: resolveClaudeCliPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath })
    })
  )
  log.info('engine reloaded', { kind: engine.name, ...engineModels() })
  // A new engine deserves its own chance at the classifier: what was measured
  // too slow was the old one, and an API key answers far faster than the
  // subscription lane's harness does.
  intent?.reset()
  warmEngine()
}

/** The shared rule, asked of this process's detection and settings. */
function usableLogin(): boolean {
  return inheritedLogin(detectedLogin, settings?.get() ?? { inheritClaudeCodeLogin: true })
}

/** The path of whatever model Settings currently points at. */
function selectedModelPath(): string {
  return modelPathFor(settings?.get().speechModel ?? DEFAULT_SPEECH_MODEL)
}

/** What the About pane calls the provider in use. */
function describeAsr(): string {
  if (asrDegradedReason) return 'fake (degraded)'
  return asr?.name ?? 'none'
}

/**
 * Rebuild the ASR around the model Settings now names.
 *
 * Called when the setting changes and after a download finishes, so switching
 * to `small.en` — or finally fetching it — takes effect on the next thing you
 * say rather than after a relaunch. An utterance already in flight keeps the
 * provider it started with; the holder only changes what the *next* one gets.
 *
 * A model that is not on disk degrades to the fake provider and says so in the
 * log, exactly as an empty models directory does at boot. That is the honest
 * outcome of choosing a model you have not downloaded, and Settings warns
 * about it in the same breath as offering the choice.
 */
async function reloadAsr(): Promise<void> {
  if (!asr) return
  // Two clicks in quick succession would otherwise race, and the slower reload
  // would win — leaving the app transcribing with the model the user un-picked.
  const generation = ++asrGeneration
  const selection = await selectAsrProvider({ modelPath: selectedModelPath() })
  if (generation !== asrGeneration) {
    await selection.provider.dispose()
    return
  }
  asrDegradedReason = selection.degradedReason
  await asr.swap(selection.provider)
  runtime = { ...runtime, asrProvider: describeAsr() }
  if (selection.degradedReason) {
    log.warn(`ASR degraded to the fake provider: ${selection.degradedReason}`)
  } else {
    log.info('ASR reloaded', { model: selectedModelPath().split('/').pop() })
  }
}

ipcMain.handle(IPC.engineStatus, async () => {
  if (!engine || !credentials) return null
  return engineStatus(engine, credentials.presence(), detectedLogin)
})

/**
 * Save a credential.
 *
 * The secret arrives, is encrypted, and is never spoken of again: the reply is
 * the same status object every other caller gets, carrying presence and not
 * value. A `safeStorage` that cannot encrypt is reported as the refusal it is.
 */
ipcMain.handle(IPC.engineSignIn, async (_event, kind: CredentialKind, secret: string) => {
  if (!credentials) return { ok: false, message: 'Mull hasn’t finished starting up.' }
  try {
    credentials.set(kind, secret)
    reloadEngine()
    return { ok: true, message: kind === 'api-key' ? 'API key saved.' : 'Token saved.' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Deliberately not `log.error(err)` — an encryption failure can carry the
    // input it choked on, and that input is the secret.
    log.warn(`engine: could not save the ${kind} credential`)
    return { ok: false, message }
  }
})

/**
 * Sign in through the browser — the whole of `claude setup-token`, in-app.
 *
 * Only one at a time: a second click while a browser tab is already open would
 * open another with a different `state`, and whichever the person finished
 * would leave the other listening on a port nobody is going to visit. So the
 * flow is held here, the second click is told what the first one is doing, and
 * Cancel aborts the one that exists.
 *
 * The token is stored and the engine rebuilt in the same breath, so the next
 * edit uses it — the same guarantee pasting a token already gives.
 */
ipcMain.handle(IPC.engineSignInBrowser, async () => {
  if (!credentials) return { ok: false, message: 'Mull hasn’t finished starting up.' }
  if (browserSignIn) {
    return { ok: false, message: 'Already waiting — finish the sign-in in your browser.' }
  }

  const abort = new AbortController()
  browserSignIn = abort
  try {
    const token = await signInWithBrowser({
      openUrl: (url) => shell.openExternal(url),
      signal: abort.signal,
      log: logFn
    })
    credentials.set('subscription', token)
    reloadEngine()
    return { ok: true, message: 'Signed in with your Claude subscription.' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The message is safe to log; the token, had there been one, never is.
    log.warn(`engine: browser sign-in did not finish — ${message}`)
    return { ok: false, message }
  } finally {
    browserSignIn = null
  }
})

ipcMain.handle(IPC.engineSignInCancel, () => {
  browserSignIn?.abort()
})

ipcMain.handle(IPC.engineSignOut, (_event, kind: CredentialKind) => {
  credentials?.set(kind, null)
  reloadEngine()
  return credentials?.presence() ?? null
})

/**
 * One real edit, end to end.
 *
 * A credential that saved is not a credential that works — the token can be
 * revoked, the key can be for the wrong workspace, the machine can be offline.
 * This is the only honest way for the settings pane to show a ✓, and it is the
 * same rule the permission rows already follow.
 */
ipcMain.handle(IPC.engineTest, async (): Promise<EngineTestResult> => {
  if (!engine) return { ok: false, message: 'Mull hasn’t finished starting up.', firstTokenMs: null }
  const startedAt = Date.now()
  let firstTokenMs: number | null = null
  try {
    const result = await engine.transform(
      {
        instruction: 'Reply with the passage unchanged.',
        text: 'ready',
        app: null
      },
      () => {
        firstTokenMs ??= Date.now() - startedAt
      }
    )
    const took = Date.now() - startedAt
    return {
      ok: result.text.length > 0,
      message: `Connected — ${engine.model ?? 'the engine'} answered in ${took} ms.`,
      firstTokenMs
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('engine test failed', message)
    return { ok: false, message, firstTokenMs }
  }
})

ipcMain.handle(IPC.permissionsGet, () => permissions?.snapshot() ?? null)
/**
 * Grant. Prompts where macOS has an API for it, and opens the pane either way.
 *
 * It used to only open the pane, which is fine for Microphone and Input
 * Monitoring and is **not** fine for Screen Recording: an app that has never
 * called `CGRequestScreenCaptureAccess` does not appear in that list at all, so
 * opening it showed the user a pane with no Mull in it and no way to add one.
 * The request is what registers the app; the pane is where they flip it.
 */
ipcMain.handle(IPC.permissionsOpen, (_event, key: PermissionKey) => permissions?.prompt(key))

/** Defaults to the selected model, so a caller that does not care gets the live one. */
ipcMain.handle(IPC.modelStatus, (_event, name?: string) =>
  modelStatus(name ?? settings?.get().speechModel ?? DEFAULT_SPEECH_MODEL)
)

/** Every model on offer, in catalog order — the settings pane lists them all. */
ipcMain.handle(IPC.modelList, () =>
  Promise.all(SPEECH_MODELS.map((model) => modelStatus(model.id)))
)

/**
 * Download a speech model. Only ever from a click — onboarding page 4 and
 * the settings pane are the two callers, and both are explicit.
 *
 * If what arrived is the model Settings points at, the ASR is rebuilt around
 * it here rather than at the next launch: the person who just waited out a
 * 488 MB download should be able to speak into it immediately.
 */
ipcMain.handle(IPC.modelDownload, async (event, name?: string) => {
  const wanted = name ?? settings?.get().speechModel ?? DEFAULT_SPEECH_MODEL
  try {
    await downloadModel(wanted, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.modelProgress, progress)
    })
    if (wanted === (settings?.get().speechModel ?? DEFAULT_SPEECH_MODEL)) await reloadAsr()
    return { ok: true, message: 'The model is ready.' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('model download failed', err)
    return { ok: false, message: `Download failed: ${message}` }
  }
})

ipcMain.handle(IPC.about, async (): Promise<AboutInfo> => {
  const snapshot = await permissions?.snapshot()
  const model = await modelStatus(settings?.get().speechModel ?? DEFAULT_SPEECH_MODEL)
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    sidecarVersion: runtime.sidecarVersion,
    sidecarProtocol: runtime.sidecarVersion ? SIDECAR_PROTOCOL_VERSION : null,
    hotkeyMode: runtime.hotkeyMode,
    hotkeyTapReason: runtime.hotkeyTapReason,
    canInstruct: runtime.canInstruct,
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

/**
 * The canonical edit, for onboarding page 2.
 *
 * Runs the real engine and the real differ, so what the page demonstrates is
 * what the app does — a hand-written sample would drift the first time either
 * changes.
 */
ipcMain.handle(IPC.sampleEdit, async () => {
  // The fake, on purpose. Page 2 teaches what the marks mean, and it has to do
  // that on a Mac that has never signed in to anything — which is every Mac,
  // the first time onboarding runs.
  if (!demoEngine) return null
  const result = await demoEngine.transform(
    { instruction: 'tighten this up and make it sound less apologetic', text: '', app: null },
    undefined
  )
  const { segments, changes } = diffText(CANONICAL_DEMO_TEXT, result.text)
  return { kind: 'diff' as const, app: 'Mail', segments, changes }
})

ipcMain.handle(IPC.onboardingDone, () => {
  settings?.set({ onboardingCompletedAt: Date.now() })
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
