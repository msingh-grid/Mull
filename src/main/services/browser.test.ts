import { describe, expect, it } from 'vitest'
import { AppleScriptBrowser, BrowserError, parseTabs, type RunScript } from './browser'

/**
 * The AppleScript bridge, without AppleScript.
 *
 * Every test here injects the runner, so none of them needs a browser, a
 * consent dialog or a signed build — which is the point of the runner being
 * injectable at all. What they check is the part that is genuinely easy to get
 * wrong and impossible to notice: which dialect goes to which browser, that a
 * URL is never spliced into a script, and that each way a browser can say no
 * arrives as the *right* no rather than a generic failure.
 */

const US = '\u001f'
const RS = '\u001e'

/** Two tabs, the second showing, in the shape the scripts return. */
const TWO = [
  `1${US}Inbox (41)${US}https://mail.google.com/u/0/${US}false`,
  `2${US}September${US}https://calendar.google.com/calendar/u/0/r/month${US}true`
].join(RS)

function spy(answer: string | (() => never) = TWO): {
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

describe('reading what is open', () => {
  it('parses the browser’s own numbering, titles and addresses', async () => {
    const { run } = spy()
    const tabs = await new AppleScriptBrowser({ run }).tabs('com.google.Chrome')
    expect(tabs).toEqual([
      { index: 1, title: 'Inbox (41)', url: 'https://mail.google.com/u/0/', active: false },
      {
        index: 2,
        title: 'September',
        url: 'https://calendar.google.com/calendar/u/0/r/month',
        active: true
      }
    ])
  })

  it('survives a browser with nothing open', async () => {
    const { run } = spy('')
    expect(await new AppleScriptBrowser({ run }).tabs('com.google.Chrome')).toEqual([])
  })

  /**
   * A title with a stray separator in it, or a truncated record, must drop that
   * one line rather than shifting every field after it — a tab list read one
   * column out is worse than a tab list one entry short, because it looks right.
   */
  it('drops a malformed record instead of misreading the rest', () => {
    const tabs = parseTabs([`1${US}Fine${US}https://a.example/${US}true`, 'rubbish'].join(RS))
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.title).toBe('Fine')
  })
})

describe('the two dialects', () => {
  /**
   * Safari's dictionary predates Chrome's and agrees with it on nothing that
   * matters here: a tab has a `name` rather than a `title`, and the window
   * points at a `current tab` rather than an index. Sending one browser the
   * other's script does not throw — it returns the wrong thing, or nothing, and
   * that is exactly the failure a test has to catch.
   */
  it('asks Chromium browsers for a title and an active tab index', async () => {
    const { run, calls } = spy()
    for (const id of ['com.google.Chrome', 'com.brave.Browser', 'com.microsoft.edgemac']) {
      await new AppleScriptBrowser({ run }).tabs(id)
    }
    for (const call of calls) {
      expect(call.script.join('\n')).toContain('active tab index')
      expect(call.script.join('\n')).toContain('title of t')
    }
  })

  it('asks Safari for a name and a current tab', async () => {
    const { run, calls } = spy()
    await new AppleScriptBrowser({ run }).tabs('com.apple.Safari')
    const script = (calls[0]?.script ?? []).join('\n')
    expect(script).toContain('current tab')
    expect(script).toContain('name of t')
    expect(script).not.toContain('active tab index')
  })

  it('refuses an app that is not a browser rather than guessing a dialect', async () => {
    const { run } = spy()
    const browser = new AppleScriptBrowser({ run })
    expect(browser.supports('com.tinyspeck.slackmacgap')).toBe(false)
    expect(browser.supports('com.google.Chrome')).toBe(true)
    await expect(browser.tabs('com.tinyspeck.slackmacgap')).rejects.toMatchObject({
      reason: 'not-scriptable'
    })
  })
})

