import type { ScreenContext } from '@shared/context'
import type { SidecarApi, UiTarget } from '@shared/sidecar-api'
import {
  browserOf,
  checkMenuCommand,
  checkUrl,
  FIND_LIMIT,
  MAX_KEY_REPEAT,
  type AgentKey
} from '@shared/agent'
import { renderApps, renderContext, renderMenus, renderTabs, renderTargets } from '../engine/prompts'
import type { AppsBridge } from '../services/apps'
import type { MenuCommand, MenusBridge } from '../services/menus'
import { ScriptError } from '../services/osascript'
import type { BrowserBridge, BrowserTab } from '../services/browser'
import type { ActionExecutor, Scan } from './actions'
import { describeChange } from './navigate'

/**
 * What the five tools actually do.
 *
 * Deliberately separate from the loop that calls them (`engine/agent-loop.ts`)
 * and from the lane that shows them (`pipeline/agent.ts`), because these are the
 * only part of the agent that touches the machine and they should be readable
 * and testable without a subprocess anywhere near them. Every one of them is a
 * plain async function over a `SidecarApi` and an `ActionExecutor`.
 *
 * ### The guard
 *
 * Every handler begins by asking whether the run is still wanted. That is
 * belt-and-braces — `canUseTool` refuses first and its refusal is synchronous,
 * so nothing should ever reach here after a stop — but the two failure modes are
 * different enough to be worth both. `canUseTool` protects against a tool call
 * the model has already emitted; this protects against a handler that was
 * already *running* when the user pressed Escape and is about to take its second
 * round trip. And unlike the permission callback it can be unit-tested without
 * the SDK, which is why the stop's tests live here.
 *
 * ### Why the results are prose
 *
 * A tool result is read by a model, not parsed by code, and these reuse the
 * exact renderers the questionnaire used — `renderContext` and `renderTargets`
 * from `engine/prompts.ts`. The model reads a numbered list better than it reads
 * a serialization of one, and every token spent on braces is a token not spent
 * on what the window says.
 */

