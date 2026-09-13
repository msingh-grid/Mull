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
      snapshot: { app: APP, start: 0, length: selected.length, text: selected },
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
    expect(final.app).toBe('Mail')
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
      transform: async (_request, onPartial) => {
        onPartial?.('Following up:')
        throw new Error('rate limited')
      },
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
      transform: async (request) => ({ text: request.text }),
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
      transform: async (_request, onPartial) => {
        onPartial?.('Following up:')
        await finished
        return { text: CANONICAL_SAMPLE.after }
      },
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
