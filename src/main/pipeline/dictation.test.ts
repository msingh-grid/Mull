import { describe, expect, it, vi } from 'vitest'
import { CAPTURE_SAMPLE_RATE, type HudState } from '@shared/ipc'
import { FakeSidecar } from '../services/sidecar'
import { FakeAsrProvider } from '../asr/fake'
import { Bench, type BenchDraft, type DictationRow } from '../bench'
import { InsertionService, describeInsertionReason } from '../services/insertion'
import { JournalStore } from '../store/journal'
import { memoryDatabase } from '../store/journal.test-helpers'
import { DictationPipeline } from './dictation'
import type { SculptRequest } from './sculpt'

function speech(seconds: number, amplitude = 0.25): Float32Array {
  const samples = new Float32Array(Math.round(CAPTURE_SAMPLE_RATE * seconds))
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / CAPTURE_SAMPLE_RATE) * amplitude
  }
  return samples
}

interface Harness {
  pipe: DictationPipeline
  sidecar: FakeSidecar
  journal: JournalStore
  states: HudState[]
  rows: Array<BenchDraft<DictationRow>>
  capture: { started: number; stopped: number }
  clock: { advance: (ms: number) => void }
  /** Everything the router handed to the edit lane. */
  sculpted: SculptRequest[]
}

