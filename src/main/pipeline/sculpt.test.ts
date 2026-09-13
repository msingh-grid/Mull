import { describe, expect, it } from 'vitest'
import type { DiffCard, HudAction, HudCard } from '@shared/hud'
import type { HudState } from '@shared/ipc'
import type { JournalEntry } from '@shared/types'
import { FakeSidecar } from '../services/sidecar'
import { InsertionService } from '../services/insertion'
import { JournalStore } from '../store/journal'
import { memoryDatabase } from '../store/journal.test-helpers'
import { Bench, type BenchDraft, type EditRow } from '../bench'
import { CANONICAL_SAMPLE, FakeEngine } from '../engine/fake'
import type { Engine } from '../engine/types'
import { SculptLane, type SculptRequest } from './sculpt'

const BEFORE = CANONICAL_SAMPLE.before
const APP = { bundleId: 'com.apple.mail', name: 'Mail' }

/** Drain the microtask queue — nothing in this lane uses timers with fakes. */
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i += 1) await Promise.resolve()
}

interface Hud {
  patches: Array<Partial<HudState>>
  announcements: Array<{ phase: string; notice: string; lastAction?: HudState['lastAction'] }>
  cards: HudCard[]
  opens: number
  closes: number
  respond(action: HudAction): void
}

function harness(
  options: { engine?: Engine; sidecar?: FakeSidecar; selected?: string } = {}
): {
  lane: SculptLane
  hud: Hud
  sidecar: FakeSidecar
  journal: JournalStore
  rows: Array<BenchDraft<EditRow>>
  request: SculptRequest
} {
  const selected = options.selected ?? BEFORE
  const sidecar =
    options.sidecar ??
    new FakeSidecar({
      accessibility: true,
      app: { ...APP, pid: 1 },
      text: selected,
      caret: 0,
      selectionLength: selected.length
    })
  const journal = new JournalStore(memoryDatabase())
  const rows: Array<BenchDraft<EditRow>> = []
  const bench = new Bench('/dev/null')
  // Not a spy: the lane only ever hands `record` an edit row, and asserting
  // that directly is the point.
  bench.record = (row): void => {
    if (row.kind === 'edit') rows.push(row)
  }

  let onAction: ((action: HudAction) => void) | null = null
  const hud: Hud = {
    patches: [],
    announcements: [],
    cards: [],
    opens: 0,
    closes: 0,
    respond(action) {
      onAction?.(action)
    }
  }

  const lane = new SculptLane({
    engine: options.engine ?? new FakeEngine({ state: { kind: 'ready' }, chunkMs: 0 }),
    sidecar,
    insertion: new InsertionService({ sidecar }),
    journal,
    bench,
    hud: {
      update: (patch) => {
        hud.patches.push(patch)
        return true
      },
      announce: (phase, notice, lastAction) => {
        hud.announcements.push({ phase, notice, lastAction })
        return true
      },
      openCard: (card, handler) => {
        hud.cards.push(card)
        hud.opens += 1
        onAction = handler
      },
      updateCard: (card) => {
        hud.cards.push(card)
      },
      closeCard: () => {
        hud.closes += 1
        onAction = null
      }
    }
  })

  return {
    lane,
    hud,
    sidecar,
    journal,
    rows,
    request: {
      instruction: 'make this crisp',
      transcript: 'make this crisp',
      target: {
        kind: 'selection' as const,
        app: APP,
        start: 0,
        length: selected.length,
        text: selected,
        keystrokesSafe: true
      },
      app: APP
    }
  }
}

function lastEntry(journal: JournalStore): JournalEntry {
  const entries = journal.recent(1)
  expect(entries.length).toBe(1)
  return entries[0]!
}

describe('SculptLane — the preview', () => {
  it('opens a card and fills it in as the engine writes', async () => {
    const h = harness()
    await h.lane.run(h.request)

    expect(h.hud.opens).toBe(1)
    // Many updates, not one: the marks arrive the way writing does.
    expect(h.hud.cards.length).toBeGreaterThan(3)
    const final = h.hud.cards.at(-1) as DiffCard
    expect(final.kind).toBe('diff')
    expect(final.app).toBe('Mail — selection')
    expect(final.changes).toBeGreaterThan(0)
  })

  it('stamps the Edit chip before anything is proposed', async () => {
    const h = harness()
    await h.lane.run(h.request)
    const chips = h.hud.patches.flatMap((patch) => patch.chips ?? [])
    expect(chips.some((chip) => chip.kind === 'intent' && chip.label === 'Edit')).toBe(true)
  })

  it('changes nothing on its own', async () => {
    const h = harness()
    await h.lane.run(h.request)
    expect(h.sidecar.insertions).toEqual([])
    expect(h.journal.recent(10)).toEqual([])
  })
})