/** Everything the handlers share. One object, made per run by the lane. */
export interface ToolContext {
  sidecar: SidecarApi
  executor: ActionExecutor
  /** The plan the steps belong to — carried into each journal row. */
  plan: { app: { bundleId: string; name: string } | null; goal: string; groupId: string }
  /** Is the run still wanted? Read before every act. */
  stopped: () => boolean
  /** The scan the model is currently choosing from. Owned here. */
  scan: Scan | null
  /**
   * The window as it looked just before the last press, and the row that press
   * wrote.
   *
   * `AXPress` reports that an action was *accepted*, not that it did anything,
   * and the executor's window-title check is right when a press changes windows
   * and silent when it opens an overlay — which is most of what a press does. So
   * the honest answer only exists on the *next* look, and this is what carries
   * the question that far. See `describeChange`.
   */
  pressed: { scan: Scan; entryId?: string } | null
  /**
   * The last window text a `look` returned.
   *
   * The answer is written from this rather than from a fresh read, because by
   * the time the run ends the window has been put back — and answering from a
   * window you have already left is how a plan reports on the wrong thing.
   */
  read: ScreenContext | null
  /** How many acts have been taken, so a step can be numbered. */
  steps: number
  /**
   * Browsers this run has already waited on for a page, by bundle id.
   *
   * Cleared whenever the run navigates, because a new document deserves a fresh
   * wait — see `rescan`. Lazily created like `knownHosts` below, so no caller
   * has to construct one.
   */
  pageWaits?: Set<string>
  /**
   * The browser's own tab model, when there is a browser in front.
   *
   * Null in every test that does not care and on every machine where the user
   * has not granted Automation — the three browser tools then say so in a
   * sentence rather than throwing, which is the whole degradation story.
   */
  browser?: BrowserBridge | null
  /**
   * What else is running, when this machine will say.
   *
   * Absent exactly like `browser` is, and with the same consequence: the two
   * cross-app tools refuse in a sentence and the run carries on inside one
   * window. That is also what a user who has declined the System Events consent
   * dialog gets, so it is a path worth having rather than asserting away.
   */
  apps?: AppsBridge | null
  /**
   * Applications this run has actually been shown, by bundle id.
   *
   * `switchApp` refuses anything not in here. Seeded with the app the run
   * started in and filled by `apps`, so an id is always one Mull produced rather
   * than one the model recalled or read off a page — the same argument
   * `knownHosts` makes below, for the same reason.
   */
  knownApps?: Map<string, string>
  /**
   * The front application's own command surface, when this machine will say.
   *
   * Absent the same way `browser` and `apps` are, with the same degradation: the
   * two menu tools refuse in a sentence and the run carries on from what is on
   * the screen. It is the same System Events consent as `apps`, so a machine
   * that has one has both.
   */
  menus?: MenusBridge | null
  /**
   * Commands this run has actually been shown, keyed by heading and name.
   *
   * `chooseMenu` refuses anything not in here — the same rule as `knownApps`,
   * and here it is carrying more weight than it does there. `activateApp` would
   * fail on its own for an app that is not running; a menu path the model
   * invented could name a real command, so this is the difference between
   * choosing from a list Mull read and choosing from one the model composed.
   *
   * The whole `MenuCommand` rather than a name, because the refusals that matter
   * at choose time — greyed out, opens a submenu — are facts from the read.
   */
  knownMenus?: Map<string, MenuCommand>
  /**
   * What is actually frontmost, which is not always `plan.app`.
   *
   * `plan.app` is what the utterance was routed against and is carried into
   * journal rows; this is where the hands are. They agree almost always, and the
   * browser tools need the one that is true rather than the one that was
   * recorded.
   */
  front?: { bundleId: string; name: string } | null
  /**
   * Sites already open when this run looked.
   *
   * `checkUrl`'s third rule reads this: a host the agent could already see the
   * inside of may be addressed with a query string, because a query string tells
   * it nothing it did not have. Filled in by `tabs`, which means the freedom is
   * earned by looking rather than granted at the start.
   */
  knownHosts?: Set<string>
  /** Annotate a step's row once its effect is finally visible. */
  amend?: (entryId: string, evidence: string) => void
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

/** What a handler gives back: prose for the model, a clause for the card. */
export interface ToolOutcome {
  /** What the model is told. */
  text: string
  /** One clause for the card's step row, when this act deserves one. */
  detail?: string
  /**
   * What the *log* should say, when the card and the log want different things.
   *
   * Only `switchApp` and `chooseMenu` need it, and for a documented reason: both
   * deliberately leave `detail` empty so the card keeps showing the model's
   * "why" rather than overwriting it with the destination. That is right for the
   * card and wrong for `main.log`, where it produced `act.go to n=2 ok=true` —
   * a switch with no record of what it switched to. A run that asked for Arc and
   * silently spent the next fifty seconds inside Chrome left no trace of the
   * moment it changed its mind.
   */
  trace?: string
  /** False when the act was refused or failed — the card marks the step. */
  ok?: boolean
  /**
   * The journal row a press wrote, so the lane can annotate it later.
   *
   * Whether a press moved anything is only visible from the *next* look at the
   * window, by which time the row exists. The id is how the evidence finds its
   * way home — see `JournalStore.amend`.
   */
  entryId?: string
}

/** The sentence a stopped run gives back instead of doing anything. */
export const STOPPED_MESSAGE =
  'the user stopped this run — take no further action and do not try again'

const STOPPED: ToolOutcome = { text: STOPPED_MESSAGE, ok: false, detail: 'stopped' }

// ---------------------------------------------------------------------------

/**
 * How much of a window one look is allowed to take in.
 *
 * The same numbers the questionnaire used (`pipeline/navigate.ts`), and for the
 * same reasons: 300 targets because Chrome showing Gmail returns 254 distinct
 * ones and a smaller cap stopped inside Chrome's own toolbar, and a 2s deadline
 * because that window takes ~500ms to walk.
 */
const SCAN_BUDGET = { maxTargets: 300, deadlineMs: 2_000 } as const
const READ_BUDGET = { maxChars: 6_000, screenshot: false } as const

/** Chromium builds its tree lazily; the same handshake `captureContext` uses. */
const TREE_ATTEMPTS = 3
const TREE_POLL_MS = 350

/**
 * How long to keep asking a browser that is not showing us its page.
 *
 * Longer and slower than the tree-warming handshake above, because it is a
 * different wait. That one is a tree being built inside a process that has
 * already agreed to build it, and it lands in a few hundred milliseconds. This
 * one is a document: a page that was navigated to a moment ago has to load
 * before it has an accessibility tree to expose, and a second is not unusual.
 *
 * Bounded at roughly two and a half seconds, and spent at most once per app
 * between navigations — see `pageWaits`. The alternative to bounding it is the
 * behaviour this replaces, where a cold browser was handed over as an ordinary
 * result and the model spent twelve turns and thirty-eight seconds discovering
 * the page was not there.
 */
const COLD_ATTEMPTS = 4
const COLD_POLL_MS = 600

/**
 * What a browser that is not showing us its page gets told, in one place.
 *
 * `look` said this and `find` did not, which is how the failing run went the
 * way it did: the model asked `find "Create event"`, was told *nothing here
 * matches, there are 18 things in this window*, and drew the only available
 * conclusion — wrong page, navigate again. Every tool that can be the first to
 * meet a cold browser has to say the same thing, so there is one sentence and
 * both of them use it.
 *
 * It names the remedy rather than the mechanism. "Chromium builds its renderer
 * accessibility lazily" is true and helps nobody decide what to do next.
 */
const PAGE_NOT_VISIBLE =
  'this browser is not sharing the page — only its own toolbar is visible, so ' +
  'nothing on the page itself can be read or pressed. Opening the address again ' +
  'will not change that. The tabs tool still works: it can say what is open and ' +
  'move between pages. If the answer needs the page itself, say so and finish — ' +
  'and say that turning on “Native accessibility API support” at ' +
  'chrome://accessibility is what fixes it, because the user is the only one who ' +
  'can.'

/**
 * How long between two presses of the same key.
 *
 * Not politeness. A repeated key with no gap arrives as a burst the target app
 * coalesces — ten `pageDown`s posted back to back scroll about three pages,
 * because AppKit drops the ones that land while it is still laying out the last.
 */
const KEY_GAP_MS = 60

/**
 * How long to let an application settle after it comes to the front.
 *
 * Four times what a press settles for, and `AGENT-V2.md` §10's E8′ is the
 * measurement that should eventually replace this guess. An activation is not
 * one event: the app comes forward, its window server session becomes active,
 * and if it was on another Space the whole screen animates across — and nothing
 * will answer an accessibility query honestly until that finishes. Scanning too
 * early returns the *old* app's tree, which is the worst available failure
 * because it looks exactly like a successful scan.
 */
const SWITCH_SETTLE_MS = 1_000

/**
 * How long to let a menu command land.
 *
 * Between a press and an app switch, because a menu command is somewhere between
 * the two: it can be as small as toggling a sidebar and as large as opening a
 * document window, and unlike a press it has to close the menu it opened first.
 * The cost of being short here is a scan of a screen that is still animating.
 */
const MENU_SETTLE_MS = 900

export async function look(
  context: ToolContext,
  input: { want: 'text' | 'targets' | 'both' },
  sleep: (ms: number) => Promise<void>
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const parts: string[] = []
  let detail = ''

  if (input.want !== 'targets') {
    const seen = await context.sidecar.windowContext(READ_BUDGET)
    const chars = seen.blocks.reduce((n, block) => n + block.text.length, 0)
    const read: ScreenContext = {
      app: context.plan.app,
      windowTitle: seen.windowTitle,
      blocks: seen.blocks,
      truncated: seen.truncated,
      // No picture. One was taken at key-down and the model has already seen it;
      // the words are what moved since then.
      image: null,
      imageReason: 'not-retaken-mid-run',
      chars,
      harvestMs: seen.harvestMs
    }
    // Kept even when empty is the wrong call — an empty read would overwrite a
    // good one from a window we have since left, and the answer is written from
    // whatever is here at the end.
    if (chars > 0) context.read = read
    parts.push(renderContext(read) ?? '<screen>\nthis window has no readable text\n</screen>')
    detail = `${seen.blocks.length} blocks · ${chars} chars`
  }

  if (input.want !== 'text') {
    const scan = await rescan(context, sleep)
    context.scan = scan
    if (scan.stoppedBy === 'browser-cold') {
      /**
       * Named as the app's own remedy rather than described as a mechanism.
       * "Chromium builds its renderer accessibility tree lazily" is true and
       * helps nobody.
       *
       * What changed here is the last sentence. This used to end "say so and
       * finish", because there was nothing else to try — a cold tree meant the
       * page was unreachable and the run was over. The tab tools do not go
       * through the tree at all, so a cold browser can still say what it has
       * open and still be moved between pages. That is not the whole page back,
       * but it is the difference between a dead end and a narrower road.
       */
      parts.push(`<targets>\n${PAGE_NOT_VISIBLE}\n</targets>`)
    } else {
      parts.push(renderTargets(scan.targets, undefined, scan.stoppedBy))
    }
    detail = detail ? `${detail} · ${scan.targets.length} targets` : `${scan.targets.length} targets`
    const note = treeNote(scan)
    if (note) detail = `${detail} · ${note}`
  }

  /**
   * Did the last press actually do anything?
   *
   * The only honest answer compares the window before against the window after,
   * because that is the only comparison that can see an overlay open. The
   * executor's title check cannot: a Slack search box opening took the list
   * from 300 entries to 6 and left the title alone.
   *
   * ### Why this is no longer inside the targets branch
   *
   * It used to be, on the reasoning that a look which scans has the comparison
   * in hand for free. True, but it made the evidence conditional on the model
   * happening to ask for targets — and "press the DM, then read it" is a
   * natural shape that asks for text. One real run pressed six times and looked
   * with `want: 'text'` after each, so the verdict never arrived once; all the
   * model ever heard was the executor saying the title had not changed, and it
   * spent twenty-five turns disbelieving presses that had all worked.
   *
   * So a pending press now buys its own scan if the caller did not ask for one.
   * That is one tree walk, against the three or four turns of re-pressing that
   * saying nothing was costing.
   */
  const pressed = context.pressed
  if (pressed) {
    const after = context.scan ?? (context.scan = await rescan(context, sleep))
    context.pressed = null
    const change = describeChange(pressed.scan, after)
    parts.push(change.detail)
    // Worth a word in the trace too: the log could say what was pressed and
    // never whether it landed.
    detail = detail ? `${detail} · ${change.moved ? 'moved' : 'no change'}` : ''
    // The same sentence, written onto the row that press already wrote — the
    // evidence only exists one turn after the row does.
    if (pressed.entryId) context.amend?.(pressed.entryId, change.detail)
  }

  return { text: parts.join('\n\n'), detail, ok: true }
}

export async function find(
  context: ToolContext,
  input: { query: string; kind?: 'press' | 'type' },
  sleep: (ms: number) => Promise<void>
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  // A `find` with no scan behind it is the common opening move, and failing it
  // would teach the model to call `look` first purely as a ritual.
  const scan = context.scan ?? (context.scan = await rescan(context, sleep))

  // Before looking for a match, say whether there was anything to match. A
  // browser with no page in it has targets — its own toolbar — so `findTargets`
  // runs happily and reports an honest, useless nothing.
  if (scan.stoppedBy === 'browser-cold') {
    return {
      text: PAGE_NOT_VISIBLE,
      detail: `“${input.query}” — no page${treeNote(scan) ? ` · ${treeNote(scan)}` : ''}`,
      ok: false
    }
  }

  const hits = findTargets(scan.targets, input.query, input.kind)

  if (hits.length === 0) {
    return {
      text:
        `nothing here matches “${input.query}”. There are ${scan.targets.length} things ` +
        'in this window; look at them, or try a word that would appear in the label itself.',
      // A find that matched nothing is the exact moment the question "was there
      // anything here to match?" gets asked, so this is where the tree note
      // earns its place.
      detail: `“${input.query}” — nothing${treeNote(scan) ? ` · ${treeNote(scan)}` : ''}`,
      ok: true
    }
  }
  return {
    text: renderTargets(hits),
    detail: `“${input.query}” — ${hits.length} of ${scan.targets.length}`,
    ok: true
  }
}

export async function press(
  context: ToolContext,
  input: { index: number; expectTitle: string }
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const scan = context.scan
  if (!scan) {
    return {
      text: 'you have not looked at this window yet — call look or find first',
      detail: 'pressed before looking',
      ok: false
    }
  }
  const target = scan.targets[input.index]
  if (!target) {
    return {
      text: `there is no target ${input.index} in the list you were shown`,
      detail: `no target ${input.index}`,
      ok: false
    }
  }

  context.steps += 1
  const result = await context.executor.perform(
    { verb: 'press', index: input.index, label: input.expectTitle },
    scan,
    { ...context.plan, step: context.steps }
  )

  // The scan is dead the moment something is pressed: the window it described
  // may have been replaced entirely. Dropping it here is what stops the next
  // press being aimed at a list that no longer exists.
  const before = scan
  context.scan = null

  if (!result.ok) {
    return { text: `that did not work: ${result.detail}`, detail: result.detail, ok: false }
  }

  // Held for the next look, which is the first moment anyone can tell whether
  // this press did anything at all.
  context.pressed = { scan: before, ...(result.entryId ? { entryId: result.entryId } : {}) }
  return {
    text:
      `pressed “${target.title}” — ${result.detail}. ` +
      `Look again before pressing anything else; the ${before.targets.length} numbers ` +
      'you were shown no longer mean anything.',
    detail: result.detail,
    ok: true,
    ...(result.entryId ? { entryId: result.entryId } : {})
  }
}

/**
 * Put text into a field.
 *
 * Shares `press`'s discipline exactly — the scan must exist, the index must be
 * in it, the title is quoted back and checked before anything is written — and
 * adds one thing a press does not need: it says what the field held before, so
 * a write that replaced something says so on the card and in the journal.
 *
 * It does **not** drop the scan afterwards. Typing into a form rarely rebuilds
 * the window, and a run filling in four fields should not have to re-read the
 * list four times. A press does; this does not; and when an autocomplete does
 * replace the list, the next `look` says so through `describeChange`.
 */
export async function setText(
  context: ToolContext,
  input: { index: number; expectTitle: string; text: string }
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const scan = context.scan
  if (!scan) {
    return {
      text: 'you have not looked at this window yet — call look or find first',
      detail: 'typed before looking',
      ok: false
    }
  }
  const target = scan.targets[input.index]
  if (!target) {
    return {
      text: `there is no target ${input.index} in the list you were shown`,
      detail: `no target ${input.index}`,
      ok: false
    }
  }
  if (target.kind !== 'type') {
    return {
      text:
        `“${target.title}” does not take text — it is a ${target.role.replace(/^AX/, '').toLowerCase()}. ` +
        'Press it instead, or find a field.',
      detail: `${target.title} is not a text control`,
      ok: false
    }
  }

  context.steps += 1
  const result = await context.executor.perform(
    { verb: 'type', index: input.index, text: input.text },
    scan,
    { ...context.plan, step: context.steps }
  )

  if (!result.ok) {
    return { text: `that did not work: ${result.detail}`, detail: result.detail, ok: false }
  }
  return {
    text:
      `put “${input.text}” into “${target.title}”` +
      (result.before ? `, replacing “${result.before}”. ` : '. ') +
      'Nothing has been submitted — look again to see what the field did with it.',
    detail: result.detail,
    ok: true,
    ...(result.entryId ? { entryId: result.entryId } : {})
  }
}

/**
 * Press a navigation key.
 *
 * Mostly a reading tool — see `KeyInputSchema`. A window's text harvest is
 * capped and a long thread is mostly below the fold, and `pageDown` is the only
 * thing in this vocabulary that reaches the rest of it.
 *
 * Goes through `sidecar.navKey`, which is the verb that structurally cannot
 * express Return, rather than through `keyChord`, which can. That choice is the
 * whole safety argument and it is made here, once, by picking a method name.
 *
 * Like `setText` and unlike `press`, it keeps the scan: paging down a document
 * does not renumber its buttons, and an arrow key in a list moves a highlight
 * rather than rebuilding the window. When something *has* changed underneath,
 * the next `look` says so through `describeChange` — the same way a write does.
 */
export async function key(
  context: ToolContext,
  input: { key: AgentKey; times?: number },
  sleep: (ms: number) => Promise<void>
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const times = Math.min(Math.max(input.times ?? 1, 1), MAX_KEY_REPEAT)
  context.steps += 1

  let sent = 0
  for (let n = 0; n < times; n += 1) {
    // Checked inside the loop, not only before it: ten pageDowns is a second or
    // more of wall-clock, and a stop pressed during it should take effect at the
    // next key rather than after the tenth.
    if (context.stopped()) break
    const went = await context.sidecar.navKey({ key: input.key })
    if (!went.sent) {
      return {
        text:
          `${input.key} would not go through${went.reason ? `: ${went.reason}` : ''}. ` +
          'Try pressing something instead.',
        detail: went.reason ?? `${input.key} refused`,
        ok: false
      }
    }
    sent += 1
    if (n + 1 < times) await sleep(KEY_GAP_MS)
  }

  if (sent === 0) return STOPPED
  // The page has almost certainly moved, and the text the model is holding is of
  // where it used to be. Saying so is what stops it answering from a stale read.
  if (input.key === 'pageDown' || input.key === 'pageUp') context.read = null

  return {
    text:
      `pressed ${input.key}${sent > 1 ? ` ${sent} times` : ''}. ` +
      'Look again to see what moved — nothing was submitted.',
    detail: sent > 1 ? `${input.key} ×${sent}` : input.key,
    ok: true
  }
}

export function note(context: ToolContext, input: { text: string }): ToolOutcome {
  if (context.stopped()) return STOPPED
  return { text: 'noted', detail: input.text, ok: true }
}

// ---------------------------------------------------------------------------
// Going somewhere else. See `services/apps.ts` for why the list is an Apple
// Event and the switch is a sidecar call.

/**
 * What else is running.
 *
 * Cheap, and the necessary first move for anything cross-app: `switchApp` needs
 * a bundle id, a bundle id is not guessable, and this is the only thing that
 * produces one. Every app named here is remembered, and that is not bookkeeping
 * — it is what `switchApp` checks against, so the set of places a run can go is
 * the set it has actually been shown. The same discipline `tabs` and `checkUrl`
 * share: the freedom is earned by looking.
 */
export async function apps(context: ToolContext): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const bridge = context.apps
  if (!bridge) {
    return {
      text: 'this build cannot list applications. Work in the window you are in.',
      detail: 'no app list',
      ok: false
    }
  }

