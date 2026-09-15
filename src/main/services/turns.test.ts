import { describe, expect, it } from 'vitest'
import { TurnMemory } from './turns'

/**
 * The memory that makes "and what about Priya" mean something.
 *
 * Every test here is really about one of the two failure modes, and they point
 * opposite ways: remembering too little makes a follow-up unanswerable, and
 * remembering too much makes an ordinary sentence look like one.
 */

const NOW = 1_700_000_000_000

function memory(options: { max?: number; ttlMs?: number } = {}): {
  turns: TurnMemory
  tick: (ms: number) => void
} {
  let now = NOW
  return {
    turns: new TurnMemory({ now: () => now, ...options }),
    tick: (ms: number) => {
      now += ms
    }
  }
}

describe('remembering', () => {
  it('keeps what was said, where, and what came back', () => {
    const m = memory()
    m.turns.open({ said: 'what did Anil say about the terms doc', route: 'navigate', app: 'Slack' })
    m.turns.close('The redlines are with legal; Anil expects them Thursday.')

    expect(m.turns.recent()).toEqual([
      {
        said: 'what did Anil say about the terms doc',
        route: 'navigate',
        app: 'Slack',
        outcome: 'The redlines are with legal; Anil expects them Thursday.',
        at: NOW
      }
    ])
  })

  /**
   * Opened on routing, not on completion. A run can take half a minute, and the
   * user may well say the next thing before it lands — a memory that only held
   * finished work would be missing exactly the turn they are following up on.
   */
  it('remembers a turn that has not finished yet, and says so', () => {
    const m = memory()
    m.turns.open({ said: 'what did Anil say', route: 'navigate', app: 'Slack' })

    expect(m.turns.recent()[0]?.outcome).toBeNull()
  })

  /**
   * The user speaks again while the first run is still going. Without this the
   * run's answer, arriving late, would be filed against the sentence that
   * interrupted it.
   */
  it('gives a late answer to the turn that was waiting for it', () => {
    const m = memory()
    m.turns.open({ said: 'what did Anil say', route: 'navigate', app: 'Slack' })
    m.turns.open({ said: 'never mind', route: 'dictate', app: 'Slack' })
    m.turns.close('typed: never mind')
    m.turns.close('The redlines are with legal.')

    const [first, second] = m.turns.recent()
    expect(first?.outcome).toBe('The redlines are with legal.')
    expect(second?.outcome).toBe('typed: never mind')
  })

  it('ignores an empty outcome rather than filing a blank', () => {
    const m = memory()
    m.turns.open({ said: 'hello', route: 'dictate', app: null })
    m.turns.close(null)
    m.turns.close('')
    expect(m.turns.recent()[0]?.outcome).toBeNull()
  })
})

describe('the bounds', () => {
  it('keeps only the last few', () => {
    const m = memory({ max: 2 })
    for (const said of ['one', 'two', 'three']) {
      m.turns.open({ said, route: 'dictate', app: null })
    }
    expect(m.turns.recent().map((turn) => turn.said)).toEqual(['two', 'three'])
  })

  /**
   * A turn from this morning is not context, it is noise — and the wrong kind:
   * it makes an unrelated sentence look like a follow-up, which sends somebody's
   * plain message off on an expedition instead of typing it.
   */
  it('forgets anything older than the window', () => {
    const m = memory({ ttlMs: 60_000 })
    m.turns.open({ said: 'what did Anil say', route: 'navigate', app: 'Slack' })
    m.tick(59_000)
    expect(m.turns.recent()).toHaveLength(1)
    m.tick(2_000)
    expect(m.turns.recent()).toEqual([])
  })

  // Everything here leaves the Mac on the next instruction, and the outcome in
  // particular is model output about somebody's private window.
  it('clamps what it keeps, and tidies the whitespace', () => {
    const m = memory()
    m.turns.open({ said: `  a  ${'x'.repeat(400)}  `, route: 'ask', app: null })
    m.turns.close('y'.repeat(400))

    const turn = m.turns.recent()[0]
    expect(turn?.said.length).toBeLessThanOrEqual(160)
    expect(turn?.said.startsWith('a x')).toBe(true)
    expect(turn?.outcome?.length).toBeLessThanOrEqual(240)
    expect(turn?.outcome?.endsWith('…')).toBe(true)
  })

  it('can be told to forget everything', () => {
    const m = memory()
    m.turns.open({ said: 'something private', route: 'dictate', app: null })
    m.turns.clear()
    expect(m.turns.recent()).toEqual([])
  })
})
