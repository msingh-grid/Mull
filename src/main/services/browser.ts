import { browserOf, TAB_LIMIT } from '@shared/agent'
import {
  OPEN_SENTINEL,
  osascript,
  RS,
  ScriptError,
  US,
  type RunScript
} from './osascript'

/**
 * The browser's own tab model, read by asking the browser.
 *
 * ### Why this exists at all
 *
 * Everything else Mull knows about a window it learned from the accessibility
 * tree, and for a browser that tree is the weakest surface in the system. It is
 * built lazily, so a browser nobody has poked answers with its toolbar and
 * nothing from the page (`stoppedBy: 'browser-cold'`). It is enormous when it is
 * awake — Chrome showing Gmail returns 254 distinct targets against a scan
 * budget of 300. And it has no tab model whatsoever: **tabs are not windows**,
 * they never appear in `kAXWindowsAttribute`, and the tree exposes only the
 * frontmost tab's content with no URL and no identity attached to it.
 *
 * So the three things a person takes for granted in a browser — what is open,
 * where am I, go back to that other one — were not merely hard through the
 * accessibility API. They were unrepresentable.
 *
 * AppleScript answers all three directly, because it asks the application rather
 * than its rendering. It needs no extension, no debugging port and no page
 * access, and it keeps working when the tree is cold.
 *
 * ### Why this runs here and not in the sidecar
 *
 * `docs/agent/AGENT-V2.md` files this under "Swift 8", and it is worth saying
 * why it did not go there. The sidecar handshake is strict equality
 * (`Verbs.swift`, `SIDECAR_PROTOCOL_VERSION`), so adding a verb means bumping
 * the protocol, and a `mull-mac` binary that has not been rebuilt then fails
 * `init` and takes **the whole sidecar** with it — no dictation, no accessibility,
 * nothing. `npm run build:sidecar` is a separate manual step from `npm run dev`,
 * so that is not a hypothetical.
 *
 * The sidecar exists because the accessibility APIs are native and need a native
 * process. None of that applies here: `osascript` is a subprocess, and spawning
 * one is something main already knows how to do. So the cost of putting this in
 * Swift is real and the benefit is tidiness. It lives here, and it is injectable,
 * which also means the tests below need neither a browser nor a build.
 *
 * ### The permission, which is new
 *
 * This is the first thing in Mull that sends an Apple Event, and the entitlements
 * file used to say so — *"Mull drives apps through CGEvent and the Accessibility
 * API, never by scripting them"*. That is no longer true, so
 * `build/entitlements.mac.plist` gains `com.apple.security.automation.apple-events`
 * and the Info.plist gains `NSAppleEventsUsageDescription`, without which macOS
 * kills the process rather than prompting — the same rule as the microphone.
 *
 * The first script aimed at a given browser raises a consent dialog, once, per
 * browser. Until the user answers it, every call here fails with
 * `not-permitted`, which is a sentence the model is handed rather than an
 * exception anybody has to catch. That is the whole degradation story: no tabs,
 * everything else unchanged.
 *
 * ### Outside input is an argument, never text in a script
 *
 * The tab index and the URL arrive through `on run argv`, after `--`. Neither is
 * ever interpolated, which matters more here than it usually does: a URL is
 * attacker-shaped input by assumption, and a quote in one spliced into a script
 * is an AppleScript injection — arbitrary Apple Events, sent as the user, which
 * is a far worse outcome than the navigation it was pretending to be.
 *
 * The one thing written *into* the script is the bundle id, and it has to be —
 * see `appId` for why AppleScript leaves no choice, and why a value that can
 * only ever be one of nine constants in this repository is a different kind of
 * thing from the two that come from outside.
 */

/** One tab, as the browser describes it. Indexes are 1-based; AppleScript's are. */
export interface BrowserTab {
  index: number
  title: string
  url: string
  /** The one actually showing. Exactly one is true, unless the browser lied. */
  active: boolean
}

/**
 * Re-exported under the names this file has always used.
 *
 * A failing tab call and a failing app-list call are the same six failures — the
 * consent dialog, a target that has quit, something that has since gone away —
 * because they are all one `osascript` exit code away from each other. So the
 * enumeration lives in `services/osascript.ts` with the runner, and these two
 * names stay pointing at it.
 */
export { ScriptError as BrowserError, type ScriptFailure as BrowserFailure } from './osascript'

