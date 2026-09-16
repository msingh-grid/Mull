import { describe, expect, it } from 'vitest'
import { AppleScriptApps, parseApps } from './apps'
import { ScriptError, RS, US, type RunScript } from './osascript'

/**
 * The app list, without System Events.
 *
 * Same arrangement as `browser.test.ts`: the runner is injected, so nothing here
 * needs a Mac with anything open, a consent dialog or a signed build. What is
 * worth asserting is the parsing — because the failure mode of a delimited
 * format is not an exception, it is a *plausible* wrong answer, and a bundle id
 * read one column out is one `switchApp` away from activating the wrong
 * application.
 *
 * Whether the script compiles is a different question and no test can answer it.
 * `npm run check:applescript` can, and does.
 */

const THREE = [
  `com.tinyspeck.slackmacgap${US}Slack${US}false`,
  `com.google.Chrome${US}Google Chrome${US}true`,
  `com.apple.finder${US}Finder${US}false`
].join(RS)

function spy(answer: string | (() => never) = THREE): {
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

describe('reading what is running', () => {
  it('gives back the id, the name and which one is in front', async () => {
    const running = await new AppleScriptApps({ run: spy().run }).list()
    expect(running).toEqual([
      { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', front: false },
      { bundleId: 'com.google.Chrome', name: 'Google Chrome', front: true },
      { bundleId: 'com.apple.finder', name: 'Finder', front: false }
    ])
  })

  /**
   * A process with no bundle identifier cannot be activated — `activateApp`
   * takes one and has nothing else to go on — so listing it would only invite a
   * switch that fails. Dropping it is kinder than showing a destination that is
   * not reachable.
   */
  it('drops a process that cannot be activated rather than offering it', () => {
    const running = parseApps(
      [`${US}Some Helper${US}false`, `com.apple.Safari${US}Safari${US}false`].join(RS)
    )
    expect(running).toEqual([{ bundleId: 'com.apple.Safari', name: 'Safari', front: false }])
  })

  /** A truncated record must cost one entry, not shift every field after it. */
  it('drops a malformed record instead of misreading the rest', () => {
    const running = parseApps([`com.apple.Safari${US}Safari${US}false`, 'rubbish'].join(RS))
    expect(running).toHaveLength(1)
    expect(running[0]?.bundleId).toBe('com.apple.Safari')
  })

  /**
   * An empty answer is not an empty desktop.
   *
   * There is always at least one application running — Mull itself is one — so
   * nothing coming back means the script did not do what was asked rather than
   * that there is nowhere to go. Returning `[]` would have the model conclude
   * the machine is empty and stop; an error says something is wrong, which is
   * the true statement.
   */
  it('treats an empty list as a failure, because a Mac always has one', async () => {
    await expect(new AppleScriptApps({ run: spy('').run }).list()).rejects.toMatchObject({
      reason: 'missing'
    })
  })
})

describe('the script', () => {
  /**
   * The one bridge call in Mull with no outside input at all, asserted so it
   * stays that way. Nothing the model said, nothing a page said, and nothing the
   * user typed reaches this script — so the injection question the rest of
   * `osascript.ts` exists to answer does not arise here, and a future argument
   * would be the moment it starts to.
   */
  it('passes nothing in, because there is nothing to pass', async () => {
    const { run, calls } = spy()
    await new AppleScriptApps({ run }).list()
    expect(calls[0]?.args).toEqual([])
  })

  /**
   * The filter that makes the list readable. Without it a machine with eight
   * apps open reports sixty-odd processes, most of them menu-bar extras and
   * helpers nobody could go to.
   */
  it('asks only for processes a person could switch to', async () => {
    const { run, calls } = spy()
    await new AppleScriptApps({ run }).list()
    const script = (calls[0]?.script ?? []).join('\n')
    expect(script).toContain('background only is false')
    expect(script).toContain('tell application "System Events"')
  })
})

describe('when System Events says no', () => {
  it('carries the reason through rather than flattening it', async () => {
    for (const reason of ['not-permitted', 'timed-out', 'failed'] as const) {
      const { run } = spy(() => {
        throw new ScriptError(reason, reason)
      })
      await expect(new AppleScriptApps({ run }).list()).rejects.toMatchObject({ reason })
    }
  })
})
