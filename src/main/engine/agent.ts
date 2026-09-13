import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Engine, EngineState, PlanRequest, PlanResult, TransformRequest, TransformResult } from './types'
import { EngineHealth } from './health'
import { EDIT_SYSTEM_PROMPT, cleanEditOutput, cleanEditPartial, editPrompt } from './prompts'

/**
 * AgentEngine — the user's own Claude subscription, through the Agent SDK.
 *
 * This is the lane docs/05-electron-architecture.md §3 is built around: no API
 * key to find, no billing to set up, nothing to paste for anyone already
 * signed in to Claude Code. The cost is a subprocess — the SDK runs the Claude
 * Code harness — and that subprocess is the whole latency problem.
 *
 * So the session is kept **warm**. Starting one costs hundreds of milliseconds
 * against a 1.2 s first-token budget, and paying that on the first edit after
 * every launch would be the difference the user notices. `warm()` is called at
 * sign-in and at boot; each edit is then a turn on a session that is already
 * up.
 *
 * What the session is *not* allowed to be is an agent:
 *
 *   tools: []            no Bash, no Read, no Edit, no web
 *   settingSources: []   no user settings, no CLAUDE.md, no MCP servers
 *   maxTurns: 1          one model turn, then stop
 *
 * That is the "glass pipeline" promise in literal form. Mull's model produces
 * text and nothing else; every action on the machine is taken by Mull's own
 * code, through the sidecar, with a preview in front of it.
 */

export interface AgentEngineOptions {
  /** From `claude setup-token`. Omit to inherit an existing Claude Code login. */
  oauthToken?: string | null
  model: string
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  /** Injected in tests, so none of this needs a subprocess. */
  start?: (options: Options, prompt: AsyncIterable<SDKUserMessage>) => Query
}

/** One turn in flight. The lane is serial, so there is never more than one. */
interface Turn {
  text: string
  onPartial?: (text: string) => void
  resolve: (text: string) => void
  reject: (error: Error) => void
}

export class AgentEngine implements Engine {
  readonly name = 'agent'
  readonly model: string
  private readonly health: EngineHealth
  private readonly log: NonNullable<AgentEngineOptions['log']>
  private session: Query | null = null
  private prompts: Pushable<SDKUserMessage> | null = null
  private turn: Turn | null = null

  constructor(private readonly options: AgentEngineOptions) {
    this.model = options.model
    this.health = new EngineHealth({ now: options.now })
    this.log = options.log ?? ((): void => {})
  }

  async ready(): Promise<EngineState> {
    return this.health.current()
  }

  /**
   * Bring the subprocess up before anyone is waiting on it. Safe to call
   * repeatedly and safe to ignore — a cold session still works, it is just
   * slower once.
   */
  warm(): void {
    try {
      this.ensureSession()
    } catch (err) {
      this.log('warn', 'engine: could not warm the session', err)
    }
  }

  async transform(
    request: TransformRequest,
    onPartial?: (text: string) => void
  ): Promise<TransformResult> {
    try {
      const text = await this.ask(editPrompt(request.instruction, request.text), onPartial)
      this.health.recover()
      return { text: cleanEditOutput(text) }
    } catch (err) {
      this.health.degrade(err)
      // A failed turn may have taken the session with it. Drop it rather than
      // let the next edit inherit a dead subprocess.
      this.reset()
      throw err
    }
  }

  async plan(_request: PlanRequest): Promise<PlanResult> {
    throw new Error('Mull can’t plan commands yet.')
  }

  async dispose(): Promise<void> {
    this.reset()
  }

  // -------------------------------------------------------------------------

  private ask(prompt: string, onPartial?: (text: string) => void): Promise<string> {
    if (this.turn) return Promise.reject(new Error('The engine is already working on an edit.'))
    const prompts = this.ensureSession()

    return new Promise<string>((resolve, reject) => {
      this.turn = { text: '', onPartial, resolve, reject }
      prompts.push({
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
        session_id: ''
      } as SDKUserMessage)
    })
  }

  private ensureSession(): Pushable<SDKUserMessage> {
    if (this.session && this.prompts) return this.prompts

    const prompts = new Pushable<SDKUserMessage>()
    const options: Options = {
      systemPrompt: EDIT_SYSTEM_PROMPT,
      // The three lines that make this a model call rather than an agent.
      tools: [],
      settingSources: [],
      maxTurns: 1,
      model: this.model,
      includePartialMessages: true,
      permissionMode: 'default',
      env: this.options.oauthToken
        ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: this.options.oauthToken }
        : { ...process.env }
    }

    const session = (this.options.start ?? defaultStart)(options, prompts)
    this.session = session
    this.prompts = prompts
    void this.pump(session)
    return prompts
  }

  /**
   * Read the session forever, handing each frame to the turn it belongs to.
   *
   * One reader for the life of the session rather than one per turn: the SDK
   * hands back a single generator, and consuming it in two places would race
   * frames between them.
   */
  private async pump(session: Query): Promise<void> {
    try {
      for await (const message of session) {
        if (message.type === 'stream_event') {
          const event = message.event
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const turn = this.turn
            if (!turn) continue
            turn.text += event.delta.text
            turn.onPartial?.(cleanEditPartial(turn.text))
          }
          continue
        }

        if (message.type === 'result') {
          const turn = this.turn
          this.turn = null
          if (!turn) continue
          if (message.subtype === 'success' && !message.is_error) {
            // `result` is the turn's final text; the accumulated deltas are
            // the fallback for a CLI that does not send partials.
            turn.resolve(message.result || turn.text)
          } else {
            const detail =
              message.subtype === 'success' ? message.result : `the turn ended: ${message.subtype}`
            turn.reject(
              withStatus(
                new Error(detail),
                message.subtype === 'success' ? statusOf(message) : null
              )
            )
          }
        }
      }
      this.failInFlight(new Error('The engine session ended unexpectedly.'))
    } catch (err) {
      this.failInFlight(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (this.session === session) this.reset()
    }
  }

  private failInFlight(error: Error): void {
    const turn = this.turn
    this.turn = null
    turn?.reject(error)
  }

  private reset(): void {
    this.prompts?.close()
    this.prompts = null
    this.session = null
  }
}

function defaultStart(options: Options, prompt: AsyncIterable<SDKUserMessage>): Query {
  return query({ prompt, options })
}

/** The CLI reports an API status on error results; keep it for EngineHealth. */
function statusOf(message: { api_error_status?: number | null }): number | null {
  return typeof message.api_error_status === 'number' ? message.api_error_status : null
}

function withStatus(error: Error, status: number | null): Error {
  if (status !== null) Object.assign(error, { status })
  return error
}

/**
 * An async iterable you can push into — the streaming-input side of a warm
 * session. Small enough to own rather than take a dependency for.
 */
class Pushable<T> implements AsyncIterable<T> {
  private readonly queued: T[] = []
  private waiting: ((result: IteratorResult<T>) => void) | null = null
  private closed = false

  push(value: T): void {
    const waiting = this.waiting
    if (waiting) {
      this.waiting = null
      waiting({ value, done: false })
      return
    }
    this.queued.push(value)
  }

  close(): void {
    this.closed = true
    const waiting = this.waiting
    if (waiting) {
      this.waiting = null
      waiting({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> =>
        new Promise((resolve) => {
          const queued = this.queued.shift()
          if (queued !== undefined) return resolve({ value: queued, done: false })
          if (this.closed) return resolve({ value: undefined, done: true })
          this.waiting = resolve
        })
    }
  }
}