  try {
    const running = await bridge.list()
    const known = (context.knownApps ??= new Map<string, string>())
    for (const app of running) known.set(app.bundleId, app.name)
    const here = running.find((app) => app.front)
    return {
      text: renderApps(running),
      detail: here ? `${running.length} apps · in ${here.name}` : `${running.length} apps`,
      ok: true
    }
  } catch (err) {
    return refusal(err, 'System Events', 'list what is running', {
      permission:
        'macOS has not allowed Mull to ask System Events what is running, so other ' +
        'applications cannot be reached — this needs the user to turn Mull on under ' +
        'Privacy & Security › Automation. Do not try apps or switchApp again; work in ' +
        'the window you are in.',
      missing: 'nothing came back from the list of applications. Work in the window you are in.'
    })
  }
}

/**
 * Go to another application.
 *
 * ### The three things this does that no other tool does
 *
 * It **moves the user's screen**, which is why the card row carries `because`
 * and is drawn before the call rather than after it (see the lane's handler
 * table). It **changes where the hands are**, so `context.front` and the app
 * stamped on every subsequent journal row both move with it — a press that
 * landed in Calendar recorded against Slack would make the journal a worse
 * record than no journal. And it **invalidates everything**: a different app is
 * a different window, a different scan, and a different tab model.
 *
 * ### Why it refuses an app it has not been shown
 *
 * `activateApp` would fail on its own for anything not running, so this is not
 * the only thing standing between the agent and a bad switch. What it adds is
 * that the id has to have come from an `apps` call in *this* run — which makes
 * it a value Mull produced rather than one the model recalled, invented, or read
 * off a page. It is the same argument `checkUrl` makes about `knownHosts`, and
 * it costs one cheap tool call to satisfy.
 */
