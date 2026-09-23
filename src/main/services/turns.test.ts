import { describe, expect, it } from 'vitest'
import { compact, describeSteps, TurnMemory, type RecentTurn } from './turns'

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

describe('what a run did, added after the fact', () => {
  /**
   * The outcome and the route arrive from opposite ends — a run that ended with
   * nothing to say still walked somewhere worth remembering — so neither may
   * depend on the other having been supplied.
   */
  it('files the goal, the route and the ending against the open turn', () => {
    const m = memory()
    m.turns.open({ said: 'and what about Priya', route: 'navigate', app: 'Slack' })
    m.turns.close('Priya has not replied since Tuesday.', {
      goal: 'open the conversation with Priya and read the recent messages',
      did: 'go to Slack · find “Priya” · look text',
      ended: 'done'
    })

    expect(m.turns.recent()[0]).toMatchObject({
      goal: 'open the conversation with Priya and read the recent messages',
      did: 'go to Slack · find “Priya” · look text',
      ended: 'done',
      outcome: 'Priya has not replied since Tuesday.'
    })
  })

  it('records a run that ended with nothing to say', () => {
    const m = memory()
    m.turns.open({ said: 'open the calendar', route: 'navigate', app: 'Slack' })
    m.turns.close(null, { did: 'apps · go to Calendar', ended: 'turns' })

    expect(m.turns.recent()[0]).toMatchObject({ did: 'apps · go to Calendar', ended: 'turns' })
    expect(m.turns.recent()[0]?.outcome).toBeNull()
  })

  it('takes the expanded goal at open, when the classifier wrote one', () => {
    const m = memory()
    m.turns.open({
      said: 'and what about Priya',
      route: 'navigate',
      app: 'Slack',
      goal: 'open the conversation with Priya and find what she said about the terms doc'
    })
    expect(m.turns.recent()[0]?.goal).toContain('terms doc')
  })

  it('clamps the late fields too', () => {
    const m = memory()
    m.turns.open({ said: 'go', route: 'navigate', app: null })
    m.turns.close(null, { goal: 'g'.repeat(400), did: 'd'.repeat(400) })

    const turn = m.turns.recent()[0]
    expect(turn?.goal?.length).toBeLessThanOrEqual(160)
    expect(turn?.did?.length).toBeLessThanOrEqual(160)
  })
})

describe('fitting the block into a prompt', () => {
  const render = (turn: { said: string }): string => `said “${turn.said}”`
  const turns = (count: number, size = 10): RecentTurn[] =>
    Array.from({ length: count }, (_, i) => ({
      said: `${i}`.repeat(size),
      route: 'dictate',
      app: i % 2 === 0 ? 'Slack' : 'Chrome',
      outcome: null,
      at: NOW
    }))

  it('keeps everything when everything fits', () => {
    const { lines, earlier } = compact(turns(3), render, 1_000)
    expect(lines).toHaveLength(3)
    expect(earlier).toBeNull()
  })

  /** Newest first: the newest turn is the one a follow-up is following. */
  it('drops the oldest when the block is too long, and says how many', () => {
    const { lines, earlier } = compact(turns(6, 100), render, 400)
    expect(lines.length).toBeLessThan(6)
    expect(lines[lines.length - 1]).toContain('5'.repeat(100))
    expect(earlier).toMatch(/^earlier: \d more turns in Slack and Chrome$/u)
  })

  /**
   * One turn that is on its own too big for the budget is still shown. A block
   * with nothing in it is worse than a block that overran, and the per-field
   * clamps already bound how far it can overrun.
   */
  it('always keeps the newest turn, however long it is', () => {
    const { lines, earlier } = compact(turns(2, 500), render, 100)
    expect(lines).toHaveLength(1)
    expect(earlier).toBe('earlier: 1 more turn in Slack')
  })

  it('has nothing to say about nothing', () => {
    expect(compact([], render, 100)).toEqual({ lines: [], earlier: null })
  })
})

describe('what a run did, in one clause', () => {
  const step = (verb: string, object: string, state = 'done'): { verb: string; object: string; state: string } => ({
    verb,
    object,
    state
  })

  it('joins the acts in the lane’s own verbs', () => {
    expect(describeSteps([step('go to', 'Slack'), step('find', '“Priya”')])).toBe(
      'go to Slack · find “Priya”'
    )
  })

  /** The same list and opposite advice, depending on which press worked. */
  it('marks the ones that failed', () => {
    expect(describeSteps([step('press', '“Search”', 'failed')])).toBe('press “Search” ✗')
  })

  it('keeps the tail and counts the rest', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => step('look', name))
    expect(describeSteps(many, 2)).toBe('4 more · look e · look f')
  })

  it('leaves out an act that is still running, and says nothing about nothing', () => {
    expect(describeSteps([step('look', 'text', 'running')])).toBeNull()
    expect(describeSteps([])).toBeNull()
  })
})