function harness(options: {
  sidecar?: FakeSidecar
  transcript?: string
  /** Absent = no edit lane at all, which is the M1–M3 behaviour. */
  sculpt?: boolean | 'throws'
} = {}): Harness {
  const sidecar = options.sidecar ?? new FakeSidecar({ accessibility: true })
  const journal = new JournalStore(memoryDatabase())
  const states: HudState[] = []
  const rows: Array<BenchDraft<DictationRow>> = []
  const capture = { started: 0, stopped: 0 }

  let clockMs = 1_000
  const bench = new Bench('/dev/null')
  vi.spyOn(bench, 'record').mockImplementation((row) => {
    // This harness is about the dictation path; edit rows belong to sculpt.test.ts.
    if (row.kind === 'dictation') rows.push(row)
  })

  const sculpted: SculptRequest[] = []
  const pipe = new DictationPipeline(
    {
      sidecar,
      asr: new FakeAsrProvider(options.transcript ?? 'um, hello from the pipeline test.', 0),
      bench,
      insertion: new InsertionService({ sidecar }),
      journal,
      sculpt: options.sculpt
        ? {
            run: async (request) => {
              sculpted.push(request)
              if (options.sculpt === 'throws') throw new Error('the engine exploded')
            }
          }
        : undefined,
      onState: (s) => states.push({ ...s }),
      now: () => clockMs,
      appliedLingerMs: 5,
      capture: {
        start: () => {
          capture.started += 1
        },
        stop: () => {
          capture.stopped += 1
        }
      }
    },
    CAPTURE_SAMPLE_RATE
  )

  return {
    pipe,
    sidecar,
    journal,
    states,
    rows,
    capture,
    clock: { advance: (ms) => { clockMs += ms } },
    sculpted
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('DictationPipeline', () => {
  it('runs the happy path: listen → think → insert → applied', async () => {
    const h = harness()
    h.pipe.begin()
    expect(h.capture.started).toBe(1)
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()

    expect(h.capture.stopped).toBe(1)
    // Consecutive duplicates are real pushes (the transcript arrives before
    // the phase changes); what matters is the order they occur in.
    const phases = h.states.map((s) => s.phase).filter((p, i, all) => p !== all[i - 1])
    expect(phases).toEqual(['listening', 'thinking', 'inserting', 'applied', 'idle'])
    expect(h.sidecar.insertions).toEqual(['Hello from the pipeline test.'])
    expect(h.rows[0]).toMatchObject({ outcome: 'applied', chars: 29 })
    h.pipe.dispose()
  })

  it('records stage timings for every utterance', async () => {
    const h = harness()
    h.pipe.begin()
    h.pipe.pushChunk(speech(2))
    h.clock.advance(2_000)
    h.pipe.end()
    await settle()

    const row = h.rows[0]
    expect(row?.captureMs).toBe(2_000)
    expect(row?.audioSeconds).toBeCloseTo(2, 1)
    expect(row?.provider).toBe('fake')
    h.pipe.dispose()
  })

  it('discards an accidental tap without calling ASR', async () => {
    const h = harness()
    h.pipe.begin()
    h.pipe.pushChunk(speech(0.1))
    h.clock.advance(120)
    h.pipe.end()
    await settle()

    expect(h.sidecar.insertions).toHaveLength(0)
    expect(h.rows[0]).toMatchObject({ outcome: 'discarded', reason: 'too-short' })
    expect(h.states.at(-1)?.phase).toBe('idle')
    h.pipe.dispose()
  })

  it('discards silence rather than transcribing room tone', async () => {
    const h = harness()
    h.pipe.begin()
    h.pipe.pushChunk(speech(1.5, 0.0005))
    h.clock.advance(1_500)
    h.pipe.end()
    await settle()

    expect(h.rows[0]).toMatchObject({ outcome: 'discarded', reason: 'silence' })
    expect(h.sidecar.insertions).toHaveLength(0)
    h.pipe.dispose()
  })

  it('discards a transcript that cleans down to nothing', async () => {
    const h = harness({ transcript: '[BLANK_AUDIO] um uh' })
    h.pipe.begin()
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()

    expect(h.rows[0]).toMatchObject({ outcome: 'discarded', reason: 'empty-transcript' })
    expect(h.sidecar.insertions).toHaveLength(0)
    h.pipe.dispose()
  })

  it('aborts as soon as secure input is detected at key-down', async () => {
    const h = harness({ sidecar: new FakeSidecar({ accessibility: true, secureInput: true }) })
    h.pipe.begin()
    await settle()

    expect(h.states.at(-1)?.phase).toBe('blocked')
    expect(h.states.at(-1)?.notice).toMatch(/Secure input/)
    expect(h.capture.stopped).toBe(1)
    expect(h.rows[0]).toMatchObject({ outcome: 'blocked' })
    h.pipe.dispose()
  })

  it('reports an insertion failure instead of pretending it worked', async () => {
    const h = harness({
      sidecar: new FakeSidecar({ accessibility: false, insertFails: 'no-accessibility' })
    })
    h.pipe.begin()
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()

    expect(h.states.at(-1)?.phase).toBe('error')
    expect(h.states.at(-1)?.notice).toMatch(/Accessibility/)
    expect(h.rows[0]).toMatchObject({ outcome: 'failed', reason: 'no-accessibility' })
    h.pipe.dispose()
  })

  it('ignores a second key-down while already capturing', () => {
    const h = harness()
    h.pipe.begin()
    h.pipe.begin()
    expect(h.capture.started).toBe(1)
    h.pipe.dispose()
  })

  it('ignores a key-up that never had a key-down', async () => {
    const h = harness()
    h.pipe.end()
    await settle()
    expect(h.states).toHaveLength(0)
    expect(h.capture.stopped).toBe(0)
    h.pipe.dispose()
  })

  it('journals an applied utterance as undoable, with the caret it landed at', async () => {
    const h = harness()
    h.pipe.begin()
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()

    const [entry] = h.journal.recent()
    expect(entry).toMatchObject({
      status: 'applied',
      after: 'Hello from the pipeline test.',
      strategyUsed: 'ax',
      verified: true,
      undoable: true
    })
    expect(entry?.caret).toBe(29)
    expect(entry?.app?.name).toBe('TextEdit')

    const applied = h.states.find((s) => s.phase === 'applied')
    expect(applied?.lastAction).toMatchObject({ entryId: entry?.id, undoable: true })
    h.pipe.dispose()
  })

  it('journals a failed insertion too, and does not offer to undo it', async () => {
    const h = harness({
      sidecar: new FakeSidecar({ accessibility: true, insertFails: 'cgevent-post-failed' })
    })
    h.pipe.begin()
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()

    const [entry] = h.journal.recent()
    expect(entry?.status).toBe('failed')
    expect(entry?.undoable).toBe(false)
    expect(h.journal.lastUndoable()).toBeNull()
    expect(h.states.at(-1)?.phase).toBe('error')
    h.pipe.dispose()
  })

  it('records text withheld because secure input came on mid-utterance', async () => {
    const sidecar = new FakeSidecar({ accessibility: true })
    const h = harness({ sidecar })
    h.pipe.begin()
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    // Focus moves to a password field while we are transcribing.
    sidecar.secureInputState = async () => ({ active: true, pid: null })
    h.pipe.end()
    await settle()

    const [entry] = h.journal.recent()
    expect(entry?.status).toBe('cancelled')
    expect(entry?.summary).toMatch(/withheld/)
    expect(sidecar.insertions).toHaveLength(0)
    h.pipe.dispose()
  })

  it('announce() never interrupts a live utterance', async () => {
    const h = harness()
    h.pipe.begin()
    expect(h.pipe.announce('applied', 'undone')).toBe(false)
    expect(h.pipe.getState().phase).toBe('listening')

    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()

    expect(h.pipe.announce('error', 'Nothing to undo.')).toBe(true)
    expect(h.pipe.getState().notice).toBe('Nothing to undo.')
    h.pipe.dispose()
  })

  it('drops chunks that arrive outside an utterance', async () => {
    const h = harness()
    h.pipe.pushChunk(speech(1))
    h.pipe.begin()
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()
    expect(h.rows[0]?.audioSeconds).toBeCloseTo(1.2, 1)
    h.pipe.dispose()
  })
})

describe('describeInsertionReason', () => {
  it('explains what to do, not just what broke', () => {
    expect(describeInsertionReason('no-accessibility')).toMatch(/System Settings/)
    expect(describeInsertionReason('secure-input')).toMatch(/password field/)
    expect(describeInsertionReason('no-focused-element')).toMatch(/click where/)
    expect(describeInsertionReason(null)).toMatch(/Couldn’t insert/)
  })
})

/**
 * Routing (M4). The invariant under test is the one at the top of
 * dictation.ts: an utterance only reaches the edit lane when there was a live
 * selection AND the words read as an instruction. Everything else is typed,
 * exactly as it was before this milestone existed.
 */
describe('DictationPipeline — routing', () => {
  const SELECTED = 'some selected words here'

  const withSelection = (): FakeSidecar =>
    new FakeSidecar({
      accessibility: true,
      text: SELECTED,
      caret: 0,
      selectionLength: SELECTED.length
    })

  async function utterance(h: Harness): Promise<void> {
    h.pipe.begin()
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()
  }

  it('hands an instruction to the edit lane instead of the caret', async () => {
    const h = harness({
      sidecar: withSelection(),
      transcript: 'make this crisp',
      sculpt: true
    })
    await utterance(h)

    expect(h.sculpted.length).toBe(1)
    expect(h.sculpted[0]?.instruction).toBe('Make this crisp')
    expect(h.sculpted[0]?.snapshot.text).toBe(SELECTED)
    // Nothing typed, and no dictation row — the lane owns this one now.
    expect(h.sidecar.insertions).toEqual([])
    expect(h.journal.recent(10)).toEqual([])
    h.pipe.dispose()
  })

  it('types ordinary speech even with text selected', async () => {
    const h = harness({
      sidecar: withSelection(),
      transcript: 'make sure Priya signs off before Friday',
      sculpt: true
    })
    await utterance(h)

    expect(h.sculpted).toEqual([])
    expect(h.sidecar.insertions).toEqual(['Make sure Priya signs off before Friday'])
    h.pipe.dispose()
  })

  it('shows what is selected while you are still speaking', async () => {
    const h = harness({ sidecar: withSelection(), sculpt: true })
    h.pipe.begin()
    await settle()
    const listening = h.states.filter((s) => s.phase === 'listening').at(-1)
    expect(listening?.chips).toEqual([
      { kind: 'dict', id: 'selection', label: 'TextEdit — 4 words' }
    ])
    h.pipe.end()
    await settle()
    h.pipe.dispose()
  })

  it('types an instruction when nothing is selected, and explains why', async () => {
    const h = harness({ transcript: 'make this crisp', sculpt: true })
    await utterance(h)

    expect(h.sculpted).toEqual([])
    expect(h.sidecar.insertions).toEqual(['Make this crisp'])
    const applied = h.states.filter((s) => s.phase === 'applied').at(-1)
    expect(applied?.notice).toMatch(/Select the text first/)
    h.pipe.dispose()
  })

  it('is pure dictation when there is no edit lane at all', async () => {
    const h = harness({ sidecar: withSelection(), transcript: 'make this crisp' })
    await utterance(h)

    expect(h.sculpted).toEqual([])
    expect(h.sidecar.insertions).toEqual(['Make this crisp'])
    // No hint either: there is nothing to discover on a build without the lane.
    expect(h.states.filter((s) => s.phase === 'applied').at(-1)?.notice).toBeNull()
    h.pipe.dispose()
  })
})

/**
 * The invariant, as an assertion rather than a claim.
 *
 * docs/PLAN.md's routing rule is that plain dictation never waits on an engine
 * and never depends on one. An engine can be signed out, rate limited, or
 * outright broken; the loop the user relies on a hundred times a day has to
 * carry on as if none of that existed.
 */
describe('DictationPipeline — dictation does not depend on the engine', () => {
  const SELECTED = 'some selected words here'

  it('survives an edit lane that throws, and dictates again immediately after', async () => {
    const sidecar = new FakeSidecar({
      accessibility: true,
      text: SELECTED,
      caret: 0,
      selectionLength: SELECTED.length
    })
    const h = harness({ sidecar, transcript: 'make this crisp', sculpt: 'throws' })

    h.pipe.begin()
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()

    expect(h.sculpted.length).toBe(1)
    expect(h.states.at(-1)?.phase).toBe('error')
    expect(h.sidecar.insertions).toEqual([])

    // The next utterance is plain dictation into an empty field, and it works.
    h.sidecar.text = ''
    h.sidecar.caret = 0
    h.sidecar.selectionLength = 0
    h.pipe.begin()
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()

    expect(h.sidecar.insertions).toEqual(['Make this crisp'])
    h.pipe.dispose()
  })
})