export interface BrowserBridge {
  /** What this bundle id is, if it is anything. Cheap, and never spawns. */
  supports(bundleId: string | null | undefined): boolean
  tabs(bundleId: string): Promise<BrowserTab[]>
  switchTab(bundleId: string, index: number): Promise<BrowserTab>
  /** `bundleId: null` hands the URL to whatever the user's default browser is. */
  openUrl(input: { bundleId: string | null; url: string; newTab: boolean }): Promise<BrowserTab>
}

/** The injection seam, re-exported so a caller needs one import rather than two. */
export type { RunScript } from './osascript'


// ---------------------------------------------------------------------------

/**
 * Why the bundle id is written into the script and everything else is not.
 *
 * This is the one exception to the rule in the header, and it is forced rather
 * than chosen. AppleScript resolves an application's own vocabulary — `tabs`,
 * `active tab index`, `title of t` — **at compile time**, by loading that
 * application's dictionary. With a variable target it has no dictionary to load,
 * so `tell application id (item 1 of argv)` does not merely behave oddly: the
 * script does not compile at all, every time, with "Expected end of line but
 * found property". A literal id compiles.
 *
 * What makes it safe is that the id can only ever be one of the nine keys of
 * `BROWSERS`. Every path here goes through `dialect()`, which asks `browserOf`
 * and throws on anything else, and `appId` checks again at the point of
 * interpolation. So what reaches the script is a constant from this repository,
 * selected by a lookup — not a value from the model, the user or a page. The
 * URL and the tab index, which *are* outside input, still travel in argv.
 */
function appId(bundleId: string): string {
  const known = browserOf(bundleId)
  if (!known) {
    throw new ScriptError('not-scriptable', `${bundleId} is not a browser Mull knows`)
  }
  // Belt and braces over the lookup above: whatever happens to this table
  // later, nothing with a quote in it can become part of a script.
  if (!/^[A-Za-z0-9.-]+$/u.test(bundleId)) {
    throw new ScriptError('not-scriptable', 'that bundle id cannot go in a script')
  }
  return `tell application id "${bundleId}"`
}

/**
 * Chrome's dialect, and everything that inherited it.
 *
 * `title`, `active tab index`, `tab i of w`. Shared verbatim by Brave, Edge,
 * Vivaldi and Opera, which is most of the browsers anyone uses.
 */
const CHROMIUM = {
  tabs: (id: string): string[] => [
    'on run argv',
    'set RS to character id 30',
    'set US to character id 31',
    'set out to ""',
    appId(id),
    'if (count of windows) is 0 then error "no window" number -1728',
    'set w to front window',
    'set n to count of tabs of w',
    'set a to active tab index of w',
    'repeat with i from 1 to n',
    'set t to tab i of w',
    'set out to out & i & US & (title of t) & US & (URL of t) & US & ((i = a) as text) & RS',
    'end repeat',
    'end tell',
    'return out',
    'end run'
  ],
  switchTab: (id: string): string[] => [
    'on run argv',
    'set US to character id 31',
    appId(id),
    'if (count of windows) is 0 then error "no window" number -1728',
    'set w to front window',
    'set i to (item 1 of argv) as integer',
    'if i < 1 or i > (count of tabs of w) then error "no such tab" number -1728',
    'set active tab index of w to i',
    'set t to tab i of w',
    'return (i as text) & US & (title of t) & US & (URL of t) & US & "true"',
    'end tell',
    'end run'
  ],
  openUrl: (id: string): string[] => [
    'on run argv',
    'set US to character id 31',
    'set u to item 1 of argv',
    'set fresh to ((item 2 of argv) is "1")',
    appId(id),
    'activate',
    'if (count of windows) is 0 then make new window',
    'set w to front window',
    'if fresh then',
    'tell w to make new tab with properties {URL:u}',
    'set active tab index of w to (count of tabs of w)',
    'else',
    'set URL of active tab of w to u',
    'end if',
    'set i to active tab index of w',
    'set t to tab i of w',
    'return (i as text) & US & (title of t) & US & (URL of t) & US & "true"',
    'end tell',
    'end run'
  ]
} as const

/**
 * Safari's dialect, which predates Chrome's and agrees with it on nothing.
 *
 * A tab has a `name` rather than a `title`; the window points at a `current tab`
 * rather than holding an index; and a new window is a `document`. Every one of
 * those is a place a shared script would have failed silently or thrown, which
 * is why there are two tables here rather than one with branches in it.
 */
