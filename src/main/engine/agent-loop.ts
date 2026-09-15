import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type Query,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_BUDGET_USD,
  AGENT_DEADLINE_MS,
  AGENT_SERVER,
  AGENT_TOOLS,
  DoneInputSchema,
  FindInputSchema,
  LookInputSchema,
  MAX_AGENT_TURNS,
  NoteInputSchema,
  PressInputSchema,
  toolName
} from '@shared/agent'
import { AGENT_SYSTEM_PROMPT, agentPrompt } from './prompts'
import type { ScreenContext } from '@shared/context'

/**
 * The loop — the thing `AgentEngine`'s five sessions deliberately are not.
 *
 * Every other engine turn in Mull is a model call: `tools: []`,
 * `settingSources: []`, `maxTurns: 1`, one reply, done. This one is an agent. It
 * runs until the model says `done`, until a budget stops it, or until the user
 * does.
 *
 * ### What has and has not changed about the sandbox
 *
 * `tools: []` stays exactly where it was, and that is the point worth being
 * clear about: the SDK documents `tools` as "the base set of available
 * **built-in** tools", and an MCP server is additive to it. So the line that
 * excludes Bash, Read, Edit, WebFetch and the rest is untouched, and what the
 * model gains is five in-process functions that close over Mull's own sidecar.
 * The agent gets a loop and Mull's hands; it does not get a computer.
 *
 * `settingSources: []` stays too — no CLAUDE.md, no user settings, no MCP
 * servers the user happens to have configured for Claude Code.
 *
 * ### One session per run, and never warm
 *
 * The five `AgentSession`s in `agent.ts` are kept warm and are never reset on
 * success, which for a single-turn call is invisible. Here the conversation *is*
 * the memory: everything the model learned about where things are lives in it.
 * Reusing it would mean the next run inheriting the last run's beliefs about a
 * window that has since changed. So a run gets a session, and the session is
 * disposed with it.
 *
 * ### Four budgets, and only one of them is for the user
 *
 * `maxTurns` bounds a loop that is going nowhere. `maxBudgetUsd` bounds one that
 * is going somewhere expensive. `AGENT_DEADLINE_MS` bounds one that is merely
 * hung — the failure neither of the others catches, because nothing is being
 * spent. None of those is the stop: the stop is the user, it is checked before
 * every single act, and it is the only one that can end a run *now* rather than
 * at the next boundary.
 */

export type StartQuery = (options: Options, prompt: AsyncIterable<SDKUserMessage>) => Query

/** What the loop does when the model asks for something. */
export interface AgentHandlers {
  look(input: { want: 'text' | 'targets' | 'both' }): Promise<string>
  find(input: { query: string; kind?: 'press' | 'type' }): Promise<string>
  press(input: { index: number; expectTitle: string }): Promise<string>
  note(input: { text: string }): Promise<string>
  done(input: { found: boolean; because: string }): Promise<string>
}

/**
 * What a caller asks for — the lane's half of the request.
 *
 * Deliberately free of `model`, credentials and the test seam: which model runs
 * and how it is authenticated are the engine's business, and a lane that had to
 * know would be a lane that has to be told again every time the user changes a
 * setting.
 */
export interface AgentGoal {
  goal: string
  app: { bundleId: string; name: string } | null
  context?: ScreenContext | null
  handlers: AgentHandlers
  /** Refuse every act, and end the turn, once this says so. */
  stopped: () => boolean
  maxTurns?: number
  deadlineMs?: number
}

/** The whole request, as the engine assembles it. */
export interface AgentRunRequest extends AgentGoal {
  model: string
  oauthToken?: string | null
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  /** Injected in tests, so none of this needs a subprocess. */
  start?: StartQuery
}

/** How a run ended, in terms the card and the journal can both use. */
export interface AgentRunResult {
  /** 'done' | 'stopped' | 'turns' | 'budget' | 'deadline' | 'error' */
  ended: 'done' | 'stopped' | 'turns' | 'budget' | 'deadline' | 'error'
  turns: number
  costUsd: number
  /** Set when `ended` is 'error' — what to print on the card. */
  detail?: string
}

/**
 * Run one goal to completion.
 *
 * Returns how it ended; everything it *did* went through the handlers, which is
 * where the card, the journal and the stop all live. Nothing here touches the
 * machine.
 */
