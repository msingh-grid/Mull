/**
 * One line per step, per utterance, with the clock attached.
 *
 * Mull's logging used to be a handful of lines at the *end* of things —
 * "dictation applied", "intent routed" — which says what happened and nothing
 * about where the time went or what was tried on the way. That is exactly the
 * wrong shape for the two questions actually asked of this app: *why did that
 * take eleven seconds* and *what did it think it was looking at*.
 *
 * So every utterance gets a short id and every step gets a line:
 *
 *   ⟨u7⟩    +0ms  hold.begin       intent=instruct
 *   ⟨u7⟩   +38ms  focus.read       app=Slack field=0 sel=0
 *   ⟨u7⟩  +467ms  context.read     blocks=74 chars=2392 image=183KB harvest=42ms
 *   ⟨u7⟩ +2247ms  asr.done         ms=1780 chars=41
 *   ⟨u7⟩ +7447ms  classify.done    by=model kind=navigate ms=5200
 *   ⟨u7⟩ +7451ms  lane.navigate    goal="what did Anil say about the terms doc"
 *
 * The elapsed column is cumulative from the key going down, which is the number
 * the user actually feels. Deltas are left to subtraction; a second column of
 * them reads as noise once the cumulative one is right.
 *
 * **Lengths, never content** — the same rule `bench.jsonl` follows. The one
 * exception is the user's own transcript and their own instruction, which are
 * theirs and are the only way to make sense of a routing decision. Other
 * people's writing — the window, the field, the selection — is counted and
 * never quoted. What Mull read is inspectable, deliberately, in the journal's
 * "What Mull saw" instead: a place the user opens on purpose.
 */

export type LogFn = (
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: unknown
) => void

let counter = 0

/** A fresh id, short enough to scan a log for. Wraps; it is a label, not a key. */
function nextId(): string {
  counter = (counter + 1) % 1000
  return `u${counter}`
}

export interface TraceOptions {
  log?: LogFn
  now?: () => number
  /** Reuse an id — for a lane continuing an utterance that began elsewhere. */
  id?: string
  startedAt?: number
}

export class Trace {
  readonly id: string
  readonly startedAt: number
  private readonly log: LogFn
  private readonly now: () => number

  constructor(options: TraceOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.id = options.id ?? nextId()
    this.startedAt = options.startedAt ?? this.now()
    this.log = options.log ?? ((): void => {})
  }

  /**
   * One step. `name` is `area.event`, so a log can be grepped by either half.
   *
   * Values are rendered inline rather than handed over as an object, because
   * the whole point is a line that can be read at a glance next to the one
   * above it — and electron-log pretty-prints an object across five lines.
   */
  step(name: string, fields?: Record<string, unknown>): void {
    const elapsed = this.now() - this.startedAt
    const rendered = fields ? renderFields(fields) : ''
    this.log(
      'info',
      `⟨${this.id}⟩ ${`+${elapsed}ms`.padStart(8)}  ${name.padEnd(17)}${rendered}`
    )
  }

  /** A step that went wrong. Same line, louder, and never swallowed. */
  fail(name: string, fields?: Record<string, unknown>, err?: unknown): void {
    const elapsed = this.now() - this.startedAt
    const rendered = fields ? renderFields(fields) : ''
    const because = err instanceof Error ? ` — ${err.message}` : err ? ` — ${String(err)}` : ''
    this.log(
      'warn',
      `⟨${this.id}⟩ ${`+${elapsed}ms`.padStart(8)}  ${name.padEnd(17)}${rendered}${because}`
    )
  }

  /** How long since the key went down. For a step that wants to say so itself. */
  elapsed(): number {
    return this.now() - this.startedAt
  }

  /** A stopwatch for one operation, so a step can report its own cost. */
  mark(): () => number {
    const from = this.now()
    return () => this.now() - from
  }

  /**
   * A child that shares the id but restarts the clock.
   *
   * For work that outlives the utterance — a plan the user reads and then runs
   * a minute later. Measuring that from the key-down would produce a column of
   * numbers about how long someone spent deciding.
   */
  fork(): Trace {
    return new Trace({ log: this.log, now: this.now, id: this.id })
  }
}

function renderFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(' ')
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') {
    // Clamped, because the transcript is the one free-text field here.
    const clipped = value.length > 90 ? `${value.slice(0, 90)}…` : value
    // Quoted only when it needs to be: empty (so it is visible at all), or
    // holding a space or an `=` that would otherwise run into the next field.
    // Not `JSON.stringify` — a step whose value already contains a quoted name
    // comes back as what="press 37 \"Anil Turaga\"", and a log line is read by
    // a person, not parsed.
    if (clipped === '') return '""'
    if (!/[\s=]/u.test(clipped)) return clipped
    return `"${clipped.replace(/"/gu, '’')}"`
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(1)
  return String(value)
}

/** Bytes, in the unit a person reads. For image sizes in a step line. */
export function kb(bytes: number | null | undefined): string | undefined {
  if (bytes === null || bytes === undefined) return undefined
  return `${Math.round(bytes / 1024)}KB`
}
