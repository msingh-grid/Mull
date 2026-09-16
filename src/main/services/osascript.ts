import { execFile } from 'node:child_process'

/**
 * Running an AppleScript, and reading what it says back.
 *
 * Lifted out of `services/browser.ts` when `services/apps.ts` became its second
 * caller. Nothing here knows about tabs, applications or what any particular
 * script is for — it spawns `osascript`, hands outside input to it as arguments,
 * and turns the one way osascript reports failure (a non-zero exit and a line on
 * stderr) into something a caller can branch on.
 *
 * ### The one rule everything here exists to keep
 *
 * **Outside input travels in `argv`, never in the script text.** A URL, a tab
 * number, a search term — none of it is ever interpolated. That matters more
 * here than it usually does: a quote spliced into a script does not produce a
 * syntax error, it produces *more AppleScript*, and AppleScript sends Apple
 * Events as the user. An injection here is arbitrary control of the user's
 * applications, which is a far worse outcome than whatever the call was
 * pretending to be.
 *
 * The one thing a caller may write into a script is an application's identity,
 * and only because AppleScript leaves no choice — see `appId` in
 * `services/browser.ts` for the full reason, and `scripts/check-applescript.ts`
 * for the check that caught it.
 *
 * ### Why no test in this file
 *
 * There is nothing here to unit-test that would not be testing `execFile`. What
 * is worth checking is whether the scripts its callers build are valid
 * AppleScript, and no test can answer that — `osacompile` can, which is what
 * `npm run check:applescript` does.
 */

/**
 * How long one script may take.
 *
 * An application mid-navigation answers Apple Events late, and one showing a
 * modal sheet may not answer at all. Five seconds is long enough that a busy
 * Chrome finishes and short enough that a hung one does not eat the run's
 * deadline — and unlike the run's deadline this one kills a real subprocess, so
 * it has to actually fire.
 */
const SCRIPT_TIMEOUT_MS = 5_000

/**
 * Field and record separators. Chosen because no title, URL or app name has one.
 *
 * Written as escapes rather than as the characters themselves on purpose: these
 * are invisible in every editor, and a literal 0x1F is one stray "strip control
 * characters" pass away from being silently deleted. The scripts build the same
 * two characters with `character id 31` and `character id 30`, which is
 * AppleScript's way of saying it legibly.
 */
export const US = '\u001f'
export const RS = '\u001e'

/** Why a script failed, in terms a caller can act on. */
export type ScriptFailure =
  /** The user has not granted, or has refused, Automation for this target. */
  | 'not-permitted'
  /** Nothing Mull can script under that identity. */
  | 'not-scriptable'
  /** Scriptable, but with no window to answer about. */
  | 'no-window'
  /** The thing asked for — a tab, an application — is not there any more. */
  | 'missing'
  /** The script did not come back. The target is busy, or hung. */
  | 'timed-out'
  /** Anything else osascript said; the message carries it. */
  | 'failed'

export class ScriptError extends Error {
  constructor(
    readonly reason: ScriptFailure,
    message: string
  ) {
    super(message)
    this.name = 'ScriptError'
  }
}

/**
 * The seam every bridge is built against.
 *
 * Injectable so the bridges can be tested without a Mac, a browser, a consent
 * dialog or a signed build — which is most of why those tests exist at all.
 */
export type RunScript = (script: string[], args: string[]) => Promise<string>

/** The sentinel a caller passes instead of a script to hand something to `open`. */
export const OPEN_SENTINEL = '__open__'

/**
 * What osascript said, or a `ScriptError` naming which kind of no it was.
 *
 * The mapping matters because the interesting failures want different sentences
 * in front of the user and osascript reports all of them identically. `-1743` is
 * the consent dialog having been refused or not yet answered, which is the one
 * worth saying out loud, because it is a thing the *user* has to go and do and
 * no amount of retrying will change it. `-600` is the target having quit
 * underneath us. `-1728` is something that has since gone away, which during a
 * run is ordinary rather than alarming.
 */
export async function osascript(script: string[], args: string[]): Promise<string> {
  const isOpen = script[0] === OPEN_SENTINEL
  const file = isOpen ? '/usr/bin/open' : '/usr/bin/osascript'
  // `--` is what keeps a URL beginning with a dash from being read as a flag.
  const argv = isOpen ? args : [...script.flatMap((line) => ['-e', line]), '--', ...args]

  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      argv,
      { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout)
        const said = `${stderr || ''}${err.message || ''}`
        reject(new ScriptError(failureOf(said, err), said.trim() || 'the script failed'))
      }
    )
  })
}

/**
 * Narrowed to `killed` rather than taking `ExecException`.
 *
 * `ExecException.code` is `string | number | undefined` where
 * `NodeJS.ErrnoException.code` is `string | undefined`, so the wider type does
 * not assign — and nothing here reads a code anyway.
 */
function failureOf(said: string, err: { killed?: boolean }): ScriptFailure {
  if (err.killed || /ETIMEDOUT/u.test(said)) return 'timed-out'
  if (/-1743|not authori[sz]ed|Not allowed to send Apple events/iu.test(said)) return 'not-permitted'
  if (/can.t get application id/iu.test(said)) return 'not-scriptable'
  if (/-600\b|isn.t running|is not running/iu.test(said)) return 'no-window'
  if (/-1728|no such tab|no window|can.t get process/iu.test(said)) return 'missing'
  return 'failed'
}