describe('SculptLane — apply', () => {
  it('replaces the selection and offers undo', async () => {
    const h = harness()
    await h.lane.run(h.request)
    h.hud.respond('apply')
    await settle()

    expect(h.sidecar.insertions.length).toBe(1)
    const entry = lastEntry(h.journal)
    expect(entry.status).toBe('applied')
    expect(entry.intent).toEqual({
      kind: 'edit',
      instruction: 'make this crisp',
      target: 'selection',
      transcript: 'make this crisp'
    })
    expect(entry.before).toBe(BEFORE)
    expect(entry.after).toBe(h.sidecar.insertions[0])
    expect(entry.undoable).toBe(true)

    const applied = h.hud.announcements.at(-1)
    expect(applied?.phase).toBe('applied')
    expect(applied?.lastAction?.entryId).toBe(entry.id)
    expect(applied?.lastAction?.undoable).toBe(true)
  })

  it('applies through paste without promising an undo it cannot keep', async () => {
    // The Electron-app case: AX refuses, the paste lands, and nothing read it
    // back. The edit still happens — but `undoable` stays false, because ⌥Z
    // removing text Mull only *believes* it wrote is the worst thing here.
    const sidecar = new FakeSidecar({
      accessibility: true,
      app: { ...APP, pid: 1 },
      text: BEFORE,
      caret: 0,
      selectionLength: BEFORE.length,
      supports: { ax: false, paste: true, type: true },
      unreadable: true
    })
    const h = harness({ sidecar })
    // A selection in the focused element may fall through to paste; one found
    // elsewhere in the app may not. This is the former.
    h.request.target.keystrokesSafe = true
    await h.lane.run(h.request)
    h.hud.respond('apply')
    await settle()

    const entry = lastEntry(h.journal)
    expect(entry.status).toBe('applied')
    expect(entry.strategyUsed).toBe('paste')
    expect(entry.undoable).toBe(false)
  })

  it('records the edit in the ledger with a first-token time', async () => {
    const h = harness()
    await h.lane.run(h.request)
    h.hud.respond('apply')
    await settle()

    expect(h.rows.length).toBe(1)
    const row = h.rows[0]!
    expect(row.outcome).toBe('applied')
    expect(row.engine).toBe('fake')
    expect(row.changes).toBeGreaterThan(0)
    expect(row.firstTokenMs).not.toBeNull()
    // The ledger keeps lengths, never the writing itself.
    expect(JSON.stringify(row)).not.toContain('sorry to bother')
  })
})

