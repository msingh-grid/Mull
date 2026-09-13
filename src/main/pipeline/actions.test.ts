import { describe, expect, it } from 'vitest'
import type { UiTarget } from '@shared/sidecar-api'
import { FakeSidecar } from '../services/sidecar'
import { NavStepSchema, type NavStep } from '@shared/nav'
import { ActionExecutor, type Scan } from './actions'

/**
 * What these tests are actually protecting.
 *
 * The executor is the only place in Mull that drives someone else's UI on the
 * model's say-so, so the interesting cases are all refusals. Three layers have
 * to hold, and each is tested here on its own terms:
 *
 *   the union   a step that cannot be described cannot be performed
 *   the kind    a press target is not a type target and vice versa
 *   the handle  an index is only good for the scan it came from
 */

const SIDEBAR: UiTarget[] = [
  target(0, { title: 'Search', role: 'AXButton' }),
  target(1, { title: 'Channel or user name', role: 'AXTextField', kind: 'type' }),
  target(2, { title: 'Anil Turaga (away, notifications snoozed)', role: 'AXRow' }),
  target(3, { title: 'Leave channel', role: 'AXButton' }),
  target(4, { title: 'Message Anil Turaga', role: 'AXTextArea', kind: 'type' }),
  target(5, { title: 'Archive conversation', role: 'AXButton' })
]

function target(index: number, patch: Partial<UiTarget>): UiTarget {
  return {
    index,
    role: 'AXButton',
    subrole: null,
    title: `target ${index}`,
    help: null,
    value: null,
    frame: null,
    actions: ['AXPress'],
    enabled: true,
    focused: false,
    kind: 'press',
    ...patch
  }
}

function harness(targets: UiTarget[] = SIDEBAR): {
  sidecar: FakeSidecar
  executor: ActionExecutor
  scan: Scan
  run: (step: NavStep) => ReturnType<ActionExecutor['perform']>
} {
  const sidecar = new FakeSidecar({ accessibility: true, targets })
  const executor = new ActionExecutor({ sidecar, sleep: async () => {} })
  const scan: Scan = { harvestId: 'scan-1', targets }
  return {
    sidecar,
    executor,
    scan,
    run: (step) =>
      executor.perform(step, scan, {
        app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
        goal: 'what did Anil say about the terms doc'
      })
  }
}

/** A scan has to have happened for the fake to hold handles, as in the real one. */
async function scanned(sidecar: FakeSidecar): Promise<void> {
  await sidecar.uiTargets({})
}

// ---------------------------------------------------------------------------

describe('NavStepSchema — the vocabulary is the safety argument', () => {
  it('cannot describe sending, in any spelling', () => {
    for (const step of [
      { verb: 'send' },
      { verb: 'keyChord', key: 'return', modifiers: ['cmd'] },
      { verb: 'navKey', key: 'return' },
      { verb: 'insertText', text: 'see you at five' },
      { verb: 'press', index: 0, label: 'Send', modifiers: ['cmd'], key: 'return' }
    ]) {
      const parsed = NavStepSchema.safeParse(step)
      // The last one parses — extra keys are stripped, not rejected — but what
      // survives is a plain press, which is the point: there is no shape of
      // this object that carries a keystroke.
      if (parsed.success) expect(parsed.data).toEqual({ verb: 'press', index: 0, label: 'Send' })
      else expect(parsed.success).toBe(false)
    }
  })

  it('bounds the one string the navigator may write', () => {
    expect(NavStepSchema.safeParse({ verb: 'type', index: 1, text: 'Anil' }).success).toBe(true)
    expect(NavStepSchema.safeParse({ verb: 'type', index: 1, text: '' }).success).toBe(false)
    // A paragraph arriving here means something upstream went wrong; this is a
    // search query, not a message.
    expect(NavStepSchema.safeParse({ verb: 'type', index: 1, text: 'x'.repeat(500) }).success).toBe(
      false
    )
  })
})

