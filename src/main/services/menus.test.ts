import { describe, expect, it } from 'vitest'
import { AppleScriptMenus, parseMenus } from './menus'
import { ScriptError, RS, US, type RunScript } from './osascript'

/**
 * The menu bar, without System Events.
 *
 * Same arrangement as `apps.test.ts` and for the same reasons: the runner is
 * injected, so nothing here needs a Mac, a consent dialog or an application with
 * a window open. And as there, the parsing is what is worth asserting — a
 * delimited format does not fail by throwing, it fails by returning a
 * *plausible* wrong answer, and a command read one column out is a `chooseMenu`
 * away from doing something nobody asked for.
 *
 * Whether the scripts compile is a separate question no test can answer.
 * `npm run check:applescript` can, and does.
 */

const FIVE = [
  `File${US}New Tab${US}true${US}0`,
  `File${US}Save Page As…${US}false${US}0`,
  `File${US}Share${US}true${US}1`,
  `Edit${US}Find…${US}true${US}0`,
  `View${US}Stop${US}false${US}0`
].join(RS)

function spy(answer: string | (() => never) = FIVE): {
  run: RunScript
  calls: Array<{ script: string[]; args: string[] }>
} {
  const calls: Array<{ script: string[]; args: string[] }> = []
  return {
    calls,
    run: async (script, args) => {
      calls.push({ script, args })
      if (typeof answer !== 'string') return answer()
      return answer
    }
  }
}

describe('reading the menus', () => {
  it('gives back the heading, the command, and both of its states', async () => {
    const commands = await new AppleScriptMenus({ run: spy().run }).list('Google Chrome')
    expect(commands).toEqual([
      { menu: 'File', name: 'New Tab', enabled: true, submenu: false },
      { menu: 'File', name: 'Save Page As…', enabled: false, submenu: false },
      { menu: 'File', name: 'Share', enabled: true, submenu: true },
      { menu: 'Edit', name: 'Find…', enabled: true, submenu: false },
      { menu: 'View', name: 'Stop', enabled: false, submenu: false }
    ])
  })

  /**
   * Greyed out is information, not absence.
   *
   * It would be tidier to drop these and the tidiness would cost the model the
   * difference between "this application cannot do that" and "not until
   * something is selected" — and only the second suggests a next move.
   */
  it('keeps the commands the app has greyed out', async () => {
    const commands = await new AppleScriptMenus({ run: spy().run }).list('Google Chrome')
    expect(commands.filter((command) => !command.enabled).map((command) => command.name)).toEqual([
      'Save Page As…',
      'Stop'
    ])
  })

  /** A truncated record must cost one command, not shift every field after it. */
  it('drops a malformed record instead of misreading the rest', () => {
    const commands = parseMenus([`File${US}New Tab${US}true${US}0`, 'rubbish'].join(RS))
    expect(commands).toHaveLength(1)
    expect(commands[0]?.name).toBe('New Tab')
  })

  /**
   * The same test `AXTargets` applies to an unlabelled button: a command with no
   * name cannot be chosen by a model or checked by a user reading the card, so
   * offering it is offering a coin flip.
   */
  it('drops a command with no name', () => {
    const commands = parseMenus(
      [`File${US}${US}true${US}0`, `File${US}Save${US}true${US}0`].join(RS)
    )
    expect(commands.map((command) => command.name)).toEqual(['Save'])
  })

  /**
   * An empty answer is not an application without menus.
   *
   * Every Mac application has a menu bar — AppKit requires it, and a survey of
   * eight across four toolkits found no exceptions — so nothing coming back
   * means the script did not do what was asked. Returning `[]` would have the
   * model conclude the app has no commands and give up; an error says something
   * is wrong, which is the true statement.
   */
  it('treats an empty answer as a failure, because every Mac app has menus', async () => {
    await expect(new AppleScriptMenus({ run: spy('').run }).list('Zed')).rejects.toMatchObject({
      reason: 'missing'
    })
  })
})

describe('the scripts', () => {
  /**
   * The rule `services/osascript.ts` exists to keep, asserted at the one bridge
   * where the model supplies two of the three arguments.
   *
   * A menu name spliced into the script text would not be a syntax error — it
   * would be *more AppleScript*, sent as the user. This is the test that fails
   * if someone ever finds it easier to build the string.
   */
  it('passes the process, the menu and the command as arguments, never as script', async () => {
    const { run, calls } = spy()
    await new AppleScriptMenus({ run }).choose('Notes', 'File', 'New Note')
    expect(calls[0]?.args).toEqual(['Notes', 'File', 'New Note'])
    const script = (calls[0]?.script ?? []).join('\n')
    expect(script).not.toContain('New Note')
    expect(script).not.toContain('Notes')
  })

  it('reads with the process as its only argument', async () => {
    const { run, calls } = spy()
    await new AppleScriptMenus({ run }).list('Google Chrome')
    expect(calls[0]?.args).toEqual(['Google Chrome'])
  })

  /**
   * The Apple menu is skipped by name, and it is worth a test because the
   * reason is safety rather than tidiness: it is Shut Down, Restart, Log Out and
   * Force Quit, identical in every application, and never what anybody meant.
   */
  it('never reads the Apple menu', async () => {
    const { run, calls } = spy()
    await new AppleScriptMenus({ run }).list('Notes')
    expect((calls[0]?.script ?? []).join('\n')).toContain('if top is not "Apple" then')
  })

  /**
   * The three bulk fetches that make this usable.
   *
   * Reading `name`, `enabled` and the submenu count off each item one at a time
   * is the obvious implementation and takes **6.3 seconds** against Chrome's 152
   * commands — measured. Fetching each property as a whole list and zipping them
   * in-process is 0.55s, because the round trips stop scaling with the commands.
   * This asserts the shape that difference depends on.
   */
  it('fetches each property as a whole list rather than item by item', async () => {
    const { run, calls } = spy()
    await new AppleScriptMenus({ run }).list('Notes')
    const script = (calls[0]?.script ?? []).join('\n')
    expect(script).toContain('name of every menu item')
    expect(script).toContain('enabled of every menu item')
    expect(script).toContain('name of every menu of every menu item')
  })
})

describe('when System Events says no', () => {
  it('carries the reason through rather than flattening it', async () => {
    for (const reason of ['not-permitted', 'timed-out', 'failed'] as const) {
      const { run } = spy(() => {
        throw new ScriptError(reason, reason)
      })
      await expect(new AppleScriptMenus({ run }).list('Notes')).rejects.toMatchObject({ reason })
    }
  })
})