describe('SculptLane — the refusals', () => {
  it('cancels without writing, and still writes it down', async () => {
    const h = harness()
    await h.lane.run(h.request)
    h.hud.respond('cancel')
    await settle()

    expect(h.sidecar.insertions).toEqual([])
    expect(lastEntry(h.journal).status).toBe('cancelled')
    expect(h.hud.announcements.at(-1)?.notice).toMatch(/nothing changed/i)
    expect(h.rows.at(-1)?.outcome).toBe('cancelled')
  })

  it('refuses when the selection changed under the preview', async () => {
    const h = harness()
    await h.lane.run(h.request)

    // The user kept typing while they read the card.
    h.sidecar.text = 'something else entirely'
    h.sidecar.caret = 0
    h.sidecar.selectionLength = h.sidecar.text.length

    h.hud.respond('apply')
    await settle()

    expect(h.sidecar.insertions).toEqual([])
    expect(lastEntry(h.journal).status).toBe('failed')
    expect(h.hud.announcements.at(-1)?.notice).toMatch(/has changed since Mull read it/i)
  })

  it('refuses when the selection is gone', async () => {
    const h = harness()
    await h.lane.run(h.request)
    h.sidecar.selectionLength = 0

    h.hud.respond('apply')
    await settle()

    expect(h.sidecar.insertions).toEqual([])
    expect(h.hud.announcements.at(-1)?.notice).toMatch(/selection is gone/i)
  })

  it('says so, and keeps dictation’s name out of it, when there is no engine', async () => {
    const h = harness({ engine: new FakeEngine({ state: { kind: 'signed-out' } }) })
    await h.lane.run(h.request)

    expect(h.hud.opens).toBe(0)
    const blocked = h.hud.announcements.at(-1)
    expect(blocked?.phase).toBe('blocked')
    expect(blocked?.notice).toMatch(/Dictation still works/)
    expect(lastEntry(h.journal).status).toBe('cancelled')
    expect(h.rows.at(-1)?.outcome).toBe('unavailable')
  })

  it('reports an engine that fails mid-stream rather than applying a fragment', async () => {
    const broken: Engine = {
      name: 'broken',
      model: null,
      ready: async () => ({ kind: 'ready' }),
      classify: async () => ({ kind: 'dictate' as const }),
      transform: async (_request, onPartial) => {
        onPartial?.('Following up:')
        throw new Error('rate limited')
      },
      compose: async () => ({ text: '' }),
      plan: async () => ({ steps: [], context: null })
    }
    const h = harness({ engine: broken })
    await h.lane.run(h.request)

    expect(h.sidecar.insertions).toEqual([])
    expect(h.hud.closes).toBe(1)
    expect(h.hud.announcements.at(-1)?.notice).toMatch(/rate limited/)
    expect(lastEntry(h.journal).status).toBe('failed')
  })

  it('closes the card instead of asking you to approve nothing', async () => {
    const unchanged: Engine = {
      name: 'echo',
      model: null,
      ready: async () => ({ kind: 'ready' }),
      classify: async () => ({ kind: 'dictate' as const }),
      transform: async (request) => ({ text: request.text }),
      compose: async () => ({ text: '' }),
      plan: async () => ({ steps: [], context: null })
    }
    const h = harness({ engine: unchanged })
    await h.lane.run(h.request)

    expect(h.hud.closes).toBe(1)
    expect(h.hud.announcements.at(-1)?.notice).toMatch(/already reads well/i)
    expect(h.sidecar.insertions).toEqual([])
  })
})

describe('SculptLane — ⏎ while the engine is still writing', () => {
  it('waits for the whole proposal instead of applying a fragment', async () => {
    let release = (): void => {}
    const finished = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: Engine = {
      name: 'slow',
      model: null,
      ready: async () => ({ kind: 'ready' }),
      classify: async () => ({ kind: 'dictate' as const }),
      transform: async (_request, onPartial) => {
        onPartial?.('Following up:')
        await finished
        return { text: CANONICAL_SAMPLE.after }
      },
      compose: async () => ({ text: '' }),
      plan: async () => ({ steps: [], context: null })
    }
    const h = harness({ engine: slow })
    const running = h.lane.run(h.request)
    await settle()

    // The user decides before the engine has finished.
    h.hud.respond('apply')
    await settle()
    expect(h.sidecar.insertions).toEqual([])

    release()
    await running
    await settle()

    // What landed is the complete rewrite, not the prefix that was on screen.
    expect(h.sidecar.insertions).toEqual([CANONICAL_SAMPLE.after])
  })
})

/**
 * The whole-field case (M4.1) — the Slack composer with nothing highlighted.
 *
 * Written through `replaceRange` with `expect` rather than the insertion chain:
 * a whole-field rewrite has to be exact, and the paste fallback would need a
 * ⌘A first. "Select everything in whatever has focus, then overwrite it" is not
 * a thing to do on a guess.
 */
