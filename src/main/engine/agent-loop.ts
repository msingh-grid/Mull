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
  AppsInputSchema,
  DoneInputSchema,
  FindInputSchema,
  KeyInputSchema,
  LookInputSchema,
  MAX_AGENT_TURNS,
  ChooseMenuInputSchema,
  MenusInputSchema,
  NoteInputSchema,
  OpenUrlInputSchema,
  PressInputSchema,
  ScrollToInputSchema,
  SetTextInputSchema,
  SwitchAppInputSchema,
  SwitchTabInputSchema,
  TabsInputSchema,
  checkMenuCommand,
  checkUrl,
  toolName,
  type AgentKey
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
 * model gains is twelve in-process functions that close over Mull's own sidecar,
 * the browser in front of it and the list of what else is running. The agent
 * gets a loop and Mull's hands; it does not get a computer.
 *
 * Only one of the twelve reaches further than the hands do. `openUrl` is a
 * request that leaves the machine, so it is the only tool here that needs
 * permission rather than merely a description — see the gate below, and
 * `checkUrl` in `@shared/agent` for what it checks and what it does not.
 *
 * The two cross-app tools are deliberately *not* gated here, and that is a
 * decision rather than an omission. `switchApp` can only reach an application
 * the user already has open and that `apps` has already named in *this* run, so
 * its check is where that state lives — in the handler — rather than duplicated
 * into a callback that would have to be handed the same map to be any stricter.
 * `openUrl` is gated here because a request that has been sent cannot be unsent,
 * which is a different kind of thing entirely.
 *
 * That argument used to lean on a second leg — *`restore` runs on every exit
 * path, so a switch is reversible* — and that leg is now shorter than it was. A
 * run that **finishes** may ask to be left where it is (`done({stay})`), because
 * "open Slack" is a goal whose whole content is being in Slack. Runs that stop,
 * expire or throw still restore unconditionally. So the honest statement is that
 * a switch is reversible right up until the model says the switch *was* the
 * task — which is the point at which the user wanted it anyway, and is visible
 * on the card as it happens either way.
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
  setText(input: { index: number; expectTitle: string; text: string }): Promise<string>
  key(input: { key: AgentKey; times?: number }): Promise<string>
  scrollTo(input: { index: number; expectTitle: string }): Promise<string>
  apps(input: Record<string, never>): Promise<string>
  switchApp(input: { bundleId: string; because: string }): Promise<string>
  menus(input: { query?: string }): Promise<string>
  chooseMenu(input: { menu: string; name: string; because: string }): Promise<string>
  tabs(input: Record<string, never>): Promise<string>
  switchTab(input: { index?: number; urlContains?: string }): Promise<string>
  openUrl(input: { url: string; newTab?: boolean }): Promise<string>
  note(input: { text: string }): Promise<string>
  done(input: { found: boolean; because: string; stay?: boolean }): Promise<string>
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
  /**
   * May this URL be opened? Asked before `openUrl` runs, and before the handler
   * is entered at all.
   *
   * Supplied by the lane rather than computed here, because the answer depends
   * on which sites the run has already been shown the inside of — state the
   * loop does not have and should not start keeping. Absent, `checkUrl` is
   * applied with nothing known, which is the strict reading rather than the
   * permissive one: a missing gate must fail closed.
   */
  urlGate?: (url: string) => { ok: boolean; because: string }
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
        'setText',
        'Put text into a field, a box or a combo. Replaces what is there. Nothing is submitted.',
        SetTextInputSchema.shape,
        async (input) => reply(await request.handlers.setText(input))
      ),
      tool(
        'key',
        'Press a navigation key — arrows, tab, page up, page down. There is no Return.',
        KeyInputSchema.shape,
        async (input) => reply(await request.handlers.key(input))
      ),
      tool(
        'scrollTo',
        'Bring one numbered thing into view. Presses nothing; it only changes what is on screen.',
        ScrollToInputSchema.shape,
        async (input) => reply(await request.handlers.scrollTo(input))
      ),
      tool(
        'apps',
        'Every application running right now, with the id switchApp needs.',
        AppsInputSchema.shape,
        async (input) => reply(await request.handlers.apps(input as Record<string, never>))
      ),
      tool(
        'switchApp',
        'Bring another running application to the front. The user watches this happen, so say why.',
        SwitchAppInputSchema.shape,
        async (input) => reply(await request.handlers.switchApp(input))
      ),
      tool(
        'menus',
        'Every command this application has, from its menu bar. Works even in apps whose windows cannot be read.',
        MenusInputSchema.shape,
        async (input) => reply(await request.handlers.menus(input))
      ),
      tool(
        'chooseMenu',
        'Choose one command from the menus. The user watches this happen, so say why.',
        ChooseMenuInputSchema.shape,
        async (input) => reply(await request.handlers.chooseMenu(input))
      ),
      tool(
        'tabs',
        'Every tab this browser has open, with its title and its address. Works even when the page itself cannot be read.',
        TabsInputSchema.shape,
        async (input) => reply(await request.handlers.tabs(input as Record<string, never>))
      ),
      tool(
        'switchTab',
        'Go to a tab that is already open, by its number or by part of its address.',
        SwitchTabInputSchema.shape,
        async (input) => reply(await request.handlers.switchTab(input))
      ),
      tool(
        'openUrl',
        'Go to an address that is not open yet. This sends a request out to the internet and cannot be undone.',
        OpenUrlInputSchema.shape,
        async (input) => reply(await request.handlers.openUrl(input))
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
      /**
       * The URL gate — the one place a *widening* of this vocabulary is
       * policed rather than merely described.
       *
       * Here rather than only in the handler for the same reason the stop is
       * here: this runs before the handler is entered, so a call the model has
       * already emitted never reaches the machine. The handler checks again,
       * and both checks read the same pure function.
       *
       * `interrupt` is deliberately *not* set. A refused URL is a correction
       * the next turn can act on — take the query string off, or go to the
       * plain address — where the stop is an ending. Ending the run over a
       * malformed address would turn a fixable mistake into a failed task.
       */
      if (name === OPEN_URL) {
        const asked = (input as { url?: unknown }).url
        const gate = request.urlGate ?? ((url: string) => checkUrl(url))
        const verdict = typeof asked === 'string' ? gate(asked) : { ok: false, because: 'openUrl needs a url' }
        if (!verdict.ok) {
          request.log?.('warn', 'agent: refused a url', { url: asked, because: verdict.because })
          return { behavior: 'deny', message: verdict.because }
        }
      }
      /**
       * The menu gate — the second one, and the one that carries more.
       *
       * The URL gate above narrows a widening. This one holds a property the
       * rest of the vocabulary gets for free: **nothing here can send.** That
       * used to be a fact about `AgentKeySchema` having no Return in it, and a
       * menu bar routes straight around a keystroke closure — Mail sends from a
       * menu, so does Slack. See `checkMenuCommand`.
       *
       * Refused without `interrupt`, like a bad URL and unlike the stop: the
       * model has plenty of legitimate commands left and "not that one" is a
       * correction it can act on. Ending the run would turn a guard into a
       * failure.
       */
      if (name === CHOOSE_MENU) {
        const asked = input as { menu?: unknown; name?: unknown }
        const verdict =
          typeof asked.menu === 'string' && typeof asked.name === 'string'
            ? checkMenuCommand(asked.menu, asked.name)
            : { ok: false, because: 'chooseMenu needs a menu and a name' }
        if (!verdict.ok) {
          request.log?.('warn', 'agent: refused a menu command', {
            menu: asked.menu,
            name: asked.name,
            because: verdict.because
          })
          return { behavior: 'deny', message: verdict.because }
        }
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

/** All fifteen, by the full MCP names `canUseTool` is actually handed. */
const OURS: ReadonlySet<string> = new Set(AGENT_TOOLS.map(toolName))

/** The one that reaches the network, spelled the way the gate is handed it. */
const OPEN_URL = toolName('openUrl')

/** The one that could send, if it were not gated. Same spelling, same reason. */
const CHOOSE_MENU = toolName('chooseMenu')

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