export async function switchApp(
  context: ToolContext,
  input: { bundleId: string; because: string },
  sleep: (ms: number) => Promise<void>
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const wanted = input.bundleId.trim()
  const known = context.knownApps
  const name = known?.get(wanted)
  if (!name) {
    return {
      text:
        `“${wanted}” is not one of the applications you have been shown. ` +
        'Call apps first and use an id exactly as it appears there.',
      detail: `${wanted} — not listed`,
      ok: false
    }
  }
  if (wanted === context.front?.bundleId) {
    return {
      text: `you are already in ${name}.`,
      detail: `already in ${name}`,
      ok: true
    }
  }

  context.steps += 1
  const went = await context.sidecar.activateApp({ bundleId: wanted })
  if (!went.activated) {
    return {
      text: `${name} would not come to the front${went.reason ? `: ${went.reason}` : ''}.`,
      detail: went.reason ?? `${name} would not activate`,
      ok: false
    }
  }

  // Everything the run believed about a window belonged to a different
  // application a moment ago.
  context.front = { bundleId: wanted, name }
  context.plan.app = { bundleId: wanted, name }
  context.scan = null
  context.pressed = null
  context.read = null

  // Longer than a press settles for. An activation can cross a Space, and a
  // Space switch is an animation the window server will not talk over.
  await sleep(SWITCH_SETTLE_MS)

  // No `detail` on success, which is the one place in this file that is a
  // deliberate omission rather than an oversight. The lane draws this row as
  // the model's `because` *before* the switch, and a detail would overwrite it
  // with the destination — so the settled card would say where the screen went
  // and no longer say why. The why is the part worth keeping; the where is
  // visible, because the user is looking at it.
  //
  // The *log* is a different reader, and it is not looking at the screen. See
  // `ToolOutcome.trace`.
  return {
    text:
      `${name} is in front now. Nothing here has been looked at yet — ` +
      'look or find before pressing anything, and remember the tab tools only ' +
      'mean something in a browser.',
    trace: name,
    ok: true
  }
}

/**
 * Bring something into view.
 *
 * The gentlest act in this file: it presses nothing, types nothing and changes
 * no state the user could not undo by scrolling. What it *does* change is what
 * they can see, which is why it still goes through the same re-read-and-verify
 * resolve as a press — a stale index cannot click the wrong button here, but it
 * can jerk the window somewhere unrelated, and the next `look` would describe
 * that as though it had been the plan.
 *
 * The scan survives, unlike after a press. Scrolling does not replace the
 * window's controls, it moves them; the indexes still point at the same
 * elements. What it can change is which of them are on screen, so a fresh look
 * is often worth it — but the model is not forced into one.
 */
