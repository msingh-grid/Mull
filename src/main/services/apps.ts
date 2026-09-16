import { APP_LIMIT } from '@shared/agent'
import { osascript, RS, ScriptError, US, type RunScript } from './osascript'

/**
 * What is running, so the agent can go somewhere else.
 *
 * ### Why this needs a bridge at all
 *
 * Everything else in the pipeline is about *one* window: `frontmostApp` says
 * which app that is, `uiTargets` says what is in it, `activateApp` puts a named
 * app in front. What none of them can answer is the question the model has to
 * answer first — **what else is there?** A bundle id is not something a model
 * can guess reliably (`com.tinyspeck.slackmacgap` is not a name anyone would
 * invent), and guessing wrong means activating nothing or, worse, the wrong
 * thing.
 *
 * macOS keeps that list, and Electron's main process cannot see it: `app` knows
 * about *this* application, and there is no `NSWorkspace.runningApplications`
 * on the JavaScript side. So it is asked for, through System Events, which is
 * the same route `services/browser.ts` takes and for the same reason — the
 * information exists in the system, and AppleScript is the part of the system
 * that will hand it over without a native extension.
 *
 * ### Why not a sidecar verb
 *
 * `NSWorkspace.shared.runningApplications` is three lines of Swift and would be
 * the tidier home. It is not worth a protocol bump: the sidecar handshake is
 * strict equality (`Verbs.swift`, `SIDECAR_PROTOCOL_VERSION`), and a `mull-mac`
 * binary that has not been rebuilt fails `init` and takes the *whole* sidecar
 * down — no dictation, no accessibility, nothing — where a missing app list
 * costs one tool that says so in a sentence. `npm run build:sidecar` is a
 * separate manual step from `npm run dev`, so that is not a hypothetical. The
 * same call this file's header in `services/browser.ts` records.
 *
 * ### What is deliberately not asked for
 *
 * **How many windows each app has.** It would be the more useful list, and
 * System Events answers it one accessibility round trip at a time — a machine
 * with twenty apps open pays twenty walks for a number that is only ever used to
 * sort. `background only is false` already removes the daemons and menu-bar
 * agents, which is the filtering that actually matters, and an app with no
 * window says so the moment the agent looks at it.
 *
 * ### The permission
 *
 * This is an Apple Event to System Events rather than to a browser, so it raises
 * its own one-time consent dialog, separate from the per-browser ones. Until it
 * is answered every call here fails with `not-permitted`, and the tool says so
 * in a sentence the model can act on — cross-app becomes unavailable and nothing
 * else changes.
 */

/** One running application, as System Events describes it. */
export interface RunningApp {
  /** What `activateApp` needs. Empty for the rare process that has none. */
  bundleId: string
  name: string
  /** The one in front. Exactly one, unless the switch is mid-flight. */
  front: boolean
}

export interface AppsBridge {
  list(): Promise<RunningApp[]>
}

/**
 * Every application with a user interface, in the order System Events keeps.
 *
 * `background only is false` is the filter that makes this list readable: it is
 * the flag on `LSBackgroundOnly`/`LSUIElement` processes, which is to say every
 * daemon, every menu-bar extra and every helper — a machine with eight apps open
 * has sixty-odd processes, and fifty of them are not somewhere anyone can go.
 *
 * The two `try` blocks are not defensive padding. A process can genuinely have
 * no bundle identifier (anything launched from a path rather than a bundle), and
 * a process that quits between the enumeration and the read raises rather than
 * returning missing — either one would otherwise abandon the whole list over one
 * entry nobody wanted.
 */
const LIST: string[] = [
  'on run argv',
  'set RS to character id 30',
  'set US to character id 31',
  'set out to ""',
  'tell application "System Events"',
  'set ps to (every application process whose background only is false)',
  'repeat with p in ps',
  'set bid to ""',
  'try',
  'set bid to bundle identifier of p',
  'end try',
  'set nm to ""',
  'try',
  'set nm to name of p',
  'end try',
  'if nm is not "" then',
  'set out to out & bid & US & nm & US & ((frontmost of p) as text) & RS',
  'end if',
  'end repeat',
  'end tell',
  'return out',
  'end run'
]

export class AppleScriptApps implements AppsBridge {
  private readonly run: RunScript

  constructor(options: { run?: RunScript } = {}) {
    this.run = options.run ?? osascript
  }

  /**
   * Takes nothing, and passes nothing.
   *
   * Worth noticing rather than passing over: this is the only bridge call in
   * Mull with no outside input at all, so the injection question the rest of
   * `services/osascript.ts` is about does not arise here. The script is a
   * constant.
   */
  async list(): Promise<RunningApp[]> {
    const out = await this.run(LIST, [])
    const apps = parseApps(out)
    if (apps.length === 0) {
      throw new ScriptError('missing', 'System Events listed no applications')
    }
    return apps.slice(0, APP_LIMIT)
  }
}

/** One RS-delimited record per app, three US-delimited fields each. */
export function parseApps(out: string): RunningApp[] {
  const apps: RunningApp[] = []
  for (const record of out.split(RS)) {
    const trimmed = record.trim()
    if (!trimmed) continue
    const fields = trimmed.split(US)
    if (fields.length < 3) continue
    const name = (fields[1] as string).trim()
    // A process with no name is one that quit while the list was being built.
    // A process with no bundle id cannot be activated, so it is not a place the
    // agent could go and listing it would only invite a switch that fails.
    if (!name) continue
    const bundleId = (fields[0] as string).trim()
    if (!bundleId) continue
    apps.push({ bundleId, name, front: (fields[2] as string).trim() === 'true' })
  }
  return apps
}
