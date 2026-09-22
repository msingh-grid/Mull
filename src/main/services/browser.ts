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

/**
 * Arc's dialect, which is neither of the above.
 *
 * Arc is Chromium underneath, which is exactly why it is worth saying that none
 * of that reaches here. Chrome's dictionary hangs a settable `active tab index`
 * off the window; Arc's hangs a **read-only** `active tab` off it and moves
 * between tabs by telling a tab to `select`. A tab has `title` and `URL` like
 * Chrome's, and no `index` at all — so position is whatever the enumeration
 * says it is, and identity is the `id`.
 *
 * Two things here are not style, and both were measured against the running
 * application rather than reasoned out of the dictionary.
 *
 * ### The window is never put in a variable
 *
 * `set w to front window` compiles, and then every single use of `w` fails:
 *
 *     set w to front window
 *     count of tabs of w
 *     --> Can't make «class » id "B3B2…" into type specifier. (-1700)
 *
 * Inline, `count of tabs of front window` answers 42. Arc hands back a window
 * object that cannot be coerced to a specifier once it has been stored, so
 * every reference below says `front window` again. This is what made the first
 * version fail on every call while compiling perfectly — and `osacompile`
 * cannot catch it, because it is a runtime coercion.
 *
 * The same failure is why `tell front window to make new tab` is not here
 * either, and why the tab list is assembled *outside* the tell block.
 *
 * ### A new tab has exactly one spelling
 *
 * `tell front window to make new tab with properties {URL:u}` — and only that.
 * Every other spelling silently produces a **Little Arc**, the small floating
 * window, which returns `missing value` and leaves `count of windows` and the
 * window's tab count unchanged, so the page it opened is somewhere Arc's own
 * AppleScript cannot see afterwards. Measured on a window with 42 tabs:
 *
 *     tell front window to make new tab              tabs 42 -> 43   real tab
 *     tell active space of front window to make …    tabs 43 -> 44   real tab
 *     make new tab at end of tabs of front window    tabs 44 -> 44   Little Arc
 *     make new tab                                   tabs 44 -> 44   Little Arc
 *
 * The two that fail are the two that name the container with an `at` clause,
 * and Arc's `make` command declares no insertion-location parameter at all — so
 * the clause compiles, is ignored, and the tab goes to the application's
 * write-only `tabs` element, which its dictionary describes as the way to
 * "create new Little Arc tabs".
 *
 * The tab that `make` returns still cannot be read back — its specifier carries
 * the window, and the window will not coerce — but it becomes the **active**
 * tab, and that can be read. So the reply is assembled from `active tab of
 * front window` rather than from the result.
 *
 * Read off `/Applications/Arc.app/Contents/Resources/Arc.sdef`, compiled by
 * `npm run check:applescript`, and run against Arc 1.x — which is where all
 * three of the above came from, none of them being things a compiler can see.
 */