export async function scrollTo(
  context: ToolContext,
  input: { index: number; expectTitle: string },
  sleep: (ms: number) => Promise<void>
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const scan = context.scan
  if (!scan) {
    return {
      text: 'nothing has been looked at yet — look or find first.',
      detail: 'no scan',
      ok: false
    }
  }
  const target = scan.targets[input.index]
  if (!target) {
    return { text: `there is no target ${input.index}.`, detail: 'no such target', ok: false }
  }

  context.steps += 1
  const scrolled = await context.sidecar.scrollTarget({
    harvestId: scan.harvestId,
    index: input.index,
    expectRole: target.role,
    expectTitle: input.expectTitle
  })
  if (!scrolled.ok) {
    return {
      text:
        scrolled.reason === 'not-scrollable'
          ? `“${target.title}” cannot scroll itself into view. Try a nearby row, or page with key.`
          : `that did not scroll: ${scrolled.reason ?? 'it would not go'}.`,
      detail: `${target.title} — ${scrolled.reason ?? 'refused'}`,
      ok: false
    }
  }
  await sleep(SETTLE_MS)
  return {
    text:
      `“${target.title}” is in view now. The numbers still mean what they did — ` +
      'what has changed is which of them you can see, so look again if you need the rest.',
    detail: target.title,
    ok: true
  }
}

// ---------------------------------------------------------------------------
// The menu bar, which is not in any window. See `services/menus.ts`.

/**
 * What this application can be asked to do.
 *
 * ### Why this is worth a tool when `look` exists
 *
 * `look` reports what is rendered. That is a different set from what the
 * application can do, and in some apps it is a much smaller one — Zed publishes
 * zero targets to accessibility and has 110 menu commands. Even where the window
 * is legible, a menu bar is the stable version of the same question: File ▸ New
 * is in the same place at every scroll position on every page, where a Create
 * button may not be rendered at all.
 *
 * ### The two filters, and which one is doing the work
 *
 * `query` narrows the same way `find` does and for the same reason — a hundred
 * and fifty commands is a lot of prompt to spend when you know the word you
 * want. It is a plain word match rather than a ranking, because a menu command
 * is a short deliberate label and the thing that matters is not missing one.
 *
 * Commands that would be refused by `checkMenuCommand` are still listed, marked.
 * Hiding them would be the more comfortable choice and the worse one: a model
 * that cannot see Send hunts for another way to send, and the point is that
 * there is not one.
 */
export async function menus(
  context: ToolContext,
  input: { query?: string }
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const bridge = context.menus
  if (!bridge) {
    return {
      text: 'this build cannot read menus. Work from what is on the screen.',
      detail: 'no menus',
      ok: false
    }
  }
  const where = context.front?.name
  if (!where) {
    return {
      text: 'nothing is in front, so there are no menus to read.',
      detail: 'no front app',
      ok: false
    }
  }

  try {
    const commands = await bridge.list(where)
    // Remembered whole, and before the query narrows anything — `chooseMenu`
    // needs the `enabled` and `submenu` flags of the command it is given, and a
    // model that searched for "event" should not be blocked from a command it
    // saw in an earlier unfiltered call.
    const known = (context.knownMenus ??= new Map<string, MenuCommand>())
    for (const command of commands) known.set(menuKey(command.menu, command.name), command)

    const wanted = input.query?.trim().toLowerCase()
    const shown = wanted
      ? commands.filter((command) =>
          `${command.menu} ${command.name}`.toLowerCase().includes(wanted)
        )
      : commands
    if (shown.length === 0) {
      return {
        text:
          `none of ${where}’s ${commands.length} commands match “${input.query}”. ` +
          'Ask again without a query to see all of them.',
        detail: `“${input.query}” — nothing`,
        ok: true
      }
    }
    return {
      text: renderMenus(shown, where),
      detail: wanted
        ? `“${input.query}” — ${shown.length} of ${commands.length}`
        : `${commands.length} commands in ${where}`,
      ok: true
    }
  } catch (err) {
    return refusal(err, 'System Events', 'read the menus', {
      permission:
        'macOS has not allowed Mull to ask System Events about menus — this needs the ' +
        'user to turn Mull on under Privacy & Security › Automation. Do not try menus ' +
        'or chooseMenu again; work from what is on the screen.',
      missing: `${where} has no menus Mull can read. Work from what is on the screen.`
    })
  }
}

/**
 * Choose one command from the menus.
 *
 * ### Four refusals, in the order they are cheapest to make
 *
 * **Not on the menu.** The pair has to have come back from `menus` in this run.
 * The same rule as `switchApp`'s `knownApps` and for the same reason: the
 * authority is a value Mull read off the machine, never one the model composed.
 *
 * **Refused by name.** `checkMenuCommand` — the guard that replaces the
 * keystroke closure for this one tool. See its docstring, and the header of
 * `@shared/agent`, which no longer claims that closure covers everything.
 *
 * **A submenu.** `services/menus.ts` reads one level; a command that opens
 * another menu is marked rather than hidden, and this says so plainly instead of
 * clicking the parent and leaving a menu hanging open over the user's screen.
 *
 * **Greyed out.** The application has said this cannot be done right now, and
 * that is information worth passing on verbatim — usually it means something
 * needs selecting first.
 *
 * ### What it invalidates
 *
 * Everything, exactly like `switchApp`. A menu command opens dialogs, switches
 * views and creates windows; the scan the model was choosing from described a
 * screen that may no longer exist.
 */
export async function chooseMenu(
  context: ToolContext,
  input: { menu: string; name: string; because: string },
  sleep: (ms: number) => Promise<void>
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const bridge = context.menus
  if (!bridge) {
    return { text: 'this build cannot use menus.', detail: 'no menus', ok: false }
  }
  const where = context.front?.name
  if (!where) return { text: 'nothing is in front.', detail: 'no front app', ok: false }

  const menu = input.menu.trim()
  const name = input.name.trim()
  const command = context.knownMenus?.get(menuKey(menu, name))
  if (!command) {
    return {
      text:
        `“${menu} ▸ ${name}” is not a command you have been shown. ` +
        'Call menus first and use the heading and the name exactly as they appear there.',
      detail: `${menu} ▸ ${name} — not listed`,
      ok: false
    }
  }

  const verdict = checkMenuCommand(menu, name)
  if (!verdict.ok) {
    return { text: `${verdict.because}.`, detail: `refused: ${name}`, ok: false }
  }
  if (command.submenu) {
    return {
      text:
        `“${name}” opens a submenu, and Mull reads only the top level of each menu — ` +
        'there is no way to reach what is inside it. Find another route.',
      detail: `${name} — a submenu`,
      ok: false
    }
  }
  if (!command.enabled) {
    return {
      text:
        `“${name}” is greyed out right now, so ${where} will not accept it. ` +
        'Something usually has to be selected or open first.',
      detail: `${name} — greyed out`,
      ok: false
    }
  }

  context.steps += 1
  try {
    await bridge.choose(where, menu, name)
  } catch (err) {
    return refusal(err, where, `choose “${name}”`, {
      missing: `“${menu} ▸ ${name}” is not on ${where}’s menus any more — ask for them again.`
    })
  }

  // A menu command is the widest-blast-radius act in this vocabulary: it opens
  // windows, switches views, and puts up dialogs. Nothing the run believed about
  // the screen survives it.
  context.scan = null
  context.pressed = null
  context.read = null
  await sleep(MENU_SETTLE_MS)

  // As with `switchApp`, no `detail` on success: the lane has already drawn this
  // row as the model's `because`, and the command's own name is the thing the
  // user can see happening.
  return {
    text:
      `chose ${menu} ▸ ${name}. Nothing here has been looked at since — ` +
      'look or find before pressing anything.',
    ok: true
  }
}