const SAFARI = {
  tabs: (id: string): string[] => [
    'on run argv',
    'set RS to character id 30',
    'set US to character id 31',
    'set out to ""',
    appId(id),
    'if (count of windows) is 0 then error "no window" number -1728',
    'set w to front window',
    'set n to count of tabs of w',
    'set a to 0',
    'try',
    'set a to index of current tab of w',
    'end try',
    'repeat with i from 1 to n',
    'set t to tab i of w',
    'set out to out & i & US & (name of t) & US & (URL of t) & US & ((i = a) as text) & RS',
    'end repeat',
    'end tell',
    'return out',
    'end run'
  ],
  switchTab: (id: string): string[] => [
    'on run argv',
    'set US to character id 31',
    appId(id),
    'if (count of windows) is 0 then error "no window" number -1728',
    'set w to front window',
    'set i to (item 1 of argv) as integer',
    'if i < 1 or i > (count of tabs of w) then error "no such tab" number -1728',
    'set t to tab i of w',
    'set current tab of w to t',
    'return (i as text) & US & (name of t) & US & (URL of t) & US & "true"',
    'end tell',
    'end run'
  ],
  openUrl: (id: string): string[] => [
    'on run argv',
    'set US to character id 31',
    'set u to item 1 of argv',
    'set fresh to ((item 2 of argv) is "1")',
    appId(id),
    'activate',
    'if (count of windows) is 0 then',
    'make new document with properties {URL:u}',
    'else',
    'set w to front window',
    'if fresh then',
    'tell w to set current tab to (make new tab with properties {URL:u})',
    'else',
    'set URL of current tab of w to u',
    'end if',
    'end if',
    'set w to front window',
    'set t to current tab of w',
    'return ((index of t) as text) & US & (name of t) & US & (URL of t) & US & "true"',
    'end tell',
    'end run'
  ]
} as const

// ---------------------------------------------------------------------------

export class AppleScriptBrowser implements BrowserBridge {
  private readonly run: RunScript

  constructor(options: { run?: RunScript } = {}) {
    this.run = options.run ?? osascript
  }

  supports(bundleId: string | null | undefined): boolean {
    return browserOf(bundleId) !== null
  }

  async tabs(bundleId: string): Promise<BrowserTab[]> {
    const out = await this.run(this.dialect(bundleId).tabs(bundleId), [])
    // Capped rather than paged. A hundredth tab is not the one anybody meant,
    // and the alternative is spending a third of a prompt proving it.
    return parseTabs(out).slice(0, TAB_LIMIT)
  }

  async switchTab(bundleId: string, index: number): Promise<BrowserTab> {
    const out = await this.run(this.dialect(bundleId).switchTab(bundleId), [String(index)])
    const tab = parseTab(out)
    if (!tab) throw new ScriptError('missing', `${bundleId} did not say which tab it moved to`)
    return tab
  }

  async openUrl(input: {
    bundleId: string | null
    url: string
    newTab: boolean
  }): Promise<BrowserTab> {
    const known = browserOf(input.bundleId)
    if (!known) {
      // Nothing scriptable in front, so this goes to whatever the user's default
      // browser is. `open` reports nothing back about where it landed, so the
      // tab returned here is what was asked for rather than what was observed —
      // and `active: false` is how the caller can tell the difference.
      await this.run([OPEN_SENTINEL], [input.url])
      return { index: 0, title: input.url, url: input.url, active: false }
    }
    const id = input.bundleId as string
    const out = await this.run(this.dialect(id).openUrl(id), [
      input.url,
      input.newTab ? '1' : '0'
    ])
    const tab = parseTab(out)
    if (!tab) throw new ScriptError('failed', `${known.name} did not say where it went`)
    return tab
  }

  private dialect(bundleId: string): typeof CHROMIUM | typeof SAFARI {
    const known = browserOf(bundleId)
    if (!known) {
      throw new ScriptError('not-scriptable', `${bundleId} does not have tabs Mull can read`)
    }
    return known.dialect === 'safari' ? SAFARI : CHROMIUM
  }
}

// ---------------------------------------------------------------------------

/** One `\u001e`-delimited record per tab, four `\u001f`-delimited fields each. */
export function parseTabs(out: string): BrowserTab[] {
  const tabs: BrowserTab[] = []
  for (const record of out.split(RS)) {
    const tab = parseTab(record)
    if (tab) tabs.push(tab)
  }
  return tabs
}

function parseTab(record: string): BrowserTab | null {
  const trimmed = record.trim()
  if (!trimmed) return null
  const fields = trimmed.split(US)
  if (fields.length < 4) return null
  const index = Number.parseInt(fields[0] as string, 10)
  if (!Number.isFinite(index)) return null
  return {
    index,
    title: (fields[1] as string).trim(),
    url: (fields[2] as string).trim(),
    active: (fields[3] as string).trim() === 'true'
  }
}

