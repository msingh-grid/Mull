import { describe, expect, it } from 'vitest'
import { kb, Trace } from './trace'

function recorder(): { lines: string[]; log: (l: string, m: string) => void } {
  const lines: string[] = []
  return { lines, log: (_level, message) => lines.push(message) }
}

/**
 * A clock the test moves on purpose.
 *
 * The first draft of these tests fed `now` a list of values and relied on
 * counting how many times each method happened to call it — which encodes an
 * implementation detail into every assertion and was wrong the first time it
 * ran. Advance it explicitly instead.
 */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    }
  }
}

describe('Trace', () => {
  it('stamps every step with the time since the key went down', () => {
    const { lines, log } = recorder()
    const time = clock()
    const trace = new Trace({ log, now: time.now })
    trace.step('hold.begin', { key: 'Fn' })
    time.advance(505)
    trace.step('focus.read', { app: 'Slack' })

    expect(lines[0]).toContain('+0ms')
    expect(lines[0]).toContain('hold.begin')
    // Cumulative from the start, not a delta from the previous line: this is
    // the number the user actually feels.
    expect(lines[1]).toContain('+505ms')
  })

  it('puts every step of one utterance under the same id', () => {
    const { lines, log } = recorder()
    const trace = new Trace({ log, now: () => 0 })
    trace.step('a')
    trace.step('b')
    const id = lines[0]?.match(/⟨(u\d+)⟩/)?.[1]
    expect(id).toBeTruthy()
    expect(lines[1]).toContain(`⟨${id}⟩`)
  })

  it('gives the next utterance a different one', () => {
    const { lines, log } = recorder()
    new Trace({ log, now: () => 0 }).step('a')
    new Trace({ log, now: () => 0 }).step('a')
    expect(lines[0]).not.toBe(lines[1])
  })

  /**
   * The rule `bench.jsonl` already follows. Other people's writing is counted
   * and never quoted; the place to read what Mull saw is the journal's "What
   * Mull saw", which the user opens on purpose.
   */
  it('renders fields on one line and drops the empty ones', () => {
    const { lines, log } = recorder()
    new Trace({ log, now: () => 0 }).step('context.read', {
      blocks: 74,
      chars: 2392,
      truncated: undefined,
      image: null,
      harvestMs: 42
    })
    expect(lines[0]).toContain('blocks=74 chars=2392 harvestMs=42')
    expect(lines[0]).not.toContain('truncated')
    expect(lines[0]).not.toContain('image')
    expect(lines[0]?.split('\n')).toHaveLength(1)
  })

  it('clamps the one free-text field rather than pasting a paragraph', () => {
    const { lines, log } = recorder()
    new Trace({ log, now: () => 0 }).step('asr.done', { said: 'x'.repeat(300) })
    expect(lines[0]?.length).toBeLessThan(200)
    expect(lines[0]).toContain('…')
  })

  /**
   * Quoted only where quoting earns its place. `JSON.stringify` would turn a
   * step that already holds a quoted name into what="press 37 \"Anil\"", and
   * these lines are read by a person rather than parsed.
   */
  it('quotes what needs it and leaves the rest bare', () => {
    const { lines, log } = recorder()
    const trace = new Trace({ log, now: () => 0 })
    trace.step('a', { said: '' })
    trace.step('b', { kind: 'navigate' })
    trace.step('c', { what: 'press 37 "Anil Turaga"' })
    expect(lines[0]).toContain('said=""')
    expect(lines[1]).toContain('kind=navigate')
    expect(lines[2]).toContain('what="press 37 ’Anil Turaga’"')
    expect(lines[2]).not.toContain('\\')
  })

  it('reports a failure at warn, with the reason attached', () => {
    const levels: string[] = []
    const lines: string[] = []
    const trace = new Trace({
      log: (level, message) => {
        levels.push(level)
        lines.push(message)
      },
      now: () => 0
    })
    trace.fail('insert.failed', { app: 'Slack' }, new Error('secure-input'))
    expect(levels[0]).toBe('warn')
    expect(lines[0]).toContain('secure-input')
  })

  it('times one operation without disturbing the utterance clock', () => {
    const { lines, log } = recorder()
    const time = clock()
    const trace = new Trace({ log, now: time.now })
    time.advance(100)
    const done = trace.mark()
    time.advance(540)
    trace.step('scan', { ms: done() })
    // The operation took 540ms; the utterance is 640ms old. Both, on one line.
    expect(lines[0]).toContain('ms=540')
    expect(lines[0]).toContain('+640ms')
  })

  /**
   * A plan outlives its utterance: the user reads the card and presses Run
   * whenever they like. Measuring the first press from the key-down would
   * produce a column of numbers about how long somebody spent deciding.
   */
  it('forks to restart the clock while keeping the id', () => {
    const { lines, log } = recorder()
    const time = clock()
    const parent = new Trace({ log, now: time.now })
    parent.step('plan.propose')
    // A minute and a half of the user reading the card before pressing Run.
    time.advance(90_000)
    const child = parent.fork()
    child.step('plan.run')

    const id = lines[0]?.match(/⟨(u\d+)⟩/)?.[1]
    expect(lines[1]).toContain(`⟨${id}⟩`)
    expect(lines[1]).toContain('+0ms')
  })
})

describe('kb', () => {
  it('reads as a size, and says nothing when there is nothing', () => {
    expect(kb(187_392)).toBe('183KB')
    expect(kb(null)).toBeUndefined()
    expect(kb(undefined)).toBeUndefined()
  })
})
