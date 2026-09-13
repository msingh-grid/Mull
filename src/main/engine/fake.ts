import type {
  Engine,
  EngineState,
  PlanRequest,
  PlanResult,
  TransformRequest,
  TransformResult
} from './types'

/**
 * FakeEngine — deterministic, local, and not a model.
 *
 * It exists so the diff and plan cards can be built, reviewed and demoed
 * against something real-shaped before M4 wires an actual engine. Two rules
 * keep it from becoming a lie:
 *
 *  1. It never claims to be the engine. `ready()` reports `local-only` unless
 *     a caller explicitly asks for `ready`, so any surface that assumes a real
 *     engine is present will visibly say otherwise.
 *  2. Its edits are rules, not guesses — it strips hedging phrases and
 *     collapses the wreckage. On the design's canonical sample that produces
 *     exactly the marks the board shows; on the user's own text it produces
 *     something modest and true rather than an invented paraphrase.
 */

/** The sample every Studio Paper surface has been designed against. */
export const CANONICAL_SAMPLE = {
  before:
    'I’m so sorry to bother you again, but I was just wondering if maybe we still need your sign-off on the terms doc whenever you get a chance, no rush at all.',
  after: 'Following up: we still need your sign-off on the terms doc by Friday.'
} as const

/**
 * Hedges, longest first so the greedy pass takes the biggest bite. These are
 * the phrases the brief's sample is built from; the list is illustrative, not
 * a linguistic claim.
 */
const HEDGES: Array<[RegExp, string]> = [
  [/I’m so sorry to bother you again,? but I was just wondering if maybe\s*/giu, 'Following up: '],
  [/\s*whenever you get a chance,? no rush at all/giu, ' by Friday'],
  [/\s*,?\s*if that(’|')s ok(ay)? with you/giu, ''],
  [/\s*,?\s*no rush at all/giu, ''],
  [/\bI was (just )?wondering if (maybe )?/giu, ''],
  [/\bI (just )?wanted to (quickly )?/giu, ''],
  [/\bsorry to bother you,?\s*/giu, ''],
  [/\bjust a quick (note|one),?\s*/giu, ''],
  [/\b(just|really|very|actually|basically|kind of|sort of)\s+/giu, ''],
  [/\bI think (that )?(maybe )?/giu, ''],
  [/\bif you (could|can) (please )?/giu, 'please ']
]

export interface FakeEngineOptions {
  /** What `ready()` reports. Defaults to the honest `local-only`. */
  state?: EngineState
  /** Delay between streamed chunks; 0 in tests. */
  chunkMs?: number
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>
}

export class FakeEngine implements Engine {
  private readonly state: EngineState
  private readonly chunkMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: FakeEngineOptions = {}) {
    this.state = options.state ?? { kind: 'local-only', reason: 'No engine is connected yet.' }
    this.chunkMs = options.chunkMs ?? 26
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async ready(): Promise<EngineState> {
    return this.state
  }

  async transform(
    request: TransformRequest,
    onPartial?: (text: string) => void
  ): Promise<TransformResult> {
    const source = request.text.trim() ? request.text : CANONICAL_SAMPLE.before
    const text = tighten(source)

    if (onPartial) {
      // Stream by words so the card fills in the way writing does.
      const words = text.split(/(\s+)/)
      let sofar = ''
      for (const word of words) {
        sofar += word
        onPartial(sofar)
        if (this.chunkMs > 0) await this.sleep(this.chunkMs)
      }
    }

    return { text }
  }

  async plan(request: PlanRequest): Promise<PlanResult> {
    return {
      context: request.app?.name ?? null,
      steps: [
        { verb: 'open', object: 'Notes' },
        { verb: 'create', object: 'a note titled “Q3 sign-off”' },
        { verb: 'insert', object: 'the last thing you dictated' }
      ]
    }
  }
}

/** The rules pass. Exported so its behaviour is directly testable. */
export function tighten(text: string): string {
  let out = text
  for (const [pattern, replacement] of HEDGES) out = out.replace(pattern, replacement)

  out = out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*\./g, '.')
    .trim()

  // Re-capitalise if a hedge took the opening words with it.
  const first = out.search(/\p{L}/u)
  if (first >= 0) out = out.slice(0, first) + out.charAt(first).toUpperCase() + out.slice(first + 1)
  return out
}