describe('outside input is an argument', () => {
  /**
   * The one that matters most in this file.
   *
   * A URL is attacker-shaped input by assumption. Spliced into a script, a
   * quote in one ends the string and everything after it is AppleScript — which
   * is arbitrary Apple Events sent as the user, a far worse outcome than the
   * navigation it was pretending to be. So the two values that come from outside
   * travel in argv, and this asserts it for both.
   */
  it('never puts a URL in the script', async () => {
    const { run, calls } = spy(`1${US}x${US}https://ok.example/${US}true`)
    const nasty = 'https://ok.example/"\n do shell script "echo pwned" \n set x to "'
    await new AppleScriptBrowser({ run }).openUrl({
      bundleId: 'com.google.Chrome',
      url: nasty,
      newTab: true
    })
    const call = calls[0]
    expect(call?.script.join('\n')).not.toContain('pwned')
    expect(call?.script.join('\n')).not.toContain('ok.example')
    expect(call?.args).toContain(nasty)
  })

  it('never puts a tab number in the script', async () => {
    const { run, calls } = spy(`3${US}x${US}https://ok.example/${US}true`)
    await new AppleScriptBrowser({ run }).switchTab('com.google.Chrome', 3)
    expect(calls[0]?.args).toEqual(['3'])
    expect(calls[0]?.script.join('\n')).toContain('item 1 of argv')
  })

  /**
   * The one exception, and why it is not a hole.
   *
   * AppleScript resolves an application's vocabulary at compile time from that
   * application's dictionary, so a variable target does not compile at all —
   * `scripts/check-applescript.ts` is what caught that, and it is the reason the
   * bundle id is the one value written into the script. What keeps it safe is
   * that it can only ever be a key of `BROWSERS`: a constant from this
   * repository, chosen by a lookup, never a value from a model or a page.
   */
  it('writes the bundle id into the script, because AppleScript leaves no choice', async () => {
    const { run, calls } = spy()
    await new AppleScriptBrowser({ run }).tabs('com.apple.Safari')
    expect(calls[0]?.script).toContain('tell application id "com.apple.Safari"')
  })

  it('refuses a bundle id that is not one of ours, so nothing else can get in', async () => {
    const { run, calls } = spy()
    const browser = new AppleScriptBrowser({ run })
    for (const id of ['com.evil.App', 'com.google.Chrome" & (do shell script "id") & "']) {
      await expect(browser.tabs(id)).rejects.toMatchObject({ reason: 'not-scriptable' })
    }
    expect(calls).toEqual([])
  })

  it('passes newTab as a flag the script reads, not as a different script', async () => {
    const { run, calls } = spy(`1${US}x${US}https://ok.example/${US}true`)
    const browser = new AppleScriptBrowser({ run })
    await browser.openUrl({ bundleId: 'com.google.Chrome', url: 'https://ok.example/', newTab: true })
    await browser.openUrl({ bundleId: 'com.google.Chrome', url: 'https://ok.example/', newTab: false })
    expect(calls[0]?.args[1]).toBe('1')
    expect(calls[1]?.args[1]).toBe('0')
    expect(calls[0]?.script).toEqual(calls[1]?.script)
  })
})

describe('when there is no browser in front', () => {
  /**
   * Opening a URL while standing in Mail is an ordinary thing to want, and the
   * system already has an answer for it. What the caller has to be able to tell
   * is that nobody observed where it landed — hence `active: false`, which is
   * the difference between "the browser told me this is showing" and "I asked
   * for it".
   */
  it('hands the URL to the default browser', async () => {
    const { run, calls } = spy('')
    const tab = await new AppleScriptBrowser({ run }).openUrl({
      bundleId: null,
      url: 'https://calendar.google.com/',
      newTab: true
    })
    expect(calls[0]?.args).toEqual(['https://calendar.google.com/'])
    expect(tab.active).toBe(false)
    expect(tab.url).toBe('https://calendar.google.com/')
  })
})

describe('the ways a browser says no', () => {
  /**
   * Three refusals that want three different next moves, and osascript reports
   * all of them the same way — a non-zero exit and a line on stderr. Permission
   * is the one worth separating: it is not a failure of the run, it is a thing
   * the user has to go and do, and a model told that gets on with the task
   * instead of retrying a call that will refuse identically every time.
   */
  const throws = (reason: string) =>
    spy(() => {
      throw new BrowserError(reason as never, reason)
    })

  it('carries the reason through rather than flattening it', async () => {
    for (const reason of ['not-permitted', 'no-window', 'missing', 'timed-out']) {
      const { run } = throws(reason)
      await expect(new AppleScriptBrowser({ run }).tabs('com.google.Chrome')).rejects.toMatchObject({
        reason
      })
    }
  })

  it('refuses when a switch came back saying nothing', async () => {
    const { run } = spy('')
    await expect(
      new AppleScriptBrowser({ run }).switchTab('com.google.Chrome', 2)
    ).rejects.toMatchObject({ reason: 'missing' })
  })
})