const ARC = {
  tabs: (id: string): string[] => [
    'on run argv',
    'set RS to character id 30',
    'set US to character id 31',
    'set out to ""',
    appId(id),
    'if (count of windows) is 0 then error "no window" number -1728',
    // Three messages for forty-two tabs, instead of a hundred and twenty-six.
    // `title of every tab` returns the whole column at once; asking per tab
    // costs a round trip each and Arc is not fast about them.
    'set theTitles to title of every tab of front window',
    'set theUrls to URL of every tab of front window',
    'set theIds to id of every tab of front window',
    'set liveId to ""',
    'try',
    'set liveId to id of active tab of front window',
    'end try',
    'end tell',
    // Outside the tell block on purpose: assembling the string sends no further
    // Apple Events, so a window with a hundred tabs costs the same four as one
    // with two.
    'repeat with i from 1 to (count of theIds)',
    'set aTitle to item i of theTitles',
    'set aUrl to item i of theUrls',
    // Arc answers `missing value` for a tab it has not loaded yet, and
    // concatenating that raises rather than yielding a blank. Blanked rather
    // than skipped: an unloaded tab is still a tab the user can be sent to, and
    // skipping one that happened to be the *active* tab left the whole list
    // with nothing marked as where we are.
    'if aTitle is missing value then set aTitle to ""',
    'if aUrl is missing value then set aUrl to ""',
    'set out to out & i & US & aTitle & US & aUrl & US & (((item i of theIds) is liveId) as text) & RS',
    'end repeat',
    'return out',
    'end run'
  ],
  switchTab: (id: string): string[] => [
    'on run argv',
    'set US to character id 31',
    appId(id),
    'if (count of windows) is 0 then error "no window" number -1728',
    'set i to (item 1 of argv) as integer',
    'if i < 1 or i > (count of tabs of front window) then error "no such tab" number -1728',
    'tell tab i of front window to select',
    'return (i as text) & US & (title of tab i of front window) & US & (URL of tab i of front window) & US & "true"',
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
    'if (count of windows) is 0 then error "no window" number -1728',
    // What is showing now, so the wait below can tell "arrived" from "not yet".
    'set wasTitle to ""',
    'try',
    'set wasTitle to title of active tab of front window',
    'end try',
    'if fresh then',
    // `tell front window` is the whole trick, and it has to be inline — the
    // same window-in-a-variable rule as everywhere else here. The tab it
    // returns cannot be read back (its specifier carries the window that will
    // not coerce), but it becomes the active tab, and that can.
    'tell front window to make new tab with properties {URL:u}',
    'else',
    'set URL of active tab of front window to u',
    'end if',
    // Arc answers before it has finished moving: the URL changes at once and
    // the title trails it by up to a second. Reading straight through returned
    // the name of the page that *was* there — which read to the model as a
    // navigation that had not happened, and it told the user so while the new
    // page was on screen in front of them.
    'set liveTitle to wasTitle',
    'repeat 8 times',
    'delay 0.2',
    'set liveTitle to title of active tab of front window',
    'if liveTitle is missing value then set liveTitle to ""',
    'if liveTitle is not wasTitle and liveTitle is not "" then exit repeat',
    'end repeat',
    'if liveTitle is missing value then set liveTitle to ""',
    'set liveId to id of active tab of front window',
    'set theIds to id of every tab of front window',
    'set idx to 0',
    'repeat with i from 1 to (count of theIds)',
    'if (item i of theIds) is liveId then set idx to i',
    'end repeat',
    'return (idx as text) & US & liveTitle & US & (URL of active tab of front window) & US & "true"',
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
    return capTabs(parseTabs(out))
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

  private dialect(bundleId: string): typeof CHROMIUM | typeof SAFARI | typeof ARC {
    const known = browserOf(bundleId)
    if (!known) {
      throw new ScriptError('not-scriptable', `${bundleId} does not have tabs Mull can read`)
    }
    // A switch rather than a ternary now that there are three: the shape of
    // this is what stops a fourth browser quietly inheriting Chrome's scripts
    // because it happens not to be Safari.
    switch (known.dialect) {
      case 'safari':
        return SAFARI
      case 'arc':
        return ARC
      default:
        return CHROMIUM
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Capped rather than paged — but never at the cost of the tab you are on.
 *
 * A hundredth tab is not the one anybody meant, and the alternative is spending
 * a third of a prompt proving it. What a plain `slice` gets wrong is *which*
 * forty: an Arc window with 42 tabs and the active one at position 41 reported
 * forty tabs and **none of them marked as showing**, so a run that had just
 * navigated somewhere was told it was nowhere, and said so to the user while
 * the page sat on screen in front of them.
 *
 * So the active tab is kept whatever its position, at the cost of the last of
 * the forty. Where you are is the one line in this list that cannot be inferred
 * from any of the others.
 */
export function capTabs(all: BrowserTab[]): BrowserTab[] {
  if (all.length <= TAB_LIMIT) return all
  const kept = all.slice(0, TAB_LIMIT)
  if (kept.some((tab) => tab.active)) return kept
  const live = all.find((tab) => tab.active)
  if (!live) return kept
  return [...all.slice(0, TAB_LIMIT - 1), live]
}

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

