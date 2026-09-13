import { describe, expect, it, vi } from 'vitest'
import { CAPTURE_SAMPLE_RATE, type HudState } from '@shared/ipc'
import type { ContextMode } from '@shared/context'
import { FakeSidecar } from '../services/sidecar'
import { FakeAsrProvider } from '../asr/fake'
import { Bench, type BenchDraft, type DictationRow } from '../bench'
import { InsertionService, describeInsertionReason } from '../services/insertion'
import { JournalStore } from '../store/journal'
import { memoryDatabase } from '../store/journal.test-helpers'
import { DictationPipeline } from './dictation'
import type { SculptRequest } from './sculpt'
import { IntentRouter } from './intent'
import type { ClassifiedIntent, Engine } from '../engine/types'

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
  /** Every bare-send card the router asked for. */
  sends: Array<{ app: unknown; text: string; transcript: string }>
  /** Every question the router handed to the lane that writes nothing. */
  asked: Array<{ question: string; transcript: string }>
}

function harness(options: {
  sidecar?: FakeSidecar
  transcript?: string
  /** Absent = no edit lane at all, which is the M1–M3 behaviour. */
  sculpt?: boolean | 'throws'
  /** What the classifier answers. Absent = the local rules decide. */
  classifies?: ClassifiedIntent | 'offline'
  /** How much of the window Mull may read. Absent = nothing, as pre-M5a. */
  context?: ContextMode
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
  const sends: Array<{ app: unknown; text: string; transcript: string }> = []
  const asked: Array<{ question: string; transcript: string }> = []
  // A classifier that answers whatever the test says, or an engine that is
  // down so the local rules have to decide.
  const engine: Engine = {
    name: 'test',
    model: null,
    ready: async () =>
      options.classifies === 'offline' ? { kind: 'signed-out' } : { kind: 'ready' },
    classify: async () => options.classifies as ClassifiedIntent,
    transform: async () => ({ text: '' }),
    compose: async () => ({ text: '' }),
    navigate: async () => ({ verb: 'done' as const, because: 'not this test' }),
    answer: async () => ({ text: 'not this test' })
  }

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
            },
            sendOnly: async (request) => {
              sends.push(request)
            }
          }
        : undefined,
      ask: options.sculpt
        ? {
            run: async (request) => {
              asked.push({ question: request.question, transcript: request.transcript })
            }
          }
        : undefined,
        intent: options.sculpt ? new IntentRouter({ engine, now: () => clockMs }) : undefined,
      screenContext: options.context ? () => ({ mode: options.context as ContextMode }) : undefined,
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
    sculpted,
    sends,
    asked
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
 * Routing. The invariant under test is the one at the top of dictation.ts: an
 * utterance only reaches the edit lane when there was text to edit AND the
 * decision came back `edit`. These cases run the classifier `offline`, so the
 * local rules answer — which also proves the fallback works end to end.
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

  async function utterance(h: Harness, intent: 'dictate' | 'instruct' = 'instruct'): Promise<void> {
    h.pipe.begin(intent)
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()
  }

  it('hands an instruction to the edit lane instead of the caret', async () => {
    const h = harness({
      sidecar: withSelection(),
      transcript: 'make this crisp',
      sculpt: true,
      classifies: 'offline'
    })
    await utterance(h)

    expect(h.sculpted.length).toBe(1)
    expect(h.sculpted[0]?.instruction).toBe('Make this crisp')
    expect(h.sculpted[0]?.target).toMatchObject({ kind: 'selection', text: SELECTED })
    // Nothing typed, and no dictation row — the lane owns this one now.
    expect(h.sidecar.insertions).toEqual([])
    expect(h.journal.recent(10)).toEqual([])
    h.pipe.dispose()
  })

  /**
   * The invariant, in its unqualified form again (M5b).
   *
   * ⌥Space is dictation and nothing else — not "unless there is something to
   * edit", not "unless the words contain a verb from a list". Those qualifiers
   * were what typed "summarize this thread" into a Slack composer, and they are
   * gone: the key says which of the two things the user meant.
   */
  it('types on ⌥Space even with text selected and an instruction on the tongue', async () => {
    const h = harness({
      sidecar: withSelection(),
      transcript: 'make this less apologetic',
      sculpt: true,
      classifies: { kind: 'edit', target: 'selection', instruction: 'make it less apologetic' }
    })
    await utterance(h, 'dictate')

    // The classifier above would have said "edit". It was never asked.
    expect(h.sculpted).toEqual([])
    expect(h.sidecar.insertions).toEqual(['Make this less apologetic'])
    h.pipe.dispose()
  })

  it('shows what is selected while you are still speaking', async () => {
    const h = harness({ sidecar: withSelection(), sculpt: true, classifies: 'offline' })
    h.pipe.begin()
    await settle()
    const listening = h.states.filter((s) => s.phase === 'listening').at(-1)
    expect(listening?.chips).toEqual([
      { kind: 'dict', id: 'focus', label: 'TextEdit — 4 words' }
    ])
    h.pipe.end()
    await settle()
    h.pipe.dispose()
  })

  it('never consults the engine on ⌥Space, whatever the words are', async () => {
    const h = harness({ transcript: 'make this crisp', sculpt: true })
    await utterance(h, 'dictate')

    expect(h.sculpted).toEqual([])
    expect(h.sidecar.insertions).toEqual(['Make this crisp'])
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
    const h = harness({
      sidecar,
      transcript: 'make this crisp',
      sculpt: 'throws',
      classifies: 'offline'
    })

    h.pipe.begin('instruct')
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

/**
 * The whole-field case (M4.1) — the Slack composer that started this.
 *
 * Nothing is highlighted, but the field in front of the caret holds the text
 * the user is talking about. M4 typed the question into the box; this is the
 * test that says it must not.
 */
describe('DictationPipeline — an instruction about the field in front of you', () => {
  const COMPOSER = 'I will get back to you today, sorry I was slow.'

  const withComposer = (): FakeSidecar =>
    new FakeSidecar({
      accessibility: true,
      text: COMPOSER,
      caret: COMPOSER.length,
      selectionLength: 0
    })

  async function utterance(h: Harness, intent: 'dictate' | 'instruct' = 'instruct'): Promise<void> {
    h.pipe.begin(intent)
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()
  }

  it('edits the whole field instead of typing the question', async () => {
    const h = harness({
      sidecar: withComposer(),
      transcript: 'Can you make my last message less apologetic?',
      sculpt: true,
      classifies: {
        kind: 'edit',
        target: 'document',
        instruction: 'make it less apologetic'
      }
    })
    await utterance(h)

    expect(h.sculpted.length).toBe(1)
    expect(h.sculpted[0]?.instruction).toBe('make it less apologetic')
    expect(h.sculpted[0]?.target).toMatchObject({ kind: 'document', text: COMPOSER })
    // The words themselves never reach the composer.
    expect(h.sidecar.insertions).toEqual([])
    h.pipe.dispose()
  })

  it('still types when the model says these are just words', async () => {
    const h = harness({
      sidecar: withComposer(),
      transcript: 'and I will send the deck tonight',
      sculpt: true,
      classifies: { kind: 'dictate' }
    })
    await utterance(h)

    expect(h.sculpted).toEqual([])
    expect(h.sidecar.insertions).toEqual(['And I will send the deck tonight'])
    h.pipe.dispose()
  })

  it('names the field in the chip while you are still speaking', async () => {
    const h = harness({ sidecar: withComposer(), sculpt: true, classifies: { kind: 'dictate' } })
    h.pipe.begin()
    await settle()

    expect(h.states.filter((s) => s.phase === 'listening').at(-1)?.chips).toEqual([
      { kind: 'dict', id: 'focus', label: 'TextEdit — this field' }
    ])
    h.pipe.end()
    await settle()
    h.pipe.dispose()
  })

  it('types the words and says why when the field is too long to rewrite whole', async () => {
    // A truncated read is a window onto something longer; rewriting it would
    // silently discard everything outside the window.
    const long = 'x'.repeat(40_000)
    const h = harness({
      sidecar: new FakeSidecar({
        accessibility: true,
        text: long,
        caret: long.length,
        selectionLength: 0
      }),
      transcript: 'tighten this up',
      sculpt: true,
      classifies: { kind: 'edit', target: 'document', instruction: 'tighten this up' }
    })
    await utterance(h)

    expect(h.sculpted).toEqual([])
    expect(h.sidecar.insertions).toEqual(['Tighten this up'])
    expect(h.states.filter((s) => s.phase === 'applied').at(-1)?.notice).toMatch(/too long/i)
    h.pipe.dispose()
  })
})

/**
 * The second report (M4.2): text selected in a *sent* Slack message while the
 * empty composer holds focus.
 *
 * M4.1 saw nothing selected and an empty field, took the fast path, and typed
 * the user's question into the box. The selection was always there — just not
 * in the focused element, which is the only place Mull was looking.
 */
describe('DictationPipeline — a selection that is not in the focused element', () => {
  const SENT = 'I am so sorry to bother you again about the terms doc.'

  async function utterance(h: Harness, intent: 'dictate' | 'instruct' = 'instruct'): Promise<void> {
    h.pipe.begin(intent)
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()
  }

  it('edits read-only text into the caret instead of typing the question', async () => {
    const h = harness({
      sidecar: new FakeSidecar({
        accessibility: true,
        text: SENT,
        caret: 0,
        selectionLength: SENT.length,
        // Found by walking the app's tree, and not writable — a sent message.
        selectionSource: 'tree',
        selectionEditable: false,
        // …and the caret is somewhere else entirely, which is the whole shape
        // of the bug: focus on the composer, selection in the transcript above.
        noFocus: true
      }),
      transcript: 'Can you please make it less apologetic?',
      sculpt: true,
      classifies: { kind: 'edit', target: 'selection', instruction: 'make it less apologetic' }
    })
    await utterance(h)

    expect(h.sculpted.length).toBe(1)
    expect(h.sculpted[0]?.target).toMatchObject({
      kind: 'reference',
      text: SENT,
      keystrokesSafe: false
    })
    // The question itself never reaches the composer.
    expect(h.sidecar.insertions).toEqual([])
    h.pipe.dispose()
  })

  it('replaces in place when the selection is where the caret is', async () => {
    const h = harness({
      sidecar: new FakeSidecar({
        accessibility: true,
        text: SENT,
        caret: 0,
        selectionLength: SENT.length,
        selectionSource: 'focused'
      }),
      transcript: 'make this crisp',
      sculpt: true,
      classifies: { kind: 'edit', target: 'selection', instruction: 'make this crisp' }
    })
    await utterance(h)

    expect(h.sculpted[0]?.target).toMatchObject({ kind: 'selection', keystrokesSafe: true })
    h.pipe.dispose()
  })

  it('asks the app with ⌘C when accessibility finds nothing', async () => {
    // The last resort, and only for words that already look like an
    // instruction — it presses a key in someone else's app.
    const h = harness({
      sidecar: new FakeSidecar({
        accessibility: true,
        text: '',
        caret: 0,
        selectionLength: 0,
        copyable: SENT
      }),
      transcript: 'make it less apologetic',
      sculpt: true,
      classifies: { kind: 'edit', target: 'selection', instruction: 'make it less apologetic' }
    })
    await utterance(h)

    expect(h.sculpted[0]?.target).toMatchObject({ kind: 'reference', text: SENT })
    h.pipe.dispose()
  })

  it('does not press ⌘C for ordinary speech', async () => {
    const h = harness({
      sidecar: new FakeSidecar({
        accessibility: true,
        text: '',
        caret: 0,
        selectionLength: 0,
        copyable: SENT
      }),
      transcript: 'and I will send the deck tonight',
      sculpt: true,
      classifies: { kind: 'dictate' }
    })
    await utterance(h)

    expect(h.sculpted).toEqual([])
    expect(h.sidecar.insertions).toEqual(['And I will send the deck tonight'])
    h.pipe.dispose()
  })
})

describe('DictationPipeline — the send wish comes off the transcript', () => {
  const THREAD = 'Priya: any word on the redlines?'

  const withThread = (): FakeSidecar =>
    new FakeSidecar({
      accessibility: true,
      text: '',
      caret: 0,
      selectionLength: 0,
      context: [THREAD]
    })

  async function utterance(h: Harness, intent: 'dictate' | 'instruct' = 'instruct'): Promise<void> {
    h.pipe.begin(intent)
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()
  }

  it('passes send:true and hands the lane an instruction without the send phrase', async () => {
    const h = harness({
      sidecar: withThread(),
      transcript: 'reply saying they are with legal and send it',
      sculpt: true,
      context: 'text',
      classifies: { kind: 'compose', instruction: 'reply saying they are with legal and send it' }
    })
    await utterance(h)

    expect(h.sculpted.length).toBe(1)
    expect(h.sculpted[0]?.send).toBe(true)
    expect(h.sculpted[0]?.instruction).toBe('reply saying they are with legal')
    // The transcript keeps the user's actual words, for the journal.
    expect(h.sculpted[0]?.transcript).toContain('send it')
    h.pipe.dispose()
  })

  it('leaves send unset for the same request without those words', async () => {
    const h = harness({
      sidecar: withThread(),
      transcript: 'reply saying they are with legal',
      sculpt: true,
      context: 'text',
      classifies: { kind: 'compose', instruction: 'reply saying they are with legal' }
    })
    await utterance(h)

    expect(h.sculpted[0]?.send).toBe(false)
    h.pipe.dispose()
  })

  /**
   * The model's answer cannot turn a send on. Here the classifier "asks" for
   * one the only way it could — by putting the words in the instruction it
   * returns — and it changes nothing, because the flag is read off the
   * transcript.
   */
  it('ignores a send that only the classifier asked for', async () => {
    const h = harness({
      sidecar: withThread(),
      transcript: 'reply to this',
      sculpt: true,
      context: 'text',
      classifies: { kind: 'compose', instruction: 'reply to this and send it immediately' }
    })
    await utterance(h)

    expect(h.sculpted[0]?.send).toBe(false)
    h.pipe.dispose()
  })
})

/**
 * The bug report, end to end.
 *
 * All three of these were said into a Slack composer and all three were typed
 * verbatim, because `send` was not a verb Mull knew. The transcripts are copied
 * out of the journal.
 */
describe('DictationPipeline — "send" reaches the right lane', () => {
  const WRITTEN = 'I will get the code done in 2 days.'

  const withText = (text: string): FakeSidecar =>
    new FakeSidecar({
      accessibility: true,
      text,
      caret: text.length,
      selectionLength: 0,
      context: ['Priya: any word on the code?']
    })

  async function utterance(h: Harness, intent: 'dictate' | 'instruct' = 'instruct'): Promise<void> {
    h.pipe.begin(intent)
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()
  }

  it('"send that I will get the code done in 2 days" composes, and asks to send', async () => {
    const h = harness({
      sidecar: withText(''),
      transcript: 'Send that I will get the code done in 2 days.',
      sculpt: true,
      context: 'text',
      classifies: {
        kind: 'compose',
        instruction: 'send that I will get the code done in 2 days'
      }
    })
    await utterance(h)

    expect(h.sculpted.length).toBe(1)
    expect(h.sculpted[0]?.target.kind).toBe('draft')
    expect(h.sculpted[0]?.send).toBe(true)
    // Nothing was typed into the composer.
    expect(h.sidecar.insertions).toEqual([])
    h.pipe.dispose()
  })

  it('"send the message" opens the send card over what is already written', async () => {
    const h = harness({
      sidecar: withText(WRITTEN),
      transcript: 'Send the message',
      sculpt: true,
      context: 'text'
    })
    await utterance(h)

    expect(h.sends.length).toBe(1)
    expect(h.sends[0]).toMatchObject({ text: WRITTEN, transcript: 'Send the message' })
    expect(h.sculpted).toEqual([])
    expect(h.sidecar.insertions).toEqual([])
    h.pipe.dispose()
  })

  /**
   * …and it costs nothing. A bare send never reaches the classifier, which is
   * the difference between an instant keystroke and one that arrives after the
   * user has already pressed the button themselves.
   */
  it('answers a bare send without asking the model', async () => {
    const h = harness({
      sidecar: withText(WRITTEN),
      transcript: 'send it',
      sculpt: true,
      context: 'text',
      // A classifier that would hang if it were ever consulted.
      classifies: 'offline'
    })
    await utterance(h)

    expect(h.sends.length).toBe(1)
    h.pipe.dispose()
  })

  it('types "send the message" when the box is empty — those words were a sentence', async () => {
    const h = harness({
      sidecar: withText(''),
      transcript: 'Send the message',
      sculpt: true,
      context: 'text',
      classifies: { kind: 'dictate' }
    })
    await utterance(h)

    expect(h.sends).toEqual([])
    expect(h.sidecar.insertions).toEqual(['Send the message'])
    h.pipe.dispose()
  })
})

describe('DictationPipeline — the two keys', () => {
  const withThread = (text: string): FakeSidecar =>
    new FakeSidecar({
      accessibility: true,
      text,
      caret: text.length,
      selectionLength: 0,
      context: ['Priya: any word on the redlines?']
    })

  /**
   * The six sentences that were typed into a Slack composer before M5b, because
   * no verb table listed them. None of them is listed anywhere now — the key
   * says they were instructions, and the model decides what kind.
   */
  const ONCE_TYPED = [
    'summarize this thread',
    'catch me up on this',
    'what did they decide about the redlines',
    'turn this thread into bullet points',
    'translate this to French',
    'send that I will get the code done in 2 days'
  ]

  for (const transcript of ONCE_TYPED) {
    it(`asks about “${transcript}” on Fn`, async () => {
      const h = harness({
        sidecar: withThread(''),
        transcript,
        sculpt: true,
        context: 'text',
        classifies: { kind: 'compose', instruction: transcript }
      })
      h.pipe.begin('instruct')
      h.pipe.pushChunk(speech(1.2))
      h.clock.advance(1_200)
      h.pipe.end()
      await settle()

      expect(h.sculpted.length).toBe(1)
      expect(h.sidecar.insertions).toEqual([])
      h.pipe.dispose()
    })

    it(`types “${transcript}” on ⌥Space`, async () => {
      const h = harness({
        sidecar: withThread(''),
        transcript,
        sculpt: true,
        context: 'text',
        classifies: { kind: 'compose', instruction: transcript }
      })
      h.pipe.begin('dictate')
      h.pipe.pushChunk(speech(1.2))
      h.clock.advance(1_200)
      h.pipe.end()
      await settle()

      expect(h.sculpted).toEqual([])
      expect(h.sidecar.insertions.length).toBe(1)
      h.pipe.dispose()
    })
  }

  /**
   * Announced while the key is still down. Fn means the words are about to be
   * sent somewhere and acted on, and the moment to learn that is before letting
   * go — it also makes a mis-press visible, since Fn has a lot of neighbours.
   */
  it('shows a chip while Fn is held, and none while ⌥Space is', async () => {
    const asking = harness({ sidecar: withThread(''), sculpt: true, context: 'text' })
    asking.pipe.begin('instruct')
    await settle()
    expect(
      asking.states.flatMap((s) => s.chips ?? []).some((chip) => chip.id === 'ask')
    ).toBe(true)
    asking.pipe.dispose()

    const plain = harness({ sidecar: withThread(''), sculpt: true, context: 'text' })
    plain.pipe.begin('dictate')
    await settle()
    expect(plain.states.flatMap((s) => s.chips ?? []).some((chip) => chip.id === 'ask')).toBe(false)
    plain.pipe.dispose()
  })

  /**
   * The privacy claim, tested rather than asserted in a comment.
   *
   * ⌥Space never reaches an engine, so a window transcript taken during one of
   * those holds has no consumer — it would be harvested, photographed, held in
   * memory and dropped. For a while it was, on every single press, which is a
   * screenshot of the user's screen taken for nothing and recorded nowhere.
   */
  it('reads nothing at all while ⌥Space is held, not even the text', async () => {
    const plain = harness({ sidecar: withThread('hello'), sculpt: true, context: 'text+screen' })
    plain.pipe.begin('dictate')
    await settle()
    expect(plain.sidecar.calls.some((call) => call.method === 'windowContext')).toBe(false)
    plain.pipe.dispose()
  })

  it('reads the window when Fn is held, which is the key that asks', async () => {
    const asking = harness({ sidecar: withThread('hello'), sculpt: true, context: 'text+screen' })
    asking.pipe.begin('instruct')
    await settle()
    expect(asking.sidecar.calls.some((call) => call.method === 'windowContext')).toBe(true)
    asking.pipe.dispose()
  })

  /**
   * The working line is set explicitly at each step, so any path that forgets
   * one would put the panel back to a bare, unchanging THINKING — which is
   * indistinguishable from a hang and is the exact complaint it was built to
   * answer. Entering a working phase guarantees a line whether or not anybody
   * remembered.
   */
  it('never shows a working phase without saying what it is working on', async () => {
    const h = harness({ transcript: 'make this shorter' })
    h.pipe.begin('instruct')
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()

    const working = h.states.filter((s) => s.phase === 'thinking' || s.phase === 'inserting')
    expect(working.length).toBeGreaterThan(0)
    for (const state of working) {
      expect(state.stage).toBeTruthy()
      expect(state.stageAt).not.toBeNull()
    }
  })

  it('clears the line on the way out, so it cannot outlive the work', async () => {
    const h = harness({ transcript: 'hello there' })
    h.pipe.begin('dictate')
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()
    h.clock.advance(50)
    await settle()

    const last = h.states[h.states.length - 1]
    expect(last?.phase).not.toBe('thinking')
    expect(last?.stage).toBeNull()
  })
})

/**
 * A question is not a request for text.
 *
 * "Summarize all my tasks which I need to complete", spoken over a page of
 * notes, used to reach the edit lane — which produced a diff card with an Apply
 * button offering to write the summary into those same notes. ⏎ means Apply on
 * every other card, so the keystroke that dismisses one would have pasted it in.
 *
 * The route now ends somewhere that has no target and nothing to write with,
 * and these two assertions are the whole guarantee: the ask lane got it, and
 * neither the edit lane nor the keyboard did.
 */
describe('DictationPipeline — asking, which writes nothing', () => {
  const withNotes = (): FakeSidecar =>
    new FakeSidecar({
      accessibility: true,
      text: 'Tasks:\n- Agent with ACT (later)',
      caret: 0,
      selectionLength: 0,
      context: ['Tasks:', '- Agent with ACT (later)', '- Convert rag function to mcp']
    })

  async function utterance(h: Harness): Promise<void> {
    h.pipe.begin('instruct')
    h.pipe.pushChunk(speech(1.2))
    h.clock.advance(1_200)
    h.pipe.end()
    await settle()
  }

  it('hands the question to the lane with no target', async () => {
    const h = harness({
      sidecar: withNotes(),
      transcript: 'summarize all my tasks which I need to complete',
      sculpt: true,
      context: 'text',
      classifies: { kind: 'ask', question: 'What are all the tasks I need to complete?' }
    })
    await utterance(h)

    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]?.question).toBe('What are all the tasks I need to complete?')
    // The user's own words survive for the journal row (sentence-cased by the
    // cleanup pass, as every transcript is).
    expect(h.asked[0]?.transcript).toContain('all my tasks which I need to complete')
    h.pipe.dispose()
  })

  it('types nothing and offers no edit', async () => {
    const h = harness({
      sidecar: withNotes(),
      transcript: 'summarize all my tasks which I need to complete',
      sculpt: true,
      context: 'text',
      classifies: { kind: 'ask', question: 'What are all the tasks I need to complete?' }
    })
    await utterance(h)

    expect(h.sculpted).toEqual([])
    expect(h.sidecar.insertions).toEqual([])
    h.pipe.dispose()
  })
})
