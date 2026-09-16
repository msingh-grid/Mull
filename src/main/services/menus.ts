import { MENU_LIMIT } from '@shared/agent'
import { osascript, RS, ScriptError, US, type RunScript } from './osascript'

/**
 * What the application in front can actually do.
 *
 * ### The surface nothing else in Mull looks at
 *
 * Everything else here reads a *window*: `uiTargets` walks the frontmost one,
 * `windowContext` harvests its words, `find` narrows the result. That is the
 * right place to look for what is on screen and the wrong place to look for what
 * an application can be asked to do, and the difference is not small.
 *
 * A window shows whatever is rendered at this scroll position on this page. A
 * menu bar is the whole command surface, written in plain words by the people
 * who built the app, in the same place whatever is on screen. Every Mac
 * application has one — AppKit requires it — and a survey of eight across four
 * toolkits found no exceptions: Finder, Notes, Slack, Chrome, VS Code, Zed,
 * Claude, iTerm2, between 89 and 152 commands each.
 *
 * The case that made this unignorable: **Zed**. A real window, and
 * `uiTargets` finds *zero* targets in it and one block of text, because GPUI
 * draws its own interface and publishes almost nothing to accessibility. The
 * menu bar next door has 110 commands in it. In the app where Mull is blind, the
 * entire command surface was sitting there the whole time.
 *
 * Mull never saw it for a structural reason rather than an oversight:
 * `AXTargets.scan` roots at `AXHarvest.window(of: app)`, and a menu bar hangs
 * off the *application* element. One level too low, in every scan ever made.
 *
 * ### Why AppleScript and not Swift
 *
 * The same call `services/apps.ts` records, for the same reason: the sidecar
 * handshake is strict equality, `npm run build:sidecar` is a manual step
 * separate from `npm run dev`, and a binary that has not been rebuilt fails
 * `init` and takes the *whole* sidecar down. A menu bar Mull cannot read costs
 * one tool that says so in a sentence. It is also fast enough not to need the
 * argument: a full read is 0.4–1.3s, measured across those same four toolkits.
 *
 * That number is only true because of how `READ` is written — see its docstring.
 * The obvious version of this script takes six seconds.
 *
 * ### Depth one, deliberately
 *
 * A submenu is not read and cannot be chosen. `Share ▸`, `Services ▸`, `Export
 * as ▸` are marked and refused with a sentence saying why, rather than silently
 * absent. Depth one is where the commands people actually name live — New, Open,
 * Save, Find, Preferences — and the long tail below is mostly Recent Items and
 * Services. If that turns out to be wrong it is a second bulk fetch per marked
 * item, which is a change to this file and nothing else.
 */

/** One command, as it appears in a menu. */
export interface MenuCommand {
  /** The heading it lives under: 'File', 'Edit', 'View'. */
  menu: string
  /** The item's own label, exactly as macOS spells it — including the ellipsis. */
  name: string
  /** False for commands the app has greyed out right now. */
  enabled: boolean
  /** It opens a submenu, which is as far as this goes. See the header. */
  submenu: boolean
}

export interface MenusBridge {
  list(process: string): Promise<MenuCommand[]>
  choose(process: string, menu: string, name: string): Promise<void>
}

/**
 * Every menu of one process, in three accessibility round trips per menu.
 *
 * ### Why it is written this way and not the obvious way
 *
 * The obvious version walks `menu items` and reads `name`, `enabled` and the
 * submenu count off each one. Every one of those reads is an Apple Event to a
 * separate process, and against Chrome's 152 commands the obvious version takes
 * **6.3 seconds** — measured, not estimated. Bulk-fetching the three properties
 * as three whole lists and zipping them in-process is the same information in
 * **0.55s**, because the count of round trips stops depending on the count of
 * commands.
 *
 * So the loop below is doing something slightly odd on purpose: `ns`, `es` and
 * `ss` are parallel lists, and everything after the fetch is arithmetic rather
 * than accessibility.
 *
 * `name of every menu of every menu item` is the submenu test, and it is a list
 * of lists — empty for an ordinary command, one entry for one that opens a
 * submenu. Asking for a count per item instead costs a round trip each and puts
 * the six seconds back.
 *
 * ### Two things skipped
 *
 * **The Apple menu**, by name. It is not the application's — it is Shut Down,
 * Restart, Log Out and Force Quit, identical in every app, useful to nobody
 * here and uniformly the worst thing on the machine to press by accident.
 * Cheaper to never list than to refuse convincingly.
 *
 * **Separators.** macOS reports them as items whose name is `missing value`.
 */
