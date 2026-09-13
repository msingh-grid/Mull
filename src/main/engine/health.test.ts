import { describe, expect, it } from 'vitest'
import { EngineHealth } from './health'

function withClock(): { health: EngineHealth; advance: (ms: number) => void } {
  let now = 1_000
  return {
    health: new EngineHealth({ now: () => now }),
    advance: (ms) => {
      now += ms
    }
  }
}

function httpError(status: number, message = 'request failed'): Error {
  return Object.assign(new Error(message), { status })
}

describe('EngineHealth', () => {
  it('starts optimistic — asking costs nothing', () => {
    expect(new EngineHealth().current()).toEqual({ kind: 'ready' })
  })

  it('treats a rejected credential as something the user must fix', () => {
    const { health } = withClock()
    expect(health.degrade(httpError(401))).toEqual({ kind: 'signed-out' })
  })

  it('never expires a signed-out state — waiting does not fix it', () => {
    const { health, advance } = withClock()
    health.degrade(httpError(403))
    advance(60 * 60 * 1_000)
    expect(health.current()).toEqual({ kind: 'signed-out' })
  })

  it('degrades a rate limit to local-only, and recovers on its own', () => {
    const { health, advance } = withClock()
    const state = health.degrade(httpError(429))
    expect(state).toEqual({ kind: 'local-only', reason: 'you’ve reached your usage limit for now.' })

    advance(30_000)
    expect(health.current().kind).toBe('local-only')
    // The next edit after the backoff is itself the retry: the user is never
    // asked to do anything, and never told to try again later by hand.
    advance(31_000)
    expect(health.current()).toEqual({ kind: 'ready' })
  })

  it('says the service is busy for a 529', () => {
    const { health } = withClock()
    expect(health.degrade(httpError(529))).toMatchObject({
      kind: 'local-only',
      reason: 'the service is busy.'
    })
  })

  it('recognises being offline from the error, not from a status', () => {
    const { health } = withClock()
    expect(health.degrade(new Error('fetch failed'))).toMatchObject({
      reason: 'there’s no network connection.'
    })
    expect(health.degrade(new Error('getaddrinfo ENOTFOUND api.anthropic.com'))).toMatchObject({
      reason: 'there’s no network connection.'
    })
  })

  it('passes an unrecognised failure through in the user’s sentence', () => {
    const { health } = withClock()
    expect(health.degrade(new Error('the turn ended: error_max_turns'))).toEqual({
      kind: 'local-only',
      reason: 'the turn ended: error_max_turns.'
    })
  })

  it('clears a degrade the moment something succeeds', () => {
    const { health } = withClock()
    health.degrade(httpError(429))
    health.recover()
    expect(health.current()).toEqual({ kind: 'ready' })
  })
})
