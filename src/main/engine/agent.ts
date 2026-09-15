import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { NavStep } from '@shared/nav'
import { runAgent, type AgentGoal, type AgentRunResult } from './agent-loop'
import type {
  AnswerRequest,
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
  ANSWER_SYSTEM_PROMPT,
  COMPOSE_SYSTEM_PROMPT,
  EDIT_SYSTEM_PROMPT,
  NAVIGATE_SYSTEM_PROMPT,
  answerPrompt,
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
  /**
   * May the writing lanes think? Read per turn, so arming it on the HUD takes
   * effect on the next thing the user says rather than the next launch.
   *
   * The classifier and the navigator are never given this. They choose between
   * four words and an index in a list respectively, both on the critical path,
   * and there is nothing there worth deliberating over.
   */
  thinking?: () => boolean
}

export class AgentEngine implements Engine {
  readonly name = 'agent'
  readonly model: string
  private readonly health: EngineHealth
  /** Kept for `runAgent`, which builds its own query rather than using one. */
  private readonly oauthToken: string | null
  private readonly log: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  private readonly edit: AgentSession
  private readonly classifier: AgentSession
  private readonly composer: AgentSession
  private readonly navigator: AgentSession
  private readonly answerer: AgentSession

  constructor(options: AgentEngineOptions) {
    this.model = options.model
    this.health = new EngineHealth({ now: options.now })
    this.oauthToken = options.oauthToken ?? null
    this.log = options.log ?? ((): void => {})

    const shared = {
      oauthToken: options.oauthToken ?? null,
      log: options.log ?? ((): void => {}),
      start: options.start
    }
    this.edit = new AgentSession({
      ...shared,
      label: 'edit',
      model: options.model,
      systemPrompt: EDIT_SYSTEM_PROMPT,
      thinking: options.thinking
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
      systemPrompt: COMPOSE_SYSTEM_PROMPT,
      thinking: options.thinking
    })
    this.navigator = new AgentSession({
      ...shared,
      label: 'navigate',
      model: options.model,
      systemPrompt: NAVIGATE_SYSTEM_PROMPT
    })
    // Separate from the navigator for the same reason the navigator is separate
    // from the composer: one emits a line of JSON and is told at length what it
    // may not press, the other writes prose to the user. Sharing a session
    // would mean sending whichever system prompt was not wanted.
    this.answerer = new AgentSession({
      ...shared,
      label: 'answer',
      model: options.model,
      systemPrompt: ANSWER_SYSTEM_PROMPT,
      thinking: options.thinking
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

  /**
   * What the window said, in answer to the goal.
   *
   * The last turn of a navigation and the only one the user reads as prose.
   * Cleaned with the same two helpers as an edit — a fence or a "Here's what I
   * found:" preamble is as unwelcome in a card as it is in someone's document.
   */
  async answer(
    request: AnswerRequest,
    onPartial?: (text: string) => void
  ): Promise<TransformResult> {
    try {
      const text = await this.answerer.ask(
        answerPrompt(request),
        onPartial ? (partial) => onPartial(cleanEditPartial(partial)) : undefined
      )
      this.health.recover()
      return { text: cleanEditOutput(text) }
    } catch (err) {
      this.health.degrade(err)
      this.answerer.reset()
      throw err
    }
  }

  /**
   * Run a goal to completion, with the model calling tools.
   *
   * The one method here that is not an `AgentSession` turn, and the one place
   * in Mull where a session is allowed to be an agent. It gets its own query
   * per run rather than a warm session, because here the conversation *is* the
   * memory and reusing it would mean the next run inheriting the last one's
   * beliefs about a window that has since changed. See `engine/agent-loop.ts`.
   *
   * Not wrapped in `health.degrade`/`recover` like the turns above: a run that
   * ends because the user stopped it, or because it hit a budget, says nothing
   * whatever about whether the engine is reachable, and marking the engine
   * unhealthy for those would take dictation's fallback with it.
   */
  async runAgent(request: AgentGoal): Promise<AgentRunResult> {
    return runAgent({
      ...request,
      model: this.model,
      oauthToken: this.oauthToken,
      log: this.log
    })
  }

  async dispose(): Promise<void> {
    this.edit.reset()
    this.classifier.reset()
    this.composer.reset()
    this.navigator.reset()
    this.answerer.reset()
  }
}

// ---------------------------------------------------------------------------

/** One turn in flight. A session is serial, so there is never more than one. */
interface Turn {
  text: string
  onPartial?: (text: string) => void
  resolve: (text: string) => void
  reject: (error: Error) => void
  /** Fires if the turn goes quiet. Cleared on every token and on settle. */
  watchdog: NodeJS.Timeout | null
}

/**
 * How long a turn may say nothing before Mull gives up on it.
 *
 * Every engine turn used to have **no deadline at all**. Only the classifier
 * was raced, and only because `IntentRouter` wrapped it from outside — so a
 * wedged Claude Code subprocess left the HUD on THINKING and a card empty
 * forever, with no error, no journal row and nothing to press. "It gets stuck
 * and never gives a final response" is exactly that, and there was no code path
 * that could ever have ended it.
 *
 * Two numbers rather than one total, because a slow answer and a dead one look
 * completely different on the wire and only one of them deserves to be killed:
 *
 *   FIRST_TOKEN  nothing at all has arrived. The subprocess is starting, the
 *                request is in flight, or it is wedged. Generous — a cold
 *                session plus a long screen transcript is genuinely slow.
 *   STALL        tokens were arriving and then stopped. Much tighter: a model
 *                mid-sentence does not pause for half a minute.
 *
 * A model that keeps streaming is never interrupted, however long it takes.
 */
const FIRST_TOKEN_TIMEOUT_MS = 60_000
const STALL_TIMEOUT_MS = 25_000

interface AgentSessionOptions {
  label: string
  model: string
  systemPrompt: string
  oauthToken: string | null
  log: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  start?: StartQuery
  /**
   * Whether this lane may think before answering, asked fresh each turn.
   *
   * Absent means never — which is the right default for everything, and the
   * only setting the classifier and the navigator ever have. See `ensure`: a
   * change in the answer costs a new session, because `thinking` is fixed when
   * the session is created.
   */
  thinking?: () => boolean
}

/** A warm, single-purpose Claude Code session with streaming input. */
class AgentSession {
  private session: Query | null = null
  private prompts: Pushable<SDKUserMessage> | null = null
  private turn: Turn | null = null
  /** What the live session was built with, so a change can be noticed. */
  private thinking = false

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
      const turn: Turn = { text: '', onPartial, resolve, reject, watchdog: null }
      this.turn = turn
      this.arm(turn, FIRST_TOKEN_TIMEOUT_MS, 'said nothing')
      prompts.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: ''
      } as SDKUserMessage)
    })
  }

  /**
   * Set the turn's deadline, replacing any previous one.
   *
   * On expiry the session is thrown away as well as the turn. A subprocess that
   * has stopped answering is not one to hand the next utterance to, and the
   * next `ask` will start a fresh one — the same discipline `transform` already
   * applies on failure.
   */
  private arm(turn: Turn, ms: number, what: string): void {
    if (turn.watchdog) clearTimeout(turn.watchdog)
    turn.watchdog = setTimeout(() => {
      if (this.turn !== turn) return
      this.turn = null
      this.options.log(
        'warn',
        `engine: the ${this.options.label} turn ${what} for ${Math.round(ms / 1000)}s — giving up`
      )
      this.reset()
      turn.reject(new Error(`Mull's engine stopped responding after ${Math.round(ms / 1000)}s.`))
    }, ms)
  }

  /** A turn has settled, one way or the other. Stop watching it. */
  private static settle(turn: Turn): void {
    if (turn.watchdog) clearTimeout(turn.watchdog)
    turn.watchdog = null
  }

  reset(): void {
    this.prompts?.close()
    this.prompts = null
    this.session = null
  }

  private ensure(): Pushable<SDKUserMessage> {
    const wanted = this.options.thinking?.() ?? false
    // A session carries its thinking mode from birth, so switching it means a
    // new one. Deliberately not smoothed over with a queued option change: the
    // user armed this on the HUD a second ago and expects *this* utterance to
    // get it, and a subprocess start is a fraction of what thinking itself
    // costs.
    if (this.session && this.thinking !== wanted) {
      this.options.log('info', `engine: ${this.options.label} restarting with thinking ${wanted ? 'on' : 'off'}`)
      this.reset()
    }
    if (this.session && this.prompts) return this.prompts
    this.thinking = wanted

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
      /**
       * Off unless this lane was handed a `thinking` predicate that says
       * otherwise — which only the writing lanes are, and only when the user
       * has armed it on the HUD.
       *
       * The default matters more than the switch. Left at the harness default
       * it is pure latency: a hundred output tokens of deliberation in front of
       * `{"intent":"compose"}`, measured at p50 20086ms against 954ms with it
       * off, for a choice between four words.
       */
      thinking: wanted ? { type: 'adaptive' } : { type: 'disabled' },
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
            // Tokens are the proof of life. Once they start, the tighter stall
            // budget applies — a model mid-sentence does not go quiet for half
            // a minute, and one that keeps streaming is never interrupted.
            this.arm(turn, STALL_TIMEOUT_MS, 'went quiet')
            turn.onPartial?.(turn.text)
          }
          continue
        }

        if (message.type === 'result') {
          const turn = this.turn
          this.turn = null
          if (!turn) continue
          AgentSession.settle(turn)
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
    if (turn) AgentSession.settle(turn)
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