describe('press', () => {
  it('presses a row the scan actually offered', async () => {
    const h = harness()
    await scanned(h.sidecar)
    const result = await h.run({ verb: 'press', index: 2, label: 'Anil Turaga' })
    expect(result.ok).toBe(true)
    expect(h.sidecar.targetActions).toEqual([{ verb: 'press', index: 2 }])
  })

  it('refuses an index the scan never had', async () => {
    const h = harness()
    await scanned(h.sidecar)
    const result = await h.run({ verb: 'press', index: 99, label: 'whatever' })
    expect(result).toMatchObject({ ok: false, refusedBy: 'no-such-target' })
    expect(h.sidecar.targetActions).toEqual([])
  })

  /**
   * The backstop. Not the defence — the plan card and Escape are — but a
   * deny-list that fails closed is worth having under them.
   */
  it('will not press something destructive, whatever it was asked', async () => {
    const h = harness()
    await scanned(h.sidecar)
    for (const index of [3, 5]) {
      const result = await h.run({ verb: 'press', index, label: 'go on' })
      expect(result).toMatchObject({ ok: false, refusedBy: 'destructive' })
    }
    expect(h.sidecar.targetActions).toEqual([])
  })

  /**
   * The scan is a photograph, not a live view. A row that moved between the
   * look and the keystroke must refuse rather than land on its replacement —
   * this is the entire reason the press quotes the title back.
   */
  it('refuses when the row has become somebody else', async () => {
    const h = harness()
    await scanned(h.sidecar)
    h.sidecar.retarget([
      target(0, { title: 'Search', role: 'AXButton' }),
      target(1, { title: 'Channel or user name', role: 'AXTextField', kind: 'type' }),
      // A notification pushed a different person into slot 2.
      target(2, { title: 'Dheeraj Kasavajjala', role: 'AXRow' })
    ])
    const result = await h.run({ verb: 'press', index: 2, label: 'Anil Turaga' })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('Dheeraj Kasavajjala')
    expect(h.sidecar.targetActions).toEqual([])
  })

  it('refuses a target that is a text field, not a button', async () => {
    const h = harness()
    await scanned(h.sidecar)
    const result = await h.run({ verb: 'press', index: 1, label: 'Channel or user name' })
    expect(result).toMatchObject({ ok: false, refusedBy: 'wrong-kind' })
  })

  /**
   * `AXPress` reports that the action was *accepted*, not that it did anything,
   * and reporting only the label back is how the navigator got stuck: history
   * read `press 37 "Anil Turaga" — ok: Anil Turaga` twice in a row, so pressing
   * the same row again looked exactly as reasonable as pressing it the first
   * time. What it needed was evidence, and the window title is the cheapest
   * honest evidence there is.
   */
  it('says where the press took us', async () => {
    const h = harness()
    h.sidecar.moveTo('Prahastha Shankesi (DM) - Slack')
    await scanned(h.sidecar)
    h.sidecar.moveTo('Anil Turaga (DM) - Slack')
    const result = await h.run({ verb: 'press', index: 2, label: 'Anil Turaga' })
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('Anil Turaga (DM) - Slack')
  })

  it('says plainly when the press changed nothing', async () => {
    const h = harness()
    h.sidecar.moveTo('Prahastha Shankesi (DM) - Slack')
    await scanned(h.sidecar)
    // No `moveTo`: the press was accepted and the window stayed put.
    const result = await h.run({ verb: 'press', index: 2, label: 'Anil Turaga' })
    expect(result.ok).toBe(true)
    expect(result.detail).toMatch(/still/u)
    expect(result.detail).toContain('Prahastha Shankesi (DM) - Slack')
  })

  /** An app that names no window is not an app that refuses to be navigated. */
  it('still reports the press when there is no window title to compare', async () => {
    const h = harness()
    await scanned(h.sidecar)
    const result = await h.run({ verb: 'press', index: 2, label: 'Anil Turaga' })
    expect(result).toMatchObject({ ok: true, detail: SIDEBAR[2]?.title })
  })
})

describe('type — the only text the navigator can put anywhere', () => {
  it('types a query into a search field', async () => {
    const h = harness()
    await scanned(h.sidecar)
    const result = await h.run({ verb: 'type', index: 1, text: 'Anil' })
    expect(result.ok).toBe(true)
    expect(h.sidecar.insertions).toEqual(['Anil'])
  })

  /**
   * The one that matters. A composer is a text area and a search box is a text
   * field, so the sidecar's own `textRoles` already refuses this — but an app
   * could put a one-line reply box on `AXTextField`, so the name is checked too.
   */
  it('will not type into a message composer', async () => {
    const h = harness()
    await scanned(h.sidecar)
    const result = await h.run({ verb: 'type', index: 4, text: 'see you at five' })
    expect(result.ok).toBe(false)
    expect(h.sidecar.insertions).toEqual([])
  })

  it('will not type into a button', async () => {
    const h = harness()
    await scanned(h.sidecar)
    const result = await h.run({ verb: 'type', index: 0, text: 'Anil' })
    expect(result).toMatchObject({ ok: false, refusedBy: 'wrong-kind' })
    expect(h.sidecar.insertions).toEqual([])
  })

  it('refuses a text field whose name is not a search box', async () => {
    const h = harness([target(0, { title: 'Reply', role: 'AXTextField', kind: 'type' })])
    await scanned(h.sidecar)
    const result = await h.run({ verb: 'type', index: 0, text: 'sure' })
    expect(result).toMatchObject({ ok: false, refusedBy: 'not-a-search-field' })
    expect(h.sidecar.insertions).toEqual([])
  })
})

