import { describe, expect, it, vi } from 'vitest'
import { CAPTURE_SAMPLE_RATE, type HudState } from '@shared/ipc'
import { FakeSidecar } from '../services/sidecar'
import { FakeAsrProvider } from '../asr/fake'
import { Bench, type BenchRow } from '../bench'
import { DictationPipeline, describeInsertFailure } from './dictation'

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
  states: HudState[]
  rows: Array<Omit<BenchRow, 'at'>>
  capture: { started: number; stopped: number }
  clock: { advance: (ms: number) => void }
}

function harness(options: {
  sidecar?: FakeSidecar
  transcript?: string
} = {}): Harness {
  const sidecar = options.sidecar ?? new FakeSidecar({ accessibility: true })
  const states: HudState[] = []
  const rows: Array<Omit<BenchRow, 'at'>> = []
  const capture = { started: 0, stopped: 0 }

  let clockMs = 1_000
  const bench = new Bench('/dev/null')
  vi.spyOn(bench, 'record').mockImplementation((row) => {
    rows.push(row)
  })

  const pipe = new DictationPipeline(
    {
      sidecar,
      asr: new FakeAsrProvider(options.transcript ?? 'um, hello from the pipeline test.', 0),
      bench,
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
    states,
    rows,
    capture,
    clock: { advance: (ms) => { clockMs += ms } }
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

describe('describeInsertFailure', () => {
  it('explains what to do, not just what broke', () => {
    expect(describeInsertFailure('no-accessibility')).toMatch(/System Settings/)
    expect(describeInsertFailure('secure-input')).toMatch(/password field/)
    expect(describeInsertFailure('no-focused-element')).toMatch(/click where/)
    expect(describeInsertFailure(null)).toMatch(/Couldn’t insert/)
  })
})