export async function runAgent(request: AgentRunRequest): Promise<AgentRunResult> {
  const abort = new AbortController()
  /** Set by the `done` tool, because the SDK has no other way to tell us. */
  let finished = false

  const server = createSdkMcpServer({
    name: AGENT_SERVER,
    version: '1',
    tools: [
      tool(
        'look',
        'Read this window: its text, what can be pressed, or both.',
        LookInputSchema.shape,
        async (input) => reply(await request.handlers.look(input))
      ),
      tool(
        'find',
        'Narrow what can be pressed to the few things matching a word or a name.',
        FindInputSchema.shape,
        async (input) => reply(await request.handlers.find(input))
      ),
      tool(
        'press',
        'Press one numbered thing from the current scan.',
        PressInputSchema.shape,
        async (input) => reply(await request.handlers.press(input))
      ),
      tool(
        'note',
        'Say in one clause what you are doing, for the user watching.',
        NoteInputSchema.shape,
        async (input) => reply(await request.handlers.note(input))
      ),
      tool('done', 'Stop, saying whether you got there.', DoneInputSchema.shape, async (input) => {
        // The SDK has no other way to tell a finished run from one that simply
        // stopped producing turns, and those are very different outcomes.
        finished = true
        return reply(await request.handlers.done(input))
      })
    ]
  })

  const prompts = new Pushable<SDKUserMessage>()
  const options: Options = {
    systemPrompt: AGENT_SYSTEM_PROMPT,
    mcpServers: { [AGENT_SERVER]: server },
    // Unchanged from every other engine session in Mull. `tools` is the
    // built-in set; the MCP server above is additive to it.
    tools: [],
    settingSources: [],
    maxTurns: request.maxTurns ?? MAX_AGENT_TURNS,
    maxBudgetUsd: AGENT_BUDGET_USD,
    model: request.model,
    effort: 'low',
    // Same reason as everywhere else: a hundred output tokens of deliberation in
    // front of a decision between four buttons, measured at p50 20086ms against
    // 954ms with it off. A loop pays that per turn.
    thinking: { type: 'disabled' },
    permissionMode: 'default',
    abortController: abort,
    /**
     * The gate, and the stop's first and strongest layer.
     *
     * Synchronous, and it runs *before* the handler — so a tool call the model
     * has already emitted never executes. `interrupt` ends the turn as well as
     * refusing the act, which is what stops the model spending its remaining
     * budget arguing with a wall of denials.
     */
    canUseTool: async (name, input) => {
      if (request.stopped()) {
        return {
          behavior: 'deny',
          message: 'the user stopped this run',
          interrupt: true
        }
      }
      if (!OURS.has(name)) {
        // Unreachable — nothing else is registered, and `tools: []` keeps the
        // built-ins out — so it is worth refusing loudly rather than allowing
        // whatever a future harness adds by default.
        request.log?.('warn', `agent: refused an unfamiliar tool "${name}"`)
        return { behavior: 'deny', message: 'that tool is not available here' }
      }
      // `updatedInput` carries the arguments through unchanged. Omitting it is
      // not the same as passing `{}`, which would hand the handler nothing.
      return { behavior: 'allow', updatedInput: input }
    },
    env: request.oauthToken
      ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: request.oauthToken }
      : { ...process.env }
  }

  const session = (request.start ?? defaultStart)(options, prompts)

  // The deadline. Not a budget — a run that is merely hung is spending nothing,
  // so neither `maxTurns` nor `maxBudgetUsd` will ever end it, and a card that
  // sits on RUNNING forever is the shape of bug the engine watchdogs exist for.
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    request.log?.('warn', 'agent: the run went quiet — giving up')
    abort.abort()
  }, request.deadlineMs ?? AGENT_DEADLINE_MS)

  prompts.push({
    type: 'user',
    message: { role: 'user', content: agentPrompt(request) },
    parent_tool_use_id: null,
    session_id: ''
  } as SDKUserMessage)

  let turns = 0
  let costUsd = 0
  let detail: string | undefined
  let ended: AgentRunResult['ended'] = 'error'

  try {
    for await (const message of session) {
      if (message.type !== 'result') continue
      turns = message.num_turns
      costUsd = message.total_cost_usd
      if (message.subtype === 'success') ended = finished ? 'done' : 'turns'
      else if (message.subtype === 'error_max_turns') ended = 'turns'
      else if (message.subtype === 'error_max_budget_usd') ended = 'budget'
      else {
        ended = 'error'
        detail = message.subtype
      }
      break
    }
  } catch (err) {
    // An abort is not a failure — it is one of the two deliberate endings, and
    // which one depends on who pulled it.
    ended = timedOut ? 'deadline' : request.stopped() ? 'stopped' : 'error'
    if (ended === 'error') detail = err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(deadline)
    prompts.close()
    abort.abort()
  }

  // The stop outranks whatever the SDK said on the way out: a run the user
  // ended is a stopped run even if the last turn happened to complete first.
  if (request.stopped()) ended = 'stopped'
  else if (timedOut) ended = 'deadline'

  return { ended, turns, costUsd, ...(detail ? { detail } : {}) }
}

// ---------------------------------------------------------------------------

/** Tool results are prose for a model to read, not JSON for code to parse. */
function reply(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

/** The five, by the full MCP names `canUseTool` is actually handed. */
const OURS: ReadonlySet<string> = new Set(AGENT_TOOLS.map(toolName))

function defaultStart(options: Options, prompt: AsyncIterable<SDKUserMessage>): Query {
  return query({ prompt, options })
}

/**
 * An async iterable you can push into — the streaming-input side of a session.
 *
 * The same shape `engine/agent.ts` owns, duplicated rather than shared because
 * that one is private to the warm-session machinery and this one outlives a
 * single turn. Small enough to own twice rather than couple the two.
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