describe('the journal', () => {
  it('writes each step as its own command, never as an undoable edit', async () => {
    const rows: Array<Record<string, unknown>> = []
    const sidecar = new FakeSidecar({ accessibility: true, targets: SIDEBAR })
    await sidecar.uiTargets({})
    const executor = new ActionExecutor({
      sidecar,
      sleep: async () => {},
      journal: {
        append: (draft) => {
          rows.push(draft as unknown as Record<string, unknown>)
          return { id: 'e1', at: 0, undone: false, ...draft } as never
        }
      }
    })
    await executor.perform({ verb: 'press', index: 2, label: 'Anil Turaga' }, { harvestId: 'scan-1', targets: SIDEBAR }, { app: null, goal: 'find Anil' })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'applied',
      // Nothing a press does can be taken back by ⌥Z, and claiming otherwise
      // would put a row in the undo stack that undoes nothing.
      undoable: false,
      intent: { kind: 'command', verb: 'nav.press', transcript: 'find Anil' }
    })
  })

  it('records a refusal too — a plan that did nothing should say so', async () => {
    const rows: Array<Record<string, unknown>> = []
    const sidecar = new FakeSidecar({ accessibility: true, targets: SIDEBAR })
    await sidecar.uiTargets({})
    const executor = new ActionExecutor({
      sidecar,
      sleep: async () => {},
      journal: {
        append: (draft) => {
          rows.push(draft as unknown as Record<string, unknown>)
          return { id: 'e1', at: 0, undone: false, ...draft } as never
        }
      }
    })
    await executor.perform({ verb: 'press', index: 3, label: 'Leave channel' }, { harvestId: 'scan-1', targets: SIDEBAR }, { app: null, goal: 'find Anil' })
    expect(rows[0]).toMatchObject({ status: 'failed' })
  })
})

describe('restore', () => {
  it('goes back to the app the user was in', async () => {
    const sidecar = new FakeSidecar({ accessibility: true, targets: SIDEBAR })
    const executor = new ActionExecutor({ sidecar, sleep: async () => {} })
    const result = await executor.restore(
      { app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' }, windowTitle: null },
      null
    )
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('Slack')
  })

  /**
   * Slack's window title is "Anil Turaga (DM) - Grid Dynamics - Slack" and the
   * sidebar row is "Anil Turaga (away, notifications snoozed)" — neither
   * contains the other, so the match is on the name at the front.
   */
  it('presses the row the window title named, when it can find it', async () => {
    const sidecar = new FakeSidecar({ accessibility: true, targets: SIDEBAR })
    await sidecar.uiTargets({})
    const executor = new ActionExecutor({ sidecar, sleep: async () => {} })
    const result = await executor.restore(
      {
        app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
        windowTitle: 'Anil Turaga (DM) - Grid Dynamics - Slack'
      },
      { harvestId: 'scan-1', targets: SIDEBAR }
    )
    expect(result.ok).toBe(true)
    expect(sidecar.targetActions).toEqual([{ verb: 'press', index: 2 }])
  })

  /**
   * Being unable to get back is not a failure — it is a fact to report. The
   * card says where the window was left and the user decides what to do.
   */
  it('says where it left the window when the row is gone', async () => {
    const sidecar = new FakeSidecar({ accessibility: true, targets: [] })
    await sidecar.uiTargets({})
    const executor = new ActionExecutor({ sidecar, sleep: async () => {} })
    const result = await executor.restore(
      { app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' }, windowTitle: '#eng-platform' },
      { harvestId: 'scan-1', targets: [] }
    )
    expect(result.ok).toBe(true)
    expect(result.detail).toBe('left in #eng-platform')
  })
})