describe('SculptLane — a document target', () => {
  function documentHarness(): ReturnType<typeof harness> {
    const h = harness()
    h.request.target = {
      kind: 'document',
      app: APP,
      start: 0,
      length: BEFORE.length,
      text: BEFORE,
      keystrokesSafe: false
    }
    // Nothing is highlighted; the caret is just sitting in the field.
    h.sidecar.selectionLength = 0
    h.sidecar.caret = BEFORE.length
    return h
  }

  it('says in the card that ⏎ rewrites the whole field', async () => {
    const h = documentHarness()
    await h.lane.run(h.request)
    expect((h.hud.cards.at(-1) as DiffCard).app).toBe('Mail — whole field')
  })

  it('rewrites the field and stays undoable', async () => {
    const h = documentHarness()
    await h.lane.run(h.request)
    h.hud.respond('apply')
    await settle()

    const entry = lastEntry(h.journal)
    expect(entry.status).toBe('applied')
    expect(entry.intent).toMatchObject({ target: 'document' })
    expect(entry.before).toBe(BEFORE)
    expect(h.sidecar.text).toBe(entry.after)
    // `replaceRange` reports no caret, so it is computed — and only because the
    // write was read back, which is what makes ⌥Z safe to offer.
    expect(entry.verified).toBe(true)
    expect(entry.caret).toBe((entry.after ?? '').length)
    expect(entry.undoable).toBe(true)
  })

  it('refuses when the field changed under the preview', async () => {
    const h = documentHarness()
    await h.lane.run(h.request)

    h.sidecar.text = `${BEFORE} and one more thing`
    h.hud.respond('apply')
    await settle()

    expect(h.sidecar.text).toBe(`${BEFORE} and one more thing`)
    expect(lastEntry(h.journal).status).toBe('failed')
    expect(h.hud.announcements.at(-1)?.notice).toMatch(/has changed since Mull read it/i)
  })

  it('refuses in an app that will not take an AX write', async () => {
    const sidecar = new FakeSidecar({
      accessibility: true,
      app: { ...APP, pid: 1 },
      text: BEFORE,
      caret: BEFORE.length,
      selectionLength: 0,
      supports: { ax: false, paste: true, type: true }
    })
    const h = harness({ sidecar })
    h.request.target = {
      kind: 'document',
      app: APP,
      start: 0,
      length: BEFORE.length,
      text: BEFORE,
      keystrokesSafe: false
    }

    await h.lane.run(h.request)
    h.hud.respond('apply')
    await settle()

    expect(h.sidecar.text).toBe(BEFORE)
    expect(lastEntry(h.journal).status).toBe('failed')
  })
})

/**
 * The reported case (M4.2): a selection in a sent Slack message.
 *
 * Mull can read it and cannot write to it, so the rewrite is *inserted at the
 * caret* — which is the composer, which is where the user wanted it. Refusing
 * instead would be technically correct and useless.
 */
describe('SculptLane — a reference target', () => {
  const SENT = 'I am so sorry to bother you again about the terms doc.'

  function referenceHarness(): ReturnType<typeof harness> {
    // Nothing is selected in the focused element: the selection lives in a
    // read-only part of the app, found by the tree walk.
    const sidecar = new FakeSidecar({
      accessibility: true,
      app: { ...APP, pid: 1 },
      text: '',
      caret: 0,
      selectionLength: 0
    })
    const h = harness({ sidecar })
    h.request.target = {
      kind: 'reference',
      app: APP,
      start: 0,
      length: SENT.length,
      text: SENT,
      keystrokesSafe: false
    }
    return h
  }

  it('tells you the rewrite is going to your cursor, not over the text', async () => {
    const h = referenceHarness()
    await h.lane.run(h.request)
    expect((h.hud.cards.at(-1) as DiffCard).app).toBe('Mail — to cursor')
  })

  it('inserts rather than replaces, and records no `before`', async () => {
    const h = referenceHarness()
    // The selection is still there when Apply lands.
    h.sidecar.text = SENT
    h.sidecar.caret = 0
    h.sidecar.selectionLength = SENT.length

    await h.lane.run(h.request)
    h.hud.respond('apply')
    await settle()

    const entry = lastEntry(h.journal)
    expect(entry.status).toBe('applied')
    expect(entry.intent).toMatchObject({ target: 'reference' })
    // Nothing was overwritten, so there is nothing to restore — ⌥Z removes the
    // insertion instead.
    expect(entry.before).toBeNull()
    expect(entry.after).toBe(h.sidecar.insertions[0])
  })

  it('still refuses when the text it read has changed', async () => {
    const h = referenceHarness()
    h.sidecar.text = SENT
    h.sidecar.caret = 0
    h.sidecar.selectionLength = SENT.length
    await h.lane.run(h.request)

    h.sidecar.text = 'something else entirely'
    h.sidecar.selectionLength = h.sidecar.text.length
    h.hud.respond('apply')
    await settle()

    expect(h.sidecar.insertions).toEqual([])
    expect(lastEntry(h.journal).status).toBe('failed')
  })
})

