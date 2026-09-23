import { describe, expect, it } from 'vitest'
import { TurnMemory, type RecentTurn } from '../services/turns'
import { memoryDatabase } from './journal.test-helpers'
import { TurnStore } from './turns'

/**
 * The disk under the memory.
 *
 * Two things are being checked and only one of them is the round trip. The
 * other is the TTL: a row that outlived its window must not come back, because
 * a stale turn read as a follow-up is the failure this whole feature is one
 * mistake away from.
 */

const NOW = 1_700_000_000_000
const TTL = 30 * 60_000

function store(now: () => number = () => NOW): TurnStore {
  return new TurnStore(memoryDatabase(), { now, ttlMs: TTL })
}

const turn = (said: string, at = NOW): RecentTurn => ({
  said,
  route: 'navigate',
  app: 'Slack',
  outcome: 'the redlines are with legal',
  at
})

describe('keeping the turns between launches', () => {
  it('writes what it was given and reads it back unchanged', () => {
    const disk = store()
    const written: RecentTurn[] = [
      { ...turn('what did Anil say'), goal: 'open the Anil thread and read it', did: 'go to Slack · find “Anil”', ended: 'done' },
      { ...turn('and what about Priya'), outcome: null }
    ]
    disk.save(written)

    expect(disk.load()).toEqual(written)
  })

  /** The three late fields are absent, not null, when nothing filled them in. */
  it('does not invent fields a turn never had', () => {
    const disk = store()
    disk.save([turn('hello')])
    expect(disk.load()[0]).not.toHaveProperty('goal')
    expect(disk.load()[0]).not.toHaveProperty('did')
    expect(disk.load()[0]).not.toHaveProperty('ended')
  })

  it('replaces rather than appends, so the disk is whatever the memory holds', () => {
    const disk = store()
    disk.save([turn('one'), turn('two')])
    disk.save([turn('three')])
    expect(disk.load().map((row) => row.said)).toEqual(['three'])
  })

  /**
   * The point of the TTL now that this survives a quit: an expired turn is
   * dropped on the way *in*, so nothing downstream ever has the chance to read
   * it as context.
   */
  it('refuses to hand back a turn older than the window', () => {
    let now = NOW
    const disk = store(() => now)
    disk.save([turn('this morning', NOW - TTL - 1), turn('just now', NOW - 1_000)])

    expect(disk.load().map((row) => row.said)).toEqual(['just now'])
    now += TTL
    expect(disk.load()).toEqual([])
  })

  it('can be emptied', () => {
    const disk = store()
    disk.save([turn('something private')])
    disk.clear()
    expect(disk.load()).toEqual([])
  })

  /** A memory that cannot be read is an empty memory, never an exception. */
  it('survives a database that has gone wrong', () => {
    const broken = {
      exec: (): void => {},
      prepare: (): never => {
        throw new Error('disk is gone')
      },
      close: (): void => {}
    }
    const disk = new TurnStore(broken, { ttlMs: TTL })
    expect(() => disk.save([turn('one')])).not.toThrow()
    expect(disk.load()).toEqual([])
    expect(() => disk.clear()).not.toThrow()
  })
})

describe('the memory, with a disk under it', () => {
  it('comes back with what the last launch was talking about', () => {
    const db = memoryDatabase()
    const first = new TurnMemory({ now: () => NOW, persistence: new TurnStore(db, { now: () => NOW, ttlMs: TTL }) })
    first.open({ said: 'what did Anil say about the terms doc', route: 'navigate', app: 'Slack' })
    first.close('The redlines are with legal.')

    const second = new TurnMemory({ now: () => NOW, persistence: new TurnStore(db, { now: () => NOW, ttlMs: TTL }) })
    expect(second.recent()).toEqual([
      {
        said: 'what did Anil say about the terms doc',
        route: 'navigate',
        app: 'Slack',
        outcome: 'The redlines are with legal.',
        at: NOW
      }
    ])
  })

  it('never remembers more than this build is willing to', () => {
    const db = memoryDatabase()
    const disk = new TurnStore(db, { now: () => NOW, ttlMs: TTL })
    disk.save(['one', 'two', 'three'].map((said) => turn(said)))

    const memory = new TurnMemory({ now: () => NOW, max: 2, persistence: disk })
    expect(memory.recent().map((row) => row.said)).toEqual(['two', 'three'])
  })

  it('forgets on disk too', () => {
    const db = memoryDatabase()
    const disk = new TurnStore(db, { now: () => NOW, ttlMs: TTL })
    const memory = new TurnMemory({ now: () => NOW, persistence: disk })
    memory.open({ said: 'something private', route: 'dictate', app: null })
    memory.clear()

    expect(disk.load()).toEqual([])
  })
})