/** Both halves of the path, in one key. Menus are addressed by name, not index. */
function menuKey(menu: string, name: string): string {
  return `${menu.trim().toLowerCase()}\u001f${name.trim().toLowerCase()}`
}

// ---------------------------------------------------------------------------
// The browser, which the accessibility tree cannot describe. See
// `services/browser.ts` for why these ask the application instead.

/**
 * What is open.
 *
 * The cheapest tool in the file and often the most valuable one in a browser: a
 * tab list is a handful of lines where the same window's scan is 254 targets,
 * and it answers the one question the accessibility tree cannot be made to —
 * *which page am I on* — because a tab has a URL and the tree does not.
 *
 * It also works when `look` cannot. A cold Chromium window has no page in its
 * tree at all, and this is unaffected by that, because it is asking Chrome what
 * it has open rather than asking the renderer what it drew.
 *
 * Every host seen here is remembered, and that is not bookkeeping — it is what
 * `checkUrl` reads. A site the agent has already been shown the inside of is a
 * site it may address freely; everywhere else gets the plain address only.
 */
export async function tabs(context: ToolContext): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const bridge = browserBridge(context)
  if ('text' in bridge) return bridge

  try {
    const open = await bridge.run.tabs(bridge.bundleId)
    if (open.length === 0) {
      return {
        text: `${bridge.name} has no tabs open.`,
        detail: 'no tabs',
        ok: true
      }
    }
    remember(context, open)
    const here = open.find((tab) => tab.active)
    return {
      text: renderTabs(open),
      detail: here ? `${open.length} tabs · on “${here.title}”` : `${open.length} tabs`,
      ok: true
    }
  } catch (err) {
    return refusal(err, bridge.name, 'read the tabs')
  }
}

/**
 * Go to one of them.
 *
 * Locomotion with no reach: the tab was already open, the user could have
 * clicked it, and nothing is fetched. That is why it carries no gate where
 * `openUrl` does.
 *
 * Like a press, it invalidates the scan — and more thoroughly than a press does,
 * because the window is now showing an entirely different document. The numbers
 * from before mean nothing, and saying so in the result is what stops the next
 * turn pressing one of them.
 */
export async function switchTab(
  context: ToolContext,
  input: { index?: number; urlContains?: string }
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const bridge = browserBridge(context)
  if ('text' in bridge) return bridge

  const asked = input.index !== undefined
  if (asked === (input.urlContains !== undefined)) {
    // Both or neither. The schema cannot say "exactly one" and still hand the
    // SDK a `.shape`, so it is said here — as a correction rather than a refusal,
    // because the next turn can simply get it right.
    return {
      text: 'say either index or urlContains, not both and not neither',
      detail: 'ambiguous',
      ok: false
    }
  }

  try {
    let index = input.index as number
    if (!asked) {
      const needle = (input.urlContains as string).toLowerCase()
      const open = await bridge.run.tabs(bridge.bundleId)
      remember(context, open)
      const hits = open.filter((tab) => tab.url.toLowerCase().includes(needle))
      if (hits.length === 0) {
        return {
          text:
            `no tab's address contains “${input.urlContains}”. What is open:\n\n` +
            renderTabs(open),
          detail: `“${input.urlContains}” — no tab`,
          ok: false
        }
      }
      // The first rather than the best. A URL fragment that matches two tabs
      // matched two pages of the same site, and guessing between them is worse
      // than being predictable about it.
      index = (hits[0] as BrowserTab).index
    }

    const now = await bridge.run.switchTab(bridge.bundleId, index)
    context.steps += 1
    // Harder than a press: the document underneath is a different one entirely.
    context.scan = null
    context.pressed = null
    // A different document deserves its own wait — see `rescan`.
    context.pageWaits?.clear()
    return {
      text:
        `now on “${now.title}” — ${now.url}. This is a different page: ` +
        'the numbers you were shown do not exist here, so look again before pressing anything.',
      detail: `“${now.title}”`,
      ok: true
    }
  } catch (err) {
    return refusal(err, bridge.name, 'change tab')
  }
}

/**
 * Go somewhere that is not open yet — the one tool here that reaches the network.
 *
 * Checked twice, deliberately. `canUseTool` refuses first and refuses
 * synchronously, before this function is entered at all; this checks again for
 * the same reason every handler re-reads the stop, and because the pure rule
 * being in one place (`checkUrl`) is what lets the policy be read rather than
 * reconstructed from two call sites.
 *
 * A refusal is prose the model can act on, not an error. "Take the query string
 * off" is something a next turn can do; a thrown exception is something it can
 * only fail at.
 */
export async function openUrl(
  context: ToolContext,
  input: { url: string; newTab?: boolean }
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const verdict = checkUrl(input.url, context.knownHosts ?? new Set())
  if (!verdict.ok) {
    return { text: verdict.because, detail: `refused · ${verdict.because}`, ok: false }
  }

  const bridge = browserBridge(context, { allowAnywhere: true })
  if ('text' in bridge) return bridge

  // Which browser this is actually for — the question `open` answers wrongly
  // whenever more than one is running. See `chooseBrowser`.
  const target = await chooseBrowser(context, bridge)
  if ('text' in target) return target

  try {
    const now = await bridge.run.openUrl({
      bundleId: target.bundleId || null,
      url: input.url.trim(),
      // A new tab unless the goal actually wanted the page replaced. The default
      // used to be the other way round, and the asymmetry is the argument: an
      // unwanted tab is a tab to close, while an unwanted replacement throws
      // away whatever the user was reading and cannot be undone from here.
      newTab: input.newTab !== false
    })
    context.steps += 1
    context.scan = null
    context.pressed = null
    // The page that is arriving is allowed the full wait, even if this run has
    // already waited on this browser once.
    context.pageWaits?.clear()
    if (verdict.host) (context.knownHosts ??= new Set()).add(verdict.host)

    /**
     * `active: false` means the URL was handed to `open` rather than to a
     * browser Mull can drive — so it went to whatever the system's *default*
     * browser is, which is not necessarily the one anybody meant.
     *
     * Said out loud because the silence cost a whole run. See `chooseBrowser`
     * for the guard that now stops it happening at all when there is a choice
     * to get wrong.
     */
    if (!now.active) {
      return {
        text:
          `opened ${now.url} in the system’s default browser — that is the window you ` +
          'are now working in. Look before pressing anything, and say so if that is ' +
          'the wrong browser.',
        detail: `${verdict.host ?? now.url} · via the default browser`,
        ok: true
      }
    }
    return {
      text:
        `opened ${now.url}. The page is still loading and the numbers you were shown ` +
        'are gone — look again, and if the page is not there yet, look a second time.',
      detail: verdict.host ?? now.url,
      ok: true
    }
  } catch (err) {
    return refusal(err, bridge.name, 'open that')
  }
}