const READ: string[] = [
  'on run argv',
  'set RS to character id 30',
  'set US to character id 31',
  'set out to ""',
  'tell application "System Events"',
  'tell process (item 1 of argv)',
  'set bars to name of every menu bar item of menu bar 1',
  'repeat with i from 1 to count of bars',
  'set top to item i of bars as text',
  'if top is not "Apple" then',
  'try',
  'tell menu 1 of menu bar item top of menu bar 1',
  'set ns to name of every menu item',
  'set es to enabled of every menu item',
  'set ss to name of every menu of every menu item',
  'end tell',
  'repeat with j from 1 to count of ns',
  'set nm to item j of ns',
  'if nm is not missing value then',
  'set sub to "0"',
  'try',
  'if (count of (item j of ss)) > 0 then set sub to "1"',
  'end try',
  'set out to out & top & US & nm & US & ((item j of es) as text) & US & sub & RS',
  'end if',
  'end repeat',
  'end try',
  'end if',
  'end repeat',
  'end tell',
  'end tell',
  'return out',
  'end run'
]

/**
 * Choose one command.
 *
 * `click` rather than `perform action "AXPress"`, because System Events' `click`
 * opens the parent menu first and AXPress on a menu item of a menu that is not
 * showing is a coin flip across applications.
 *
 * Both the menu and the item travel in `argv` — see the rule in
 * `services/osascript.ts`. A menu name spliced into this text would not be a
 * syntax error, it would be more AppleScript, running as the user.
 */
const CHOOSE: string[] = [
  'on run argv',
  'tell application "System Events"',
  'tell process (item 1 of argv)',
  'click menu item (item 3 of argv) of menu 1 of menu bar item (item 2 of argv) of menu bar 1',
  'end tell',
  'end tell',
  'end run'
]

export class AppleScriptMenus implements MenusBridge {
  private readonly run: RunScript

  constructor(options: { run?: RunScript } = {}) {
    this.run = options.run ?? osascript
  }

  /**
   * `process` is the name System Events knows the application by — which is the
   * `name` field `apps` already returns, and the one `frontmostApp` reports. Not
   * the bundle id: System Events addresses processes by name, and this is the
   * rare place where that is the more convenient of the two.
   */
  async list(process: string): Promise<MenuCommand[]> {
    const out = await this.run(READ, [process])
    const commands = parseMenus(out)
    if (commands.length === 0) {
      throw new ScriptError('missing', `${process} has no menus Mull can read`)
    }
    return commands.slice(0, MENU_LIMIT)
  }

  async choose(process: string, menu: string, name: string): Promise<void> {
    await this.run(CHOOSE, [process, menu, name])
  }
}

/** One RS-delimited record per command, four US-delimited fields each. */
export function parseMenus(out: string): MenuCommand[] {
  const commands: MenuCommand[] = []
  for (const record of out.split(RS)) {
    const trimmed = record.trim()
    if (!trimmed) continue
    const fields = trimmed.split(US)
    if (fields.length < 4) continue
    const menu = (fields[0] as string).trim()
    const name = (fields[1] as string).trim()
    // A nameless command cannot be chosen by a model or checked by a user
    // reading the card, which is the same test `AXTargets` applies to an
    // unlabelled button.
    if (!menu || !name) continue
    commands.push({
      menu,
      name,
      enabled: (fields[2] as string).trim() === 'true',
      submenu: (fields[3] as string).trim() === '1'
    })
  }
  return commands
}
