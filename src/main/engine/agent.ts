import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { NavStep } from '@shared/nav'
import type {
  ClassifiedIntent,
  ClassifyRequest,
  ComposeRequest,
  Engine,
  EngineState,
  NavigateRequest,
  TransformRequest,
  TransformResult
} from './types'
import { EngineHealth } from './health'
import {
  CLASSIFIER_MODEL,
  CLASSIFIER_SYSTEM_PROMPT,
  classifyPrompt,
  parseClassification
} from './classify'
import {
  COMPOSE_SYSTEM_PROMPT,
  EDIT_SYSTEM_PROMPT,
  NAVIGATE_SYSTEM_PROMPT,
  cleanEditOutput,
  cleanEditPartial,
  composeContent,
  editContent,
  navigateContent,
  parseNavStep,
  type PromptBlock
} from './prompts'

/**
 * AgentEngine — the user's own Claude subscription, through the Agent SDK.
 *
 * This is the lane docs/05-electron-architecture.md §3 is built around: no API
 * key to find, no billing to set up, nothing to paste for anyone already
 * signed in to Claude Code. The cost is a subprocess — the SDK runs the Claude
 * Code harness — and that subprocess is the whole latency problem.
 *
 * So sessions are kept **warm**. Starting one costs hundreds of milliseconds
 * against a 1.2 s budget, and paying that on the first utterance after every
 * launch would be the difference the user notices.
 *
 * There are **two** of them, because they are two different jobs:
 *
 *   edit      the chosen model, the editor's-pencil prompt, streamed
 *   classify  always Haiku, a few tokens of JSON, on the critical path
 *
 * One session cannot be both: a system prompt that says "reply with the
 * rewritten passage and nothing else" is exactly how you get a rewritten
 * passage when you asked for JSON. Two subprocesses is the price, and the
 * classifier is the one that runs on every utterance with text in front of it.
 *
 * What a session is *not* allowed to be is an agent:
 *
 *   tools: []            no Bash, no Read, no Edit, no web
 *   settingSources: []   no user settings, no CLAUDE.md, no MCP servers
 *   maxTurns: 1          one model turn, then stop
 *
 * That is the "glass pipeline" promise in literal form. Mull's model produces
 * text and nothing else; every action on the machine is taken by Mull's own
 * code, through the sidecar, with a preview in front of it.
 */

export type StartQuery = (options: Options, prompt: AsyncIterable<SDKUserMessage>) => Query

export interface AgentEngineOptions {
  /** From `claude setup-token`. Omit to inherit an existing Claude Code login. */
  oauthToken?: string | null
  model: string
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  /** Injected in tests, so none of this needs a subprocess. */
  start?: StartQuery
}

export class AgentEngine implements Engine {
  readonly name = 'agent'
  readonly model: string
  private readonly health: EngineHealth
  private readonly edit: AgentSession
  private readonly classifier: AgentSession
  private readonly composer: AgentSession
  private readonly navigator: AgentSession

  constructor(options: AgentEngineOptions) {
    this.model = options.model
    this.health = new EngineHealth({ now: options.now })

    const shared = {
      oauthToken: options.oauthToken ?? null,
      log: options.log ?? ((): void => {}),
      start: options.start
    }
    this.edit = new AgentSession({
      ...shared,
      label: 'edit',
      model: options.model,
      systemPrompt: EDIT_SYSTEM_PROMPT
    })
    this.classifier = new AgentSession({
      ...shared,
      label: 'classify',
      model: CLASSIFIER_MODEL,
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT
    })
    this.composer = new AgentSession({
      ...shared,
      label: 'compose',
      model: options.model,
      systemPrompt: COMPOSE_SYSTEM_PROMPT
    })
    this.navigator = new AgentSession({
      ...shared,
      label: 'navigate',
      model: options.model,
      systemPrompt: NAVIGATE_SYSTEM_PROMPT
    })
  }

  async ready(): Promise<EngineState> {
    return this.health.current()
  }

  /**
   * Bring the two hot subprocesses up before anyone is waiting on them. Safe to
   * call repeatedly and safe to ignore — a cold session still works, it is just
   * slower once.
   *
   * The composer is deliberately **not** warmed. Every warm session is a Claude
   * Code subprocess sitting in memory, and composing is much rarer than editing
   * — a user who never asks for a reply should not pay for one. It spins up on
   * first use and stays warm after that.
   */
  warm(): void {
    this.edit.warm()
    this.classifier.warm()
  }

