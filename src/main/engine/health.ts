import type { EngineState } from './types'

/**
 * What the engine currently believes about itself.
 *
 * `ready()` is called before every edit, and it must be instant — an engine
 * that phones home to find out whether it can answer has already spent the
 * latency budget it was checking. So health is remembered rather than probed:
 * optimistic until something fails, then degraded for as long as the failure
 * is likely to last.
 *
 * The distinction that matters to the user is between *you need to do
 * something* and *wait a moment*:
 *
 *   signed-out  — the credential is wrong or gone. Settings, now.
 *   local-only  — rate limit, outage, no network. Nothing to do but wait,
 *                 and dictation is unaffected throughout.
 *
 * docs/PLAN.md calls this "rate-limit → local-only chip", and the shape is the
 * whole point: a degrade that is structural, visible, and temporary.
 */

export interface EngineHealthOptions {
  now?: () => number
}

/** How long each kind of failure is believed, before the engine tries again. */
const BACKOFF_MS = {
  rateLimit: 60_000,
  overloaded: 20_000,
  offline: 10_000,
  unknown: 15_000
} as const

export class EngineHealth {
  private state: EngineState = { kind: 'ready' }
  private until = 0
  private readonly now: () => number

  constructor(options: EngineHealthOptions = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  current(): EngineState {
    // A timed degrade expires on its own: the next edit is the retry, which
    // means recovery costs the user nothing and asks them for nothing.
    if (this.until > 0 && this.now() >= this.until) {
      this.state = { kind: 'ready' }
      this.until = 0
    }
    return this.state
  }

  /** A request succeeded — whatever we thought was wrong isn't. */
  recover(): void {
    this.state = { kind: 'ready' }
    this.until = 0
  }

  /** A request failed. Returns the state the engine is now in. */
  degrade(error: unknown): EngineState {
    const { state, ms } = classify(error)
    this.state = state
    // Being signed out does not heal by waiting, so it does not expire.
    this.until = state.kind === 'signed-out' ? 0 : this.now() + ms
    return state
  }
}

function classify(error: unknown): { state: EngineState; ms: number } {
  const status = statusOf(error)
  const message = error instanceof Error ? error.message : String(error)

  if (status === 401 || status === 403) {
    return {
      state: { kind: 'signed-out' },
      ms: 0
    }
  }
  if (status === 429) {
    return {
      state: { kind: 'local-only', reason: 'you’ve reached your usage limit for now.' },
      ms: BACKOFF_MS.rateLimit
    }
  }
  if (status === 529 || (typeof status === 'number' && status >= 500)) {
    return {
      state: { kind: 'local-only', reason: 'the service is busy.' },
      ms: BACKOFF_MS.overloaded
    }
  }
  if (looksOffline(message)) {
    return {
      state: { kind: 'local-only', reason: 'there’s no network connection.' },
      ms: BACKOFF_MS.offline
    }
  }
  return {
    state: { kind: 'local-only', reason: `${trimPeriod(message)}.` },
    ms: BACKOFF_MS.unknown
  }
}

/** Both SDKs put an HTTP status on their errors; neither shares a base class. */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number') return status
  const code = (error as { statusCode?: unknown }).statusCode
  return typeof code === 'number' ? code : null
}

const OFFLINE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|fetch failed|network|offline/i

function looksOffline(message: string): boolean {
  return OFFLINE.test(message)
}

function trimPeriod(message: string): string {
  return message.replace(/\s*[.!]+\s*$/, '')
}
