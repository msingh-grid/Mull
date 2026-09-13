import { describe, expect, it } from 'vitest'
import type { ScreenContext } from '@shared/context'
import type { AnswerCard } from '@shared/hud'
import type { JournalDraft, JournalEntry } from '@shared/types'
import type { AnswerRequest, Engine } from '../engine/types'
import type { JournalStore } from '../store/journal'
import type { CaptureStore } from '../store/captures'
import { AskLane } from './ask'

/**
 * The lane that writes nothing, and the reason it exists.
 *
 * "Summarize all my tasks which I need to complete", spoken over a page of
 * notes, used to come back as an EDIT PREVIEW: a diff card, every line marked
 * as an insertion, an Apply button, and "⌥Z undoes after apply" underneath. The
 * summary was right and the card was offering to paste it into the very notes
 * it summarised — one reflexive ⏎ away, because ⏎ means Apply on every other
 * card in the app.
 *
 * So the assertions here are mostly about absence: no target, no commit, and
 * nothing anywhere in this lane that can put text into anything.
 */

const NOTES: ScreenContext = {
  app: { bundleId: 'com.apple.Notes', name: 'Notes' },
  windowTitle: 'Tasks',
  blocks: [
    { role: 'AXStaticText', text: 'Tasks:', label: null, focused: false, selected: false },
    {
      role: 'AXStaticText',
      text: '- Agent with ACT (later)\n- Convert rag function to mcp',
      label: null,
      focused: false,
      selected: false
    }
  ],
  truncated: false,
  image: { mediaType: 'image/jpeg', dataBase64: 'x', width: 8, height: 8, bytes: 4 },
  imageReason: null,
  chars: 56,
  harvestMs: 9
}

function harness(
  answer: (request: AnswerRequest, onPartial?: (text: string) => void) => Promise<{ text: string }>
) {
  const cards: AnswerCard[] = []
  const rows: JournalDraft[] = []
  const filed: Array<{ id: string; context: ScreenContext | null | undefined }> = []
  const notices: Array<{ phase: string; text: string }> = []
  const stages: Array<string | null> = []
  let closed = 0
  let act: ((action: 'apply' | 'apply-send' | 'cancel') => void) | null = null

  const engine = {
    name: 'test',
    model: null,
    ready: async () => ({ kind: 'ready' as const }),
    classify: async () => ({ kind: 'dictate' as const }),
    transform: async () => ({ text: '' }),
    compose: async () => ({ text: '' }),
    navigate: async () => ({ verb: 'done' as const, because: 'not this test' }),
    answer
  } satisfies Engine

  const lane = new AskLane({
    engine,
    journal: {
      append: (draft: JournalDraft) => {
        rows.push(draft)
        return { ...draft, at: 0 } as unknown as JournalEntry
      }
    } as unknown as JournalStore,
    captures: {
      save: (id: string, context: ScreenContext | null | undefined) => {
        filed.push({ id, context })
        return context ? ({ imageFile: `${id}.jpg` } as never) : null
      }
    } as unknown as CaptureStore,
    hud: {
      openCard: (card, onAction) => {
        cards.push(card)
        act = onAction
      },
      updateCard: (card) => cards.push(card),
      closeCard: () => {
        closed += 1
      },
      update: (patch) => stages.push(patch.stage),
      announce: (phase, text) => notices.push({ phase, text })
    }
  })

  return {
    lane,
    cards,
    rows,
    filed,
    notices,
    stages,
    closed: () => closed,
    done: () => act?.('cancel'),
    last: () => cards[cards.length - 1] ?? null
  }
}

const request = {
  question: 'summarize all my tasks which I need to complete',
  transcript: 'summarize all my tasks which I need to complete',
  app: { bundleId: 'com.apple.Notes', name: 'Notes' },
  context: NOTES
}

const ANSWER = 'Three tasks: the ACT agent (later), the rag→mcp conversion, and wiring real config.'

describe('AskLane', () => {
  it('shows an answer card, and it is the only kind of card it can show', async () => {
    const h = harness(async () => ({ text: ANSWER }))
    await h.lane.run(request)

    expect(h.last()).toEqual({ kind: 'answer', app: 'Notes', text: ANSWER })
  })

  /**
   * The whole point. A card with no `commit` cannot offer Apply & send, and the
   * `answer` kind is what `acceptsApply` in services/hud.ts reads to decide
   * that ⏎ closes rather than writes. Neither is a string this lane can set to
   * something else by mistake.
   */
  it('proposes nothing: no commit, no target, no text to insert', async () => {
    const h = harness(async () => ({ text: ANSWER }))
    await h.lane.run(request)

    const card = h.last()
    expect(card?.kind).toBe('answer')
    expect(card).not.toHaveProperty('commit')
    expect(card).not.toHaveProperty('segments')
    expect(Object.keys(card ?? {}).sort()).toEqual(['app', 'kind', 'text'])
  })

  it('is asked the user’s question about the window they were looking at', async () => {
    const seen: AnswerRequest[] = []
    const h = harness(async (r) => {
      seen.push(r)
      return { text: ANSWER }
    })
    await h.lane.run(request)

    expect(seen[0]?.goal).toBe(request.question)
    expect(seen[0]?.context).toBe(NOTES)
  })

  /** The card fills in as the sentences arrive rather than appearing whole. */
  it('opens on the first token and grows', async () => {
    const h = harness(async (_r, onPartial) => {
      onPartial?.('Three')
      onPartial?.('Three tasks:')
      return { text: ANSWER }
    })
    await h.lane.run(request)

    expect(h.cards.map((card) => card.text)).toEqual(['Three', 'Three tasks:', ANSWER])
  })

  /** An empty card reads as a bug in Mull. Say what happened instead. */
  it('says so rather than showing an empty card', async () => {
    const h = harness(async () => ({ text: '   ' }))
    await h.lane.run(request)

    expect(h.cards).toEqual([])
    expect(h.notices[0]?.phase).toBe('error')
    expect(h.rows[0]?.status).toBe('failed')
  })

  it('reports an engine failure instead of leaving the panel working', async () => {
    const h = harness(async () => {
      throw new Error('the engine is offline')
    })
    await h.lane.run(request)

    expect(h.notices[0]).toMatchObject({ phase: 'error' })
    expect(h.notices[0]?.text).toContain('the engine is offline')
    // And the working line is cleared, or the HUD counts seconds forever.
    expect(h.stages[h.stages.length - 1]).toBeNull()
  })

  /**
   * An ask reads the window and photographs it exactly as an edit does, so it
   * owes the same receipt — and `undoable` is false for the simplest reason
   * there is.
   */
  it('writes one row carrying the picture, and nothing to undo', async () => {
    const h = harness(async () => ({ text: ANSWER }))
    await h.lane.run(request)

    expect(h.rows).toHaveLength(1)
    const [row] = h.rows
    expect(row?.intent).toMatchObject({ kind: 'ask', question: request.question })
    expect(row?.before).toBeNull()
    expect(row?.after).toBe(ANSWER)
    expect(row?.undoable).toBe(false)
    expect(row?.capture).not.toBeNull()
    expect(h.filed[0]?.id).toBe(row?.id)
    expect(h.filed[0]?.context).toBe(NOTES)
  })
})