/**
 * A selection Mull found outside the focused element can only be written
 * through AX. Paste and type post keystrokes, which land wherever the caret is
 * — so falling back to them would replace whatever the user's cursor happened
 * to be sitting in, which is the worst outcome this app has.
 */
describe('SculptLane — a selection that is not where the caret is', () => {
  it('refuses rather than pasting over whatever has focus', async () => {
    const sidecar = new FakeSidecar({
      accessibility: true,
      app: { ...APP, pid: 1 },
      text: BEFORE,
      caret: 0,
      selectionLength: BEFORE.length,
      // The app refuses AX writes, and paste is not an option here.
      supports: { ax: false, paste: true, type: true }
    })
    const h = harness({ sidecar })
    h.request.target.keystrokesSafe = false

    await h.lane.run(h.request)
    h.hud.respond('apply')
    await settle()

    expect(h.sidecar.insertions).toEqual([])
    expect(lastEntry(h.journal).status).toBe('failed')
  })
})

/**
 * The third report: the preview was right and Apply did nothing.
 *
 * `stillMatches` used to read the focused element first and refuse if it got
 * nothing back — and an app that will not hand over a focused element is
 * exactly the case a tree-found selection exists for. So every apply on a
 * selection in Slack was refused before the selection was ever re-read.
 */
describe('SculptLane — applying in an app with no readable focused element', () => {
  function noFocusHarness(kind: 'selection' | 'reference'): ReturnType<typeof harness> {
    const sidecar = new FakeSidecar({
      accessibility: true,
      app: { ...APP, pid: 1 },
      text: BEFORE,
      caret: 0,
      selectionLength: BEFORE.length,
      selectionSource: 'tree',
      // The composer refuses to describe itself, which is what broke this.
      noFocus: true
    })
    const h = harness({ sidecar })
    h.request.target = {
      kind,
      app: APP,
      start: 0,
      length: BEFORE.length,
      text: BEFORE,
      keystrokesSafe: false
    }
    return h
  }

  it('applies a reference edit instead of refusing', async () => {
    const h = noFocusHarness('reference')
    await h.lane.run(h.request)
    h.hud.respond('apply')
    await settle()

    expect(h.sidecar.insertions.length).toBe(1)
    expect(lastEntry(h.journal).status).toBe('applied')
    expect(h.hud.announcements.at(-1)?.notice).toMatch(/applied/i)
  })

  it('applies a selection edit instead of refusing', async () => {
    const h = noFocusHarness('selection')
    await h.lane.run(h.request)
    h.hud.respond('apply')
    await settle()

    expect(h.sidecar.insertions.length).toBe(1)
    expect(lastEntry(h.journal).status).toBe('applied')
  })

  it('still refuses when the selection really is gone', async () => {
    const h = noFocusHarness('reference')
    await h.lane.run(h.request)
    h.sidecar.selectionLength = 0

    h.hud.respond('apply')
    await settle()

    expect(h.sidecar.insertions).toEqual([])
    expect(h.hud.announcements.at(-1)?.notice).toMatch(/selection is gone/i)
  })
})

/**
 * Composing a reply (M5a) — a new route through the same lane and the same card.
 *
 * A draft diffs against the empty string, so every segment comes out as an
 * insertion and the DiffCard renders it as pure writing ink. That is not a
 * trick: a new reply genuinely is all insertion, and giving it its own card
 * type would have meant a second renderer to keep in step for no gain.
 */