/**
 * Which browser an address is actually for.
 *
 * `openUrl` used to answer this by not asking: if the front application was not
 * a browser it could drive, it handed the URL to `/usr/bin/open` and macOS took
 * it to the **default** browser. On a Mac with two browsers running that is a
 * coin toss dressed as an action — and it lost. Asked to open YouTube in Arc,
 * with Arc in front and Chrome as the default, it opened YouTube in Chrome and
 * the run spent the next fifty seconds driving a window nobody had asked for.
 *
 * Three cases, in order:
 *
 *   1. **The front application is a browser Mull can drive.** That is the one
 *      the user is looking at; use it. No ambiguity to resolve.
 *   2. **Exactly one browser is running.** There is only one place this could
 *      sensibly go, so go there by name rather than through `open` — which
 *      would still consult the default and could launch a *second* browser to
 *      show a page the user has a perfectly good window for.
 *   3. **More than one is running.** Refuse, and say which. Guessing here is
 *      the original bug, and the model has `switchApp` — it can put the browser
 *      it means in front and ask again, which also makes the choice visible to
 *      the user watching the screen move.
 *
 * With no app list at all — `apps` refused, or never called — this falls
 * through to `open` and the honest sentence about the default browser. That is
 * the old behaviour, kept for the case where there is genuinely nothing better
 * to go on.
 */
async function chooseBrowser(
  context: ToolContext,
  bridge: { run: BrowserBridge; bundleId: string; name: string }
): Promise<{ bundleId: string; name: string } | ToolOutcome> {
  // Case 1: already standing in one.
  if (bridge.bundleId && bridge.run.supports(bridge.bundleId)) {
    return { bundleId: bridge.bundleId, name: bridge.name }
  }

  const running = await runningBrowsers(context)
  // Case 2.
  if (running.length === 1) return running[0] as { bundleId: string; name: string }

  // Case 3.
  if (running.length > 1) {
    const names = running.map((browser) => browser.name).join(', ')
    // The front app's own name, not `bridge.name` — which for a non-browser is
    // the placeholder "the default browser" and would make this sentence say
    // that the default browser is not a browser.
    const here = context.front?.name ?? 'this app'
    return {
      text:
        `${here} is not a browser, and ${running.length} are open — ${names} — so there ` +
        'is no way to tell which of them this address is for. Opening it would land in ' +
        'whichever the Mac treats as the default, which may not be the one the goal ' +
        'named. Use switchApp to put the right browser in front, then open the address ' +
        'there.',
      detail: `which browser? ${names}`,
      ok: false
    }
  }

  // Nothing known. `openUrl` falls through to `open` and says so.
  return { bundleId: '', name: bridge.name }
}

/**
 * The browsers running right now, by bundle id.
 *
 * Reads `knownApps` first — it is what `apps` already filled in and costs
 * nothing — and only spawns the app list when this run has not asked for one.
 * A refusal there is not an error: the caller treats "no list" as "nothing to
 * go on" and keeps the old behaviour.
 */
async function runningBrowsers(
  context: ToolContext
): Promise<Array<{ bundleId: string; name: string }>> {
  const seen = new Map<string, string>()
  for (const [bundleId, name] of context.knownApps ?? []) seen.set(bundleId, name)

  if (seen.size <= 1 && context.apps) {
    try {
      for (const app of await context.apps.list()) seen.set(app.bundleId, app.name)
    } catch {
      // The consent dialog, or an app that quit mid-enumeration. Either way the
      // answer is "we do not know", which is what an empty list means here.
    }
  }

  const browsers: Array<{ bundleId: string; name: string }> = []
  for (const [bundleId, name] of seen) {
    const known = browserOf(bundleId)
    if (known) browsers.push({ bundleId, name: known.name || name })
  }
  return browsers
}

// ---------------------------------------------------------------------------

/**
 * The browser in front, or the sentence explaining why there is not one.
 *
 * Returns a `ToolOutcome` on failure rather than throwing, because every caller
 * would otherwise catch and rewrite the same three refusals. `'text' in result`
 * is how a caller tells the two apart.
 *
 * `allowAnywhere` is for `openUrl` alone: the other two ask a specific browser
 * about its own state and are meaningless without one, but opening a URL while
 * standing in Mail is an ordinary thing to want, and the system has a default
 * browser for exactly that.
 */
function browserBridge(
  context: ToolContext,
  options: { allowAnywhere?: boolean } = {}
): { run: BrowserBridge; bundleId: string; name: string } | ToolOutcome {
  const run = context.browser
  if (!run) {
    return {
      text: 'this build cannot read browser tabs. Work from what is on the screen.',
      detail: 'no browser bridge',
      ok: false
    }
  }
  const front = context.front ?? context.plan.app
  const known = browserOf(front?.bundleId)
  if (!known) {
    if (options.allowAnywhere) return { run, bundleId: '', name: 'the default browser' }
    return {
      text:
        `${front?.name ?? 'this app'} is not a browser, so it has no tabs. ` +
        'Use look and find here instead.',
      detail: 'not a browser',
      ok: false
    }
  }
  return { run, bundleId: front?.bundleId as string, name: known.name }
}

/** Every host the agent has now seen the inside of. Read by `checkUrl`. */
function remember(context: ToolContext, open: BrowserTab[]): void {
  const hosts = (context.knownHosts ??= new Set())
  for (const tab of open) {
    try {
      hosts.add(new URL(tab.url).hostname.toLowerCase())
    } catch {
      // A tab showing `chrome://newtab` or a blank one. Not a host, not an error.
    }
  }
}

/**
 * What to tell the model when a script said no.
 *
 * Each of these wants a different next move, which is the whole reason
 * `ScriptFailure` is an enumeration rather than a message. Permission is the one
 * worth naming precisely: it is not a failure of the run, it is a thing the
 * *user* has to go and do, and a model that is told "work from the screen
 * instead" gets on with the task rather than retrying a call that will refuse
 * identically every time for the rest of the run.
 *
 * `permission` overrides that one sentence, because Automation is granted per
 * target: a user may have allowed Chrome and not System Events, and "the browser
 * tools are unavailable" would then be the wrong thing to tell a run that has
 * just failed to list applications.
 */