  async classify(request: ClassifyRequest): Promise<ClassifiedIntent> {
    try {
      const reply = await this.classifier.ask(classifyPrompt(request))
      this.health.recover()
      return parseClassification(reply)
    } catch (err) {
      this.health.degrade(err)
      this.classifier.reset()
      throw err
    }
  }

  async transform(
    request: TransformRequest,
    onPartial?: (text: string) => void
  ): Promise<TransformResult> {
    try {
      const text = await this.edit.ask(
        editContent(request),
        onPartial ? (partial) => onPartial(cleanEditPartial(partial)) : undefined
      )
      this.health.recover()
      return { text: cleanEditOutput(text) }
    } catch (err) {
      this.health.degrade(err)
      // A failed turn may have taken the session with it. Drop it rather than
      // let the next edit inherit a dead subprocess.
      this.edit.reset()
      throw err
    }
  }

  async compose(
    request: ComposeRequest,
    onPartial?: (text: string) => void
  ): Promise<TransformResult> {
    try {
      const text = await this.composer.ask(
        composeContent(request),
        onPartial ? (partial) => onPartial(cleanEditPartial(partial)) : undefined
      )
      this.health.recover()
      return { text: cleanEditOutput(text) }
    } catch (err) {
      this.health.degrade(err)
      this.composer.reset()
      throw err
    }
  }

  /**
   * One navigation step.
   *
   * Its own session rather than a turn on the composer's, because the system
   * prompts could not be more different — one writes prose in the user's voice,
   * the other emits a line of JSON and is told at length what it may not press.
   * Sharing a session would mean sending whichever prompt was not wanted.
   *
   * Not warmed. Navigation is the rarest thing Mull does and the user is
   * looking at a card while it happens, so the cold start is paid where there
   * is somewhere to show it.
   */
  async navigate(request: NavigateRequest): Promise<NavStep> {
    try {
      const reply = await this.navigator.ask(navigateContent(request))
      this.health.recover()
      return parseNavStep(reply)
    } catch (err) {
      this.health.degrade(err)
      this.navigator.reset()
      throw err
    }
  }

  async dispose(): Promise<void> {
    this.edit.reset()
    this.classifier.reset()
    this.composer.reset()
    this.navigator.reset()
  }
}

// ---------------------------------------------------------------------------

/** One turn in flight. A session is serial, so there is never more than one. */
interface Turn {
  text: string
  onPartial?: (text: string) => void
  resolve: (text: string) => void
  reject: (error: Error) => void
}

interface AgentSessionOptions {
  label: string
  model: string
  systemPrompt: string
  oauthToken: string | null
  log: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  start?: StartQuery
}

/** A warm, single-purpose Claude Code session with streaming input. */
class AgentSession {
  private session: Query | null = null
  private prompts: Pushable<SDKUserMessage> | null = null
  private turn: Turn | null = null

  constructor(private readonly options: AgentSessionOptions) {}

  warm(): void {
    try {
      this.ensure()
    } catch (err) {
      this.options.log('warn', `engine: could not warm the ${this.options.label} session`, err)
    }
  }

  /**
   * `content` is a string for an ordinary turn and blocks when a picture is
   * attached. `SDKUserMessage.message` is a full `MessageParam`, so the harness
   * carries image blocks the same way the Messages API does — measured against
   * the live subscription lane before anything was built on it, because the
   * types describing what may be *sent* say nothing about what survives the
   * trip through Claude Code.
   */
  ask(
    content: string | PromptBlock[],
    onPartial?: (text: string) => void
  ): Promise<string> {
    if (this.turn) {
      return Promise.reject(new Error(`The engine is already busy (${this.options.label}).`))
    }
    const prompts = this.ensure()

    return new Promise<string>((resolve, reject) => {
      this.turn = { text: '', onPartial, resolve, reject }
      prompts.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: ''
      } as SDKUserMessage)
    })
  }

  reset(): void {
    this.prompts?.close()
    this.prompts = null
    this.session = null
  }

  private ensure(): Pushable<SDKUserMessage> {
    if (this.session && this.prompts) return this.prompts

    const prompts = new Pushable<SDKUserMessage>()
    const options: Options = {
      systemPrompt: this.options.systemPrompt,
      // The three lines that make this a model call rather than an agent.
      tools: [],
      settingSources: [],
      maxTurns: 1,
      model: this.options.model,
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
            turn.onPartial?.(turn.text)
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