describe('SculptLane — drafting a reply', () => {
  function draftRequest(): SculptRequest {
    return {
      instruction: 'reply saying the redlines will be there by five',
      transcript: 'reply saying the redlines will be there by five',
      target: {
        kind: 'draft' as const,
        app: APP,
        start: 0,
        length: 0,
        text: '',
        keystrokesSafe: true
      },
      app: APP,
      context: {
        app: APP,
        windowTitle: '#terms-doc',
        blocks: [
          {
            role: 'AXStaticText',
            text: 'can you confirm the redlines by EOD?',
            label: null,
            focused: false,
            selected: false
          }
        ],
        truncated: false,
        image: null,
        imageReason: 'not-requested',
        chars: 36,
        harvestMs: 11
      }
    }
  }

  it('says it is writing a reply, not editing anything', async () => {
    const h = harness()
    await h.lane.run(draftRequest())

    const chips = h.hud.patches.flatMap((patch) => patch.chips ?? [])
    expect(chips.find((chip) => chip.id === 'intent')?.label).toBe('Reply')
    expect((h.hud.cards.at(-1) as DiffCard).app).toBe('Mail — a new reply')
  })

  it('renders as pure insertion — there is nothing being taken away', async () => {
    const h = harness()
    await h.lane.run(draftRequest())

    const final = h.hud.cards.at(-1) as DiffCard
    expect(final.segments.length).toBeGreaterThan(0)
    expect(final.segments.every((segment) => segment.kind === 'ins')).toBe(true)
  })

  it('asks the compose lane, not the edit lane', async () => {
    const asked: string[] = []
    const engine: Engine = {
      name: 'spy',
      model: null,
      ready: async () => ({ kind: 'ready' }),
      classify: async () => ({ kind: 'dictate' }),
      transform: async () => {
        asked.push('transform')
        return { text: 'wrong lane' }
      },
      compose: async (request) => {
        asked.push('compose')
        // The conversation reaches it; that is the whole point of the route.
        expect(request.context?.blocks[0]?.text).toContain('redlines by EOD')
        return { text: 'Confirmed — you will have them by five.' }
      },
      plan: async () => ({ steps: [], context: null })
    }

    const h = harness({ engine })
    await h.lane.run(draftRequest())
    expect(asked).toEqual(['compose'])
  })

  it('inserts at the caret and replaces nothing', async () => {
    const h = harness({
      sidecar: new FakeSidecar({
        accessibility: true,
        app: { ...APP, pid: 1 },
        text: '',
        caret: 0
      })
    })

    await h.lane.run(draftRequest())
    h.hud.respond('apply')
    await settle()

    expect(h.sidecar.insertions.length).toBe(1)
    // Nothing was replaced, so the journal has no `before` — and undo must
    // remove the insertion rather than try to restore something that never was.
    const entry = lastEntry(h.journal)
    expect(entry.before).toBeNull()
    expect(entry.status).toBe('applied')
    expect(entry.summary.startsWith('Reply ·')).toBe(true)
  })

  /**
   * Nothing can have moved under a draft, because there was never anything
   * under it. The app check is the whole guard — it must still be the window
   * the reply was written for.
   */
  it('does not demand a selection that never existed', async () => {
    const h = harness({
      sidecar: new FakeSidecar({
        accessibility: true,
        app: { ...APP, pid: 1 },
        text: '',
        caret: 0
      })
    })

    await h.lane.run(draftRequest())
    h.hud.respond('apply')
    await settle()

    expect(h.hud.announcements.at(-1)?.phase).toBe('applied')
  })

  it('refuses when the user has moved to another app', async () => {
    const h = harness({
      sidecar: new FakeSidecar({
        accessibility: true,
        app: { bundleId: 'com.apple.Notes', name: 'Notes', pid: 2 },
        text: '',
        caret: 0
      })
    })

    await h.lane.run(draftRequest())
    h.hud.respond('apply')
    await settle()

    expect(h.sidecar.insertions.length).toBe(0)
    expect(h.hud.announcements.at(-1)?.notice).toContain('switched apps')
  })

  /**
   * An empty reply is a failure, not a compliment. The edit lane's "that
   * already reads well" would be nonsense here — nothing was written at all.
   */
  it('says so when the engine drafts nothing', async () => {
    const engine: Engine = {
      name: 'mute',
      model: null,
      ready: async () => ({ kind: 'ready' }),
      classify: async () => ({ kind: 'dictate' }),
      transform: async () => ({ text: '' }),
      compose: async () => ({ text: '' }),
      plan: async () => ({ steps: [], context: null })
    }

    const h = harness({ engine })
    await h.lane.run(draftRequest())

    expect(h.hud.announcements.at(-1)).toMatchObject({
      phase: 'error',
      notice: 'Mull couldn’t draft anything from what’s on screen.'
    })
  })
})