function refusal(
  err: unknown,
  name: string,
  doing: string,
  says: { permission?: string; missing?: string } = {}
): ToolOutcome {
  const reason = err instanceof ScriptError ? err.reason : 'failed'
  switch (reason) {
    case 'not-permitted':
      return {
        text:
          says.permission ??
          `macOS has not allowed Mull to control ${name}, so its tabs cannot be reached — ` +
            'this needs the user to turn Mull on under Privacy & Security › Automation. ' +
            'Do not try the browser tools again; work from what is on the screen.',
        detail: `${name}: not permitted`,
        ok: false
      }
    case 'not-scriptable':
      return { text: `${name} has no tabs Mull can read.`, detail: 'not a browser', ok: false }
    case 'no-window':
      return {
        text: `${name} has no window open to ${doing} in.`,
        detail: `${name}: no window`,
        ok: false
      }
    case 'missing':
      return {
        text: says.missing ?? 'that tab is not there any more — ask for the tabs again.',
        detail: 'it has gone',
        ok: false
      }
    case 'timed-out':
      return {
        text: `${name} did not answer in time. It may be busy; carry on with what is on screen.`,
        detail: `${name}: no answer`,
        ok: false
      }
    default:
      return {
        text: `could not ${doing}: ${err instanceof Error ? err.message : String(err)}`,
        detail: `could not ${doing}`,
        ok: false
      }
  }
}

// ---------------------------------------------------------------------------

/**
 * Which of these targets is the user talking about?
 *
 * Pure, and the most valuable thing in this file: it is what stops the loop
 * paying for 254 numbered lines on every single turn. Client-side for now — it
 * filters the scan the lane already holds — which gets the saving with no Swift.
 * Moving it into the sidecar would also cut the walk, and that is M-B.
 *
 * ### The ranking
 *
 * Deliberately simple, and ordered by how much a match tells you:
 *
 *   3  the title is exactly the query
 *   2  the title starts with it — "Anil" against "Anil Turaga (away)"
 *   1  it appears anywhere in the title, help or value
 *
 * Then by how much of the title the query accounts for, so a short precise
 * label outranks a long one that merely contains the word. "Priya Sharma" beats
 * "Search messages from Priya Sharma and 4 others" for the query "Priya".
 *
 * Every word of the query has to appear somewhere for a multi-word query to
 * match at all, because a query is a description rather than a guess — "terms
 * doc" must not match every row containing "the".
 */
export function findTargets(
  targets: UiTarget[],
  query: string,
  kind?: 'press' | 'type'
): UiTarget[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const words = needle.split(/\s+/u).filter(Boolean)

  const scored: Array<{ target: UiTarget; score: number; density: number }> = []
  for (const target of targets) {
    if (kind && target.kind !== kind) continue
    const title = target.title.toLowerCase()
    const haystack = `${title} ${target.help ?? ''} ${target.value ?? ''}`.toLowerCase()
    if (!words.every((word) => haystack.includes(word))) continue

    const score = title === needle ? 3 : title.startsWith(needle) ? 2 : 1
    scored.push({ target, score, density: needle.length / Math.max(title.length, 1) })
  }

  scored.sort((a, b) => b.score - a.score || b.density - a.density || a.target.index - b.target.index)
  return scored.slice(0, FIND_LIMIT).map((hit) => hit.target)
}

// ---------------------------------------------------------------------------

/** How long to let a window settle before looking at it. */
const SETTLE_MS = 250

/**
 * What can be pressed here, now.
 *
 * Fresh every time, never cached across an act — the whole point is that the
 * previous numbers stopped meaning anything the moment something was pressed.
 */
async function rescan(context: ToolContext, sleep: (ms: number) => Promise<void>): Promise<Scan> {
  await sleep(SETTLE_MS)
  let seen = await context.sidecar.uiTargets(SCAN_BUDGET)
  for (let attempt = 0; seen.stoppedBy === 'tree-warming' && attempt < TREE_ATTEMPTS; attempt += 1) {
    await sleep(TREE_POLL_MS)
    seen = await context.sidecar.uiTargets(SCAN_BUDGET)
  }

  /**
   * A browser with no page in it, asked again.
   *
   * Two different things arrive here looking the same. One is a page that is
   * simply not loaded yet — `openUrl` returns the moment the address bar
   * changes, so the first look after a navigation routinely lands before the
   * document exists — and that one resolves by waiting. The other is a browser
   * whose renderer accessibility is off altogether, and that one never
   * resolves: current Chrome refuses `AXManualAccessibility` outright, so there
   * is no lever to pull and no amount of asking will help.
   *
   * They are indistinguishable from here, so both get the same bounded wait and
   * then the honest answer. Paying it once per app per navigation is what keeps
   * the second case cheap: the `look` after that gets a single scan and the
   * sentence saying the page is not visible, rather than this wait again.
   */
  if (seen.stoppedBy === 'browser-cold') {
    const key = seen.app?.bundleId ?? 'unknown'
    const waited = (context.pageWaits ??= new Set())
    if (!waited.has(key)) {
      waited.add(key)
      for (let n = 0; seen.stoppedBy === 'browser-cold' && n < COLD_ATTEMPTS; n += 1) {
        await sleep(COLD_POLL_MS)
        seen = await context.sidecar.uiTargets(SCAN_BUDGET)
      }
    }
  }

  return {
    harvestId: seen.harvestId,
    targets: seen.targets as UiTarget[],
    stoppedBy: seen.stoppedBy,
    nodes: seen.nodes,
    webAreas: seen.webAreas,
    clipped: seen.clipped,
    deepest: seen.deepest,
    chromium: seen.chromium
  }
}

/**
 * The half of a look the log could never see.
 *
 * `act.look  detail="2 blocks · 138 chars · 18 targets"  ok=true` is a true
 * sentence about a Chrome window that was showing none of Google Calendar, and
 * it is indistinguishable from the same sentence about a window that really
 * does hold eighteen buttons. Reading the log afterwards, there was no way to
 * tell which had happened — so the run looked like the model choosing badly
 * rather than the model being handed a toolbar and told it was a page.
 *
 * Kept short on purpose: this goes on every look and every find, and a trace
 * line nobody can scan is a trace line nobody reads. Silent when there is
 * nothing to report — a native app that walked its whole tree adds one clause,
 * and a browser with its page visible adds two.
 */
export function treeNote(scan: Scan): string {
  const bits: string[] = []
  if (scan.nodes !== undefined) bits.push(`${scan.nodes} nodes`)
  // The one that matters. A browser with no web document in its tree is not
  // showing us the page, however many targets it just offered.
  if (scan.chromium) bits.push(scan.webAreas ? `${scan.webAreas} doc` : 'NO PAGE')
  if (scan.clipped) bits.push(`clipped ${scan.clipped}@${scan.deepest}`)
  if (scan.stoppedBy && scan.stoppedBy !== 'complete') bits.push(scan.stoppedBy)
  return bits.join(' · ')
}
