import { randomUUID } from 'node:crypto'
import type { ScreenContext } from '@shared/context'
import type { PlanCard, PlanStep } from '@shared/hud'
import type { HudLastAction } from '@shared/ipc'
import type { JournalDraft, JournalStatus } from '@shared/types'
import type { SidecarApi, UiTarget } from '@shared/sidecar-api'
import { MAX_AGENT_TURNS, checkUrl, type AgentKey } from '@shared/agent'
import type { AppsBridge } from '../services/apps'
import type { MenusBridge } from '../services/menus'
import type { BrowserBridge } from '../services/browser'
import type { Engine } from '../engine/types'
import type { AgentRunResult } from '../engine/agent-loop'
import type { JournalStore } from '../store/journal'
import type { CaptureStore } from '../store/captures'
import { Trace } from '../trace'
import { describeSteps, type RecentTurn, type TurnOutcome } from '../services/turns'
import { MAX_SKILLS_PER_APP, type LearnedSkill, type SkillRecord } from '@shared/skills'
import type { ActionExecutor, Scan } from './actions'
import {
  apps,
  chooseMenu,
  find,
  key,
  look,
  menus,
  note,
  openUrl,
  press,
  scrollTo,
  setText,
  switchApp,
  switchTab,
  tabs,
  type ToolContext,
  type ToolOutcome
} from './agent-tools'

/**
 * Going to look somewhere else, and coming back — with the model driving.
 *
 * The same job as `NavigateLane` and the opposite arrangement. There, Mull runs
 * the loop and the model answers a questionnaire: a fresh `<screen>`,
 * `<targets>` and `<history>` every turn, one line of JSON back, no memory
 * between them. Here the model runs and Mull holds the tools — so the things
 * that had to be *told* to the navigator every turn it can now go and *find
 * out*, and what it learns on the way stays learned.
 *
 * Everything around the loop is unchanged, deliberately, because none of it was
 * the problem:
 *
 *   the card       a proposal until Run, then the transcript of what happened
 *   Escape         stops it between any two acts, and the card says so
 *   restore        on every run that did not finish — see below
 *   the journal    one row per act, grouped under one row for the run
 *   the answer     a separate turn, in a different voice — see below
 *
 * ### The one that stopped being unconditional
 *
 * `restore` ran on every exit path, always, and that was right while a run could
 * only fetch something and come back. `switchApp` ended it: "open Slack" is a
 * goal whose whole content is *be in Slack*, and a run that opened Slack and
 * then put Zed back did nothing at all while the screen flickered twice.
 *
 * So a run that **finished** may stay, and says so through `done({stay})`; a run
 * that was stopped, ran out of turns or money, hung or threw still restores
 * unconditionally. See the decision in `walk`, which is written out there
 * because the ordering of its three rules is the whole of it.
 *
 * ### Why `done` does not carry the answer
 *
 * It would be one fewer turn, and it would be wrong. `ANSWER_SYSTEM_PROMPT`
 * exists because walking and reporting are opposite jobs: one moves around a
 * window and emits machine-readable decisions, the other talks to the user about
 * what it found and must say plainly when the window did not answer the
 * question. Asking the same session to do both means sending whichever system
 * prompt is not wanted. So the run ends, and then `engine.answer` reads what the
 * last `look` captured.
 */

/** How long to let a freshly-activated window settle before the first look. */
const SETTLE_MS = 250

/**
 * Below this, a run that arrived without stumbling had nothing to discover.
 *
 * Provisional, and said out loud rather than dressed up: it is set off three
 * live runs — 8 turns clean and nothing to teach, 12 turns clean and a lesson
 * that went on to earn its place, 31 turns with a failure. Ten sits between the
 * first two, which is the most that can honestly be claimed from three points.
 * `npm run probe:skills` is what should replace it. See the gate in `remember`.
 */
export const QUIET_TURNS = 10

export interface AgentRequest {
  goal: string
  transcript: string
  app: { bundleId: string; name: string } | null
  /** What was on screen when the user spoke. The first turn's evidence. */
  context?: ScreenContext | null
  routedBy?: string
  /**
   * Whisper was not sure it heard this. Enough to refuse `settings.autoRun`.
   *
   * The doubt and the switch answer each other: the low-confidence notice says
   * "check before running", and auto-run is precisely what would take the
   * checking away. So a doubtful transcript still opens a card and still waits
   * — one press, on the utterance where the press is worth something.
   */
  unsure?: boolean
  /**
   * What the user was doing just before this, and what came of it.
   *
   * The half a goal string cannot carry. "And what about Priya" arrives here
   * already expanded, but *that the last run walked this same route and came
   * back with nothing* is not in the expansion — and without it the second
   * attempt is the first attempt again.
   *
   * Read as evidence, never as instruction: it holds prior model output about
   * prior windows, and `AGENT_SYSTEM_PROMPT` names it in the same paragraph as
   * the screen for that reason.
   */
  recent?: RecentTurn[] | null
}

/** What the lane needs to run one goal. Mirrors `NavigateDeps`. */
export interface AgentDeps {
  sidecar: SidecarApi
  engine: Engine
  executor: ActionExecutor
  /**
   * The loop. Injected rather than imported so the lane can be tested without a
   * subprocess — and so an engine that cannot run one is simply not given this.
   */
  run: (request: {
    goal: string
    app: { bundleId: string; name: string } | null
    context?: ScreenContext | null
    recent?: RecentTurn[] | null
    handlers: {
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
    stopped: () => boolean
    urlGate?: (url: string) => { ok: boolean; because: string }
    skills?: readonly { kind: 'do' | 'avoid'; text: string }[] | null
  }) => Promise<AgentRunResult>
  hud: {
    openCard(card: PlanCard, onAction: (action: 'apply' | 'apply-send' | 'cancel') => void): void
    updateCard(card: PlanCard): void
    closeCard(): void
    update?(patch: { stage: string | null; stageAt: number | null }): void
    announce?(
      phase: 'applied' | 'error' | 'blocked',
      notice: string,
      lastAction?: HudLastAction,
      /** What the run did, for the memory the next utterance is read against. */
      turn?: TurnOutcome
    ): void
  }
  /**
   * The browser's tab model, when this machine has one to offer.
   *
   * Optional, and absent is a supported state rather than a broken one: the
   * three browser tools then refuse in a sentence and the rest of the run is
   * exactly as it was. That is also what a user who has declined the Automation
   * prompt gets, so the path is worth having rather than asserting away.
   */
  browser?: BrowserBridge | null
  /**
   * What else is running, when this machine will say.
   *
   * Absent exactly as `browser` is, and the run degrades the same way: `apps`
   * and `switchApp` refuse in a sentence, the loop works in one window, and
   * nothing else changes. That is what a user who has declined the System Events
   * consent dialog gets.
   */
  apps?: AppsBridge | null
  /**
   * The front application's own command surface, when this machine will say.
   *
   * The same System Events consent as `apps`, so the two arrive and depart
   * together, and absent means the same thing here as everywhere else: `menus`
   * and `chooseMenu` refuse in a sentence and the run works from the window.
   */
  menus?: MenusBridge | null
  journal?: JournalStore
  captures?: CaptureStore
  onJournalChanged?: () => void
  /**
   * `settings.autoRun`, read per proposal rather than at boot — it is a toggle
   * on the HUD itself, armed in the second before the key goes down, so the
   * answer can be different for the next utterance than it was for this one.
   */
  autoRun?: () => boolean
  /**
   * The notebook: what previous runs learned about the application this one is
   * about to work in.
   *
   * A port rather than the store, so the lane can be tested with no database —
   * and so that "learning is switched off" is expressed by not supplying it,
   * beside `useSkills` which expresses "switched off right now".
   *
   * Everything it returns is a hint. Nothing it returns widens the vocabulary,
   * the known apps, the known menus or the URL gate; see `@shared/skills`.
   */
  skills?: {
    forApp(bundleId: string | null | undefined, limit?: number): SkillRecord[]
    learn(app: { bundleId: string; name?: string | null }, items: readonly LearnedSkill[], fromGroup?: string | null): void
    markUsed(ids: readonly string[]): void
    credit(ids: readonly string[], verdict: 'win' | 'loss'): void
  }
  /**
   * `settings.skills`, read per run rather than at boot — the same treatment
   * `autoRun` gets, and for the same reason: a switch that only takes effect
   * next launch is a switch people stop believing.
   */
  useSkills?: () => boolean
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  sleep?: (ms: number) => Promise<void>
  trace?: () => Trace
}

export class AgentLane {
  private readonly sleep: (ms: number) => Promise<void>
  /** Set when the user presses Escape. Read before every act, by the loop. */
  private stopped = false

  constructor(private readonly deps: AgentDeps) {
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Put the proposal on screen. Nothing moves until the user presses Run —
   * unless `settings.autoRun` is on, in which case the card opens already
   * walking and esc is the whole of the user's control over it.
   *
   * The card cannot list the steps in advance any more — the model decides them
   * as it goes — so it names the goal, the app and the budget, and Run approves
   * those. That is what Run always actually approved; the old card merely looked
   * as though it were promising more, and it is why the switch is defensible:
   * what the press approved is printed on a card that stays up either way.
   */
  async propose(request: AgentRequest): Promise<void> {
    const origin = await this.where()
    this.stopped = false
    const parent = this.deps.trace?.() ?? new Trace({ log: this.deps.log })
    /** Read once, so the card and the walk cannot disagree mid-proposal. */
    const auto = this.deps.autoRun?.() === true && request.unsure !== true
    parent.step('agent.propose', {
      goal: request.goal,
      app: origin.app?.name,
      window: origin.windowTitle,
      auto: auto || undefined,
      heldForDoubt: (this.deps.autoRun?.() === true && request.unsure === true) || undefined
    })

    const card = (patch: Partial<PlanCard> = {}): PlanCard => ({
      kind: 'plan',
      steps: [],
      context: null,
      goal: request.goal,
      app: request.app?.name ?? origin.app?.name ?? null,
      limit: MAX_AGENT_TURNS,
      // What Run is actually approving, in the terms the vocabulary can still
      // guarantee — and it has been narrowed three times now. "read-only" went
      // when `setText` shipped, "nothing is opened" went with the tab tools,
      // and "stays in this window" went with `switchApp`. What did not move is
      // the one clause worth putting under the button: `AgentKeySchema` has no
      // Return in it, so nothing a run does can submit anything.
      note: 'moves between apps, clicks and types · nothing is submitted',
      running: false,
      // Run starts something that reports back onto this card. Without it the
      // card closes on the press and takes Escape with it.
      startsRun: true,
      auto,
      ...patch
    })

    let started = false

    /**
     * Begin the walk. One function because there are now two ways in — the
     * press and the setting — and they must not be two slightly different
     * starts. `started` is the guard for both: a second apply delivered into
     * an auto-run already in flight has to be a no-op, not a second walker.
     */
    const start = (): void => {
      if (started) return
      started = true
      const trace = parent.fork()
      trace.step('agent.run', { goal: request.goal, auto: auto || undefined })
      void this.walk(request, origin, card, trace).catch((err) => {
        trace.fail('agent.threw', {}, err)
        this.deps.hud.closeCard()
        this.deps.hud.announce?.(
          'error',
          `The run stopped: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }

    this.deps.hud.openCard(card(), (action) => {
      if (action === 'cancel') {
        this.stopped = true
        if (started) {
          // A stop, not a decline. `walk` is still running, still has a window
          // to put back, and still owes a row for the acts that did happen.
          parent.step('agent.stopped', { byUser: true })
          return
        }
        parent.step('agent.cancelled', { beforeRunning: true })
        this.deps.hud.closeCard()
        this.record(request, {
          status: 'cancelled',
          answer: null,
          summary: `Declined · ${request.goal}`,
          steps: 0
        })
        this.deps.hud.announce?.('applied', 'Cancelled — nothing was pressed.')
        return
      }
      if (action !== 'apply') return
      start()
    })

    // After `openCard`, never before: the card is where the run reports, and a
    // walk that began against no card would draw into nothing and leave esc
    // pointing at the application being driven.
    if (auto) start()
  }

  // -------------------------------------------------------------------------

  private async walk(
    request: AgentRequest,
    origin: { app: { bundleId: string; name: string } | null; windowTitle: string | null },
    card: (patch?: Partial<PlanCard>) => PlanCard,
    trace: Trace
  ): Promise<void> {
    const steps: PlanStep[] = []
    /** Made before the first act, so every row can be stamped with it. */
    const groupId = randomUUID()
    const startedAt = Date.now()
    /**
     * Is the notebook armed for this run? Read once, so the read at the start
     * and the write at the end cannot disagree — a run that was shown notes and
     * then declined to be credited would quietly corrupt the scoring.
     */
    const learning = this.deps.skills !== undefined && this.deps.useSkills?.() !== false
    /**
     * Every note put in front of the model, wherever it came from.
     *
     * Shared with `ToolContext` rather than owned here, because `switchApp`
     * hands over the destination app's notes mid-run and those have to be
     * credited too. A list the tools append to is the only arrangement where
     * "what was shown" stays true across a switch.
     */
    const shown: SkillRecord[] = []
    let note_ = 'moves between apps, clicks and types · nothing is submitted'
    let answer: string | null = null
    /** What the model said when it finished, and whether it got there. */
    let ending: { found: boolean; because: string; stay?: boolean } | null = null
    /**
     * Read it without letting control-flow analysis narrow it away.
     *
     * `ending` is only ever assigned inside the `done` handler, which is a
     * closure, so TypeScript narrows the variable to its initialiser and types
     * every later read as `never`. A call's result is not narrowed. The same
     * trap `scripts/probe-router.ts` documents, and the same way out.
     */
    const finished = (): { found: boolean; because: string; stay?: boolean } | null => ending

    const draw = (): void =>
      this.deps.hud.updateCard(card({ steps: [...steps], running: true, note: note_, answer }))
    const stage = (text: string | null): void =>
      this.deps.hud.update?.({ stage: text, stageAt: text ? Date.now() : null })
    draw()

    const context: ToolContext = {
      sidecar: this.deps.sidecar,
      executor: this.deps.executor,
      /**
       * `?? origin.app` is new, and it is `switchApp` forcing the question.
       *
       * This used to be `request.app` alone — what the utterance was routed
       * against — which was defensible while a run could only ever act in one
       * window. It is not any more: `switchApp` moves this, so from the first
       * switch onward every row names the application the press actually landed
       * in, and a run that began with no routed app would have filed its early
       * rows against nothing and its later ones against somewhere real. One
       * column meaning two different things is how a journal stops being
       * evidence.
       */
      plan: { app: request.app ?? origin.app, goal: request.goal, groupId },
      stopped: () => this.stopped,
      scan: null,
      pressed: null,
      read: request.context ?? null,
      steps: 0,
      browser: this.deps.browser ?? null,
      apps: this.deps.apps ?? null,
      menus: this.deps.menus ?? null,
      // Where the hands are. This used to be the one thing `plan.app` was not —
      // now `switchApp` moves both, because a press that landed in Calendar
      // recorded against Slack would make the journal a worse record than none.
      front: origin.app ?? request.app,
      knownHosts: new Set<string>(),
      /**
       * Seeded with where the run started, so `switchApp` can always come back
       * to it without an `apps` call standing between the run and its own
       * origin. Everything else has to be earned by looking.
       */
      knownApps: new Map<string, string>(
        origin.app ? [[origin.app.bundleId, origin.app.name]] : []
      ),
      /**
       * The notebook, so `switchApp` can hand over the destination's notes.
       *
       * The lane cannot do that itself: it reads the notebook once, before the
       * loop, when the only app it can name is the one the user is standing in.
       * A goal like "go to Slack and…" is exactly the case where the useful
       * notes are somewhere the run has not been yet, and the tool result that
       * puts it there is the first moment anyone can say so.
       */
      ...(learning ? { skills: this.deps.skills } : {}),
      shown,
      amend: (entryId, evidence) =>
        this.deps.journal?.amend(entryId, { detail: { evidence } }),
      ...(this.deps.log ? { log: this.deps.log } : {})
    }

    /** One card row per act, marked as it resolves. */
    const act = async (
      verb: string,
      object: string,
      run: () => Promise<ToolOutcome> | ToolOutcome
    ): Promise<string> => {
      const id = `act-${steps.length}`
      steps.push({ id, verb, object, state: 'running' })
      stage(`${verb} ${object}`)
      draw()
      const outcome = await run()
      const shown = steps.find((candidate) => candidate.id === id)
      if (shown) {
        shown.state = outcome.ok === false ? 'failed' : 'done'
        if (outcome.detail) shown.object = outcome.detail
      }
      trace.step(`act.${verb}`, {
      n: steps.length,
      // `trace` for the two acts that keep `detail` empty on purpose. See
      // `ToolOutcome.trace`.
      detail: outcome.trace ?? outcome.detail,
      ok: outcome.ok !== false
    })
      draw()
      return outcome.text
    }

    await this.sleep(SETTLE_MS)

    /**
     * What previous runs learned about the application this one starts in.
     *
     * Read here, at the last moment before the loop starts, rather than at
     * propose time: a card can sit on screen for a while, and the notebook is
     * written by other runs. `markUsed` is called on whatever was actually put
     * in front of the model, so the counters describe what was shown rather
     * than what was looked up.
     *
     * Keyed off `context.front` — where the hands are — rather than
     * `request.app`, which is only where the *utterance* was routed. They agree
     * at this point in a run and stop agreeing the moment `switchApp` fires,
     * which is why `shown` below is a list the tools can add to rather than
     * this array.
     */
    const learned = learning ? (this.deps.skills?.forApp(context.front?.bundleId) ?? []) : []
    if (learned.length > 0) {
      this.deps.skills?.markUsed(learned.map((skill) => skill.id))
      trace.step('agent.learned', { n: learned.length })
    }
    shown.push(...learned)

    let result: AgentRunResult
    try {
      result = await this.deps.run({
        goal: request.goal,
        app: request.app,
        context: request.context ?? null,
        recent: request.recent ?? null,
        skills: learned,
        stopped: () => this.stopped,
        /**
         * The gate `canUseTool` consults before `openUrl` runs.
         *
         * A closure over `context.knownHosts` rather than a snapshot, because
         * the set grows during the run: a host becomes freely addressable the
         * moment `tabs` shows the agent it was already open. Passing the set
         * itself would have frozen it at whatever it held at turn one.
         */
        urlGate: (url) => checkUrl(url, context.knownHosts ?? new Set()),
        handlers: {
          look: (input) =>
            act('look', input.want, () => look(context, input, this.sleep)),
          find: (input) =>
            act('find', `“${input.query}”`, () => find(context, input, this.sleep)),
          press: (input) =>
            act('press', `“${input.expectTitle}”`, () => press(context, input, this.sleep)),
          setText: (input) =>
            // The text on the card rather than the field name: a write is the
            // one act where what went in matters more than where it went, and
            // it is the only thing a watching user can check.
            act('type', `“${input.text}” → ${input.expectTitle}`, () => setText(context, input)),
          key: (input) =>
            act(
              'key',
              input.times && input.times > 1 ? `${input.key} ×${input.times}` : input.key,
              () => key(context, input, this.sleep)
            ),
          scrollTo: (input) =>
            act('show', input.expectTitle, () => scrollTo(context, input, this.sleep)),
          apps: () => act('apps', 'what’s running', () => apps(context)),
          /**
           * The model's own reason, on the card, before the screen moves.
           *
           * `act` draws the row and *then* awaits the handler, which everywhere
           * else in this table is an implementation detail and here is the whole
           * point: this is the one act the user watches happen to their own
           * display, and a switch they can read a reason for is an errand rather
           * than a malfunction. `AGENT-V2.md` §11 names this as the difference
           * between a visible agent that feels intentional and one that feels
           * broken, and it costs a string.
           *
           * The bundle id is deliberately not here. It is what the *tool* needs;
           * the user needs to know where their screen went and why.
           */
          switchApp: (input) => act('go to', input.because, () => switchApp(context, input, this.sleep)),
          menus: (input) =>
            act('menus', input.query ? `“${input.query}”` : 'what this app can do', () =>
              menus(context, input)
            ),
          /**
           * The model's reason, before the command runs — the same argument
           * `switchApp` makes one row above, for a wider act.
           *
           * The command's own path goes on the row as well as the reason, and
           * that is a departure from `switchApp`, where the destination was left
           * off because the user can see where their screen went. Here they
           * cannot: a menu command is a flicker, and "File ▸ New Event" is the
           * only record of what was actually chosen that appears anywhere the
           * user is looking.
           */
          chooseMenu: (input) =>
            act('menu', `${input.menu} ▸ ${input.name} — ${input.because}`, () =>
              chooseMenu(context, input, this.sleep)
            ),
          tabs: () => act('tabs', 'what’s open', () => tabs(context)),
          switchTab: (input) =>
            act(
              'tab',
              input.index !== undefined ? `#${input.index}` : `“${input.urlContains ?? ''}”`,
              () => switchTab(context, input)
            ),
          // The address, in full, before anything is fetched. This is the only
          // act in a run that reaches off the machine, and the row saying so is
          // the user's one chance to see it going.
          openUrl: (input) => act('open', input.url, () => openUrl(context, input)),
          note: (input) => act('note', input.text, () => note(context, input)),
          done: async (input) => {
            ending = input
            return 'ok'
          }
        }
      })
    } catch (err) {
      // Never allowed to escape: the restore, the row and the announce below are
      // how a run ends, and a window left wherever the loop got to with nothing
      // recording that it went is the one outcome worth any amount of ugliness
      // to avoid.
      trace.fail('agent.run.threw', {}, err)
      result = {
        ended: 'error',
        turns: steps.length,
        costUsd: 0,
        detail: err instanceof Error ? err.message : String(err)
      }
    }

    trace.step('agent.ended', { ended: result.ended, turns: result.turns, usd: result.costUsd })
    note_ = endingNote(result, finished(), steps.length)

    // Say what was found. The last turn, and the only one the user reads as
    // prose — everything above it is Mull moving around, which is means.
    const arrivedAt = finished()?.found === true
    if (arrivedAt && context.read && result.ended !== 'stopped') {
      const answerMs = trace.mark()
      stage('reading what it found')
      try {
        const said = await this.deps.engine.answer(
          {
            goal: request.goal,
            context: context.read,
            // What was actually done, so this turn does not have to infer it
            // from a window that may have read badly. See `AnswerRequest.did`.
            did: steps
              .filter((step) => step.state !== 'running')
              .map((step) => ({
                verb: step.verb,
                object: step.object,
                ok: step.state !== 'failed'
              }))
          },
          (partial) => {
            answer = partial
            draw()
          }
        )
        answer = said.text.trim() || null
        trace.step('answer.done', { ms: answerMs(), chars: answer?.length ?? 0 })
      } catch (err) {
        trace.fail('answer.failed', { ms: answerMs() }, err)
        this.deps.log?.('warn', 'agent: could not say what it found', err)
        note_ = `got there, but couldn’t summarise what it read`
      }
      draw()
    }

    /**
     * Stay, or put the window back?
     *
     * This used to have no question in it — `restore` ran on every exit path,
     * always, and that was correct while every run was an errand. `switchApp`
     * made it wrong half the time: "open Slack" is a goal whose whole content is
     * *be in Slack*, and a run that opened Slack and then restored Zed did
     * nothing at all while the screen flickered twice.
     *
     * Three rules, in order, and the ordering is the point:
     *
     * 1. **A run that did not finish always restores.** Stopped, out of turns,
     *    out of money, hung, thrown. The user did not get what they asked for,
     *    so leaving them somewhere they did not choose adds insult — and a
     *    half-finished run has no standing to say where anybody should be.
     * 2. **Otherwise the model decides**, because it is the only thing that read
     *    the goal and knows whether being here was the errand or the point.
     * 3. **If it did not say**, guess from what happened: a run that moved and
     *    has nothing to tell you was a destination. A run with an answer was a
     *    question, and the answer goes to the user where the user was.
     */
    const moved = steps.some((step) => MOVED.has(step.verb))
    const staying =
      result.ended === 'done' && (finished()?.stay ?? (moved && answer === null))
    trace.step('agent.ending', { staying, moved, said: finished()?.stay ?? null })

    stage(staying ? null : 'putting the window back')
    const back = staying
      ? { ok: true, detail: `left in ${context.front?.name ?? 'the app it opened'}` }
      : await this.deps.executor.restore(origin, await this.scan()).catch((err) => {
          trace.fail('agent.restore.threw', {}, err)
          return { ok: false, detail: 'could not put the window back' }
        })
    stage(null)
    trace.step('agent.restore', { ok: back.ok, detail: back.detail, skipped: staying })

    /**
     * The card has settled into the `wont` family by now, so the promise under
     * it is a flat statement of fact rather than an undo path.
     *
     * Which fact depends on what the run actually did. This used to say
     * "Nothing was written" unconditionally whenever there was an answer, which
     * was a promise rather than a report — a run that typed into three fields
     * and then read something said it had written nothing. So it now reads the
     * steps, and says the thing that happened.
     */
    const changed = steps.some((step) => WROTE.has(step.verb))
    const closing = answer
      ? `${changed ? 'What it typed is still there' : 'Nothing was written'} · ${back.detail}`
      : `${note_} · ${back.detail}`
    this.deps.hud.updateCard(
      card({ steps: [...steps], running: false, note: closing, answer })
    )

    /**
     * Did it do what was asked?
     *
     * `answer !== null` used to be half of this, and it quietly meant *every*
     * successful errand produced prose. Once `switchApp` existed that became a
     * bug with a plain symptom: "open Slack" worked, put Slack in front, said
     * `found: true`, wrote no answer because there was no question — and was
     * filed as **failed** and announced as an **error**.
     *
     * So arrival now means one of two things, and which one depends on the shape
     * of the goal rather than on whether prose came out: an errand arrives by
     * having something to say, and a destination arrives by being there.
     */
    const arrived = arrivedAt && (answer !== null || staying)
    const did = staying ? 'Opened' : 'Looked'
    const entry = this.record(request, {
      id: groupId,
      status: result.ended === 'stopped' ? 'cancelled' : arrived ? 'applied' : 'failed',
      answer,
      summary: arrived ? `${did} · ${request.goal}` : `${did} · ${request.goal} · ${note_}`,
      steps: steps.length,
      ms: Date.now() - startedAt,
      because: note_,
      turns: result.turns,
      costUsd: result.costUsd
    })

    this.deps.hud.announce?.(arrived ? 'applied' : 'error', answer ?? `${note_} · ${back.detail}`, {
      summary: `${did} · ${request.app?.name ?? 'this app'} · “${request.goal}”`,
      at: Date.now(),
      chars: answer?.length ?? 0,
      entryId: entry?.id ?? null,
      // Nothing was written anywhere. The window was put back, unless the point
      // of the run was to be somewhere — and ⌥Z does not walk back an app
      // switch either way, which is why this stays false rather than becoming
      // conditional.
      undoable: false,
      result: answer ?? note_
    },
    /**
     * The route, for the next thing the user says.
     *
     * The announce is the single funnel every lane's ending passes through, so
     * it is also where the turn closes (`dictation.ts`) — and this lane is the
     * one with something worth adding to it. "It already went to Slack, found
     * Priya and came back with nothing" is what stops the follow-up from being
     * answered by repeating the walk that just failed.
     */
    {
      goal: request.goal,
      did: describeSteps(steps),
      ended: result.ended
    })

    /**
     * And then, with nobody waiting, write down anything this taught.
     *
     * Last, deliberately. Everything above it is the run: the window is back,
     * the row is written, the card has settled and the user has their answer.
     * Nothing here can change any of that, which is why it is allowed to be
     * slow, allowed to fail, and never awaited.
     */
    this.remember(request, {
      // **Where the work happened, not where the utterance was routed.**
      //
      // `context.front` is moved by `switchApp`; `request.app` is the window the
      // user was standing in when they spoke. Filing against the latter put a
      // note about Slack's History menu under Zed — shown forever to runs that
      // start in the editor and never to runs in Slack, which is exactly
      // backwards. The lane already learned this once for journal rows
      // (`plan.app`, above); the notebook is the same lesson one function over.
      //
      // A run that worked in two applications is still filed under one: the last
      // one it was in, which is where it read the answer. That is lossy and it
      // is the best signal available from a single field.
      app: context.front ?? request.app ?? origin.app,
      ended: result.ended,
      arrived,
      steps,
      turns: result.turns,
      shown,
      groupId
    })
  }

  /**
   * Credit what was shown, and learn from what happened.
   *
   * Two halves that look alike and are not. The credit is bookkeeping about
   * hints that were already given — cheap, local, and the thing that makes the
   * decay in `SkillStore` mean anything. The distillation is a model call, and
   * it is fired and forgotten: `void`, caught, and silent on failure, because
   * by the time it runs the user has moved on and a notebook that did not grow
   * is exactly where every run started.
   *
   * **A stopped run teaches nothing.** It ended because somebody pressed
   * escape, which is a fact about the person rather than about the
   * application — and crediting it as a loss would punish whatever hints
   * happened to be on screen when they changed their mind.
   */
  private remember(
    request: AgentRequest,
    outcome: {
      app: { bundleId: string; name: string } | null
      ended: AgentRunResult['ended']
      arrived: boolean
      steps: PlanStep[]
      turns: number
      shown: SkillRecord[]
      groupId: string
    }
  ): void {
    const notebook = this.deps.skills
    if (!notebook || this.deps.useSkills?.() === false) return
    if (outcome.ended === 'stopped') return


    if (outcome.shown.length > 0) {
      notebook.credit(
        outcome.shown.map((skill) => skill.id),
        outcome.arrived ? 'win' : 'loss'
      )
    }

    const app = outcome.app
    const distill = this.deps.engine.distill?.bind(this.deps.engine)
    if (!app || !distill) return

    /**
     * Did this run discover anything?
     *
     * The gate, and it is here because asking nicely did not work. The prompt
     * has always said that an empty answer is the right one most of the time,
     * and across the first three live runs it wrote a note every single time —
     * including one that arrived in eight turns and one act, having gone
     * straight to the answer *because* it had been shown the notes already.
     * There was nothing to learn from that run, and a notebook that grows on
     * every run is one nobody can read and the model cannot tell apart.
     *
     * So the question is answered before the model is asked, from the shape of
     * the run rather than from its opinion of itself: **a run that arrived,
     * failed at nothing and took few turns went straight there.** A detour, a
     * refusal or a long haul is what leaves something worth writing down.
     *
     * The failure test comes first because it is the honest one — a failed act
     * is a fact about the application, whatever the run's length. `QUIET_TURNS`
     * is the softer half and is a starting point rather than a measurement:
     * three runs is not a sample, and `npm run probe:skills` is the thing that
     * should set it, by running the same goals with the notebook on and off and
     * reporting what each note was worth.
     */
    const stumbled = outcome.steps.some((step) => step.state === 'failed')
    const quiet = outcome.arrived && !stumbled && outcome.turns <= QUIET_TURNS
    if (quiet) {
      this.deps.log?.(
        'info',
        `agent: nothing to learn — went straight there in ${outcome.turns} turns`
      )
      return
    }

    void distill({
      goal: request.goal,
      app,
      ended: outcome.ended,
      arrived: outcome.arrived,
      // Mull's own record of what it did, and the whole of what that turn is
      // shown — never the window. See `engine/skills.ts`.
      steps: outcome.steps
        .filter((step) => step.state !== 'running')
        .map((step) => ({ verb: step.verb, object: step.object, ok: step.state !== 'failed' })),
      /**
       * **The whole notebook for this app, not what this run happened to see.**
       *
       * This used to pass `outcome.shown`, and that was wrong twice over: it is
       * capped at the five notes a run is given, so notes six to twelve were
       * invisible and could be written again; and after a `switchApp` it is
       * whichever app the run *started* in, so a run filing against Slack was
       * shown the editor's notebook and asked not to repeat itself against the
       * wrong list. A turn that cannot see what is already known cannot answer
       * the only question that matters here — is this new?
       */
      known: notebook
        .forApp(app.bundleId, MAX_SKILLS_PER_APP)
        .map((skill) => ({ kind: skill.kind, text: skill.text }))
    })
      .then((items) => {
        if (items.length === 0) return
        notebook.learn(app, items, outcome.groupId)
        this.deps.log?.('info', `agent: learned ${items.length} thing(s) about ${app.name}`)
      })
      .catch((err) => {
        this.deps.log?.('warn', 'agent: could not write down what the run learned', err)
      })
  }

  /**
   * One journal row for the whole run. Never throws — a run that has already
   * happened must not be undone by a failure to write it down.
   */
  private record(
    request: AgentRequest,
    outcome: {
      id?: string
      status: JournalStatus
      answer: string | null
      summary: string
      steps: number
      ms?: number
      because?: string
      turns?: number
      costUsd?: number
    }
  ): { id: string } | null {
    if (!this.deps.journal) return null
    try {
      const id = outcome.id ?? randomUUID()
      const draft: JournalDraft = {
        id,
        intent: {
          kind: 'command',
          verb: 'agent.run',
          args: { goal: request.goal, steps: outcome.steps },
          transcript: request.transcript
        },
        app: request.app,
        before: null,
        after: outcome.answer,
        strategyUsed: null,
        status: outcome.status,
        summary: outcome.summary,
        verified: outcome.answer !== null,
        caret: null,
        undoable: false,
        capture: this.deps.captures?.save(id, request.context) ?? null,
        groupId: id,
        ms: outcome.ms ?? null,
        detail: {
          ...(outcome.because ? { because: outcome.because } : {}),
          ...(outcome.turns !== undefined ? { turns: outcome.turns } : {}),
          // Kept because a loop is the first thing in Mull whose cost is not a
          // fixed number of turns, and "it got expensive" is only visible if
          // somebody wrote it down.
          ...(outcome.costUsd ? { costUsd: outcome.costUsd } : {})
        }
      }
      this.deps.journal.append(draft)
      this.deps.onJournalChanged?.()
      return { id }
    } catch (err) {
      this.deps.log?.('error', 'agent: journal write failed', err)
      return null
    }
  }

  /** Where the user was when they spoke, so `restore` has somewhere to aim. */
  private async where(): Promise<{
    app: { bundleId: string; name: string } | null
    windowTitle: string | null
  }> {
    try {
      const front = await this.deps.sidecar.frontmostApp({})
      return {
        app: front.app ? { bundleId: front.app.bundleId, name: front.app.name } : null,
        windowTitle: front.windowTitle
      }
    } catch {
      return { app: null, windowTitle: null }
    }
  }

  /**
   * One last look, purely so `restore` has a list to find the origin row in.
   *
   * The targets are the point — `restore` presses the sidebar row whose title
   * matches the window the user came from — so this returns the real scan, not
   * a shape with the right fields and an empty list.
   */
  private async scan(): Promise<Scan | null> {
    try {
      const seen = await this.deps.sidecar.uiTargets({ maxTargets: 300, deadlineMs: 2_000 })
      return {
        harvestId: seen.harvestId,
        targets: seen.targets as UiTarget[],
        stoppedBy: seen.stoppedBy
      }
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Card verbs that left something behind.
 *
 * `press` is not here on purpose: pressing is how you move through an app, and
 * almost every press is navigation. Typing leaves text in a box that is still
 * there when the run ends, which is the thing a closing line should say out
 * loud. These are the card's verbs, not the tools' — see the handler table in
 * `walk`, where `setText` becomes `type`.
 */
const WROTE: ReadonlySet<string> = new Set(['type'])

/**
 * Card verbs that left the user somewhere else.
 *
 * Read only when the model did not say whether to stay — a run that moved and
 * had nothing to report was a destination rather than an errand. `tab` is
 * deliberately absent: changing tab inside a browser that was already in front
 * does not move the user between applications, so it is not on its own a reason
 * to skip putting their window back.
 *
 * These are the card's verbs, not the tools', which is why they read `go to`
 * and `open` rather than `switchApp` and `openUrl` — see the handler table in
 * `walk`.
 */
const MOVED: ReadonlySet<string> = new Set(['go to', 'open'])

/**
 * How the run ended, in a clause the user reads on the card.
 *
 * The model's own words when it has any, because "I could not find a
 * conversation with Anil" is worth more than "ran out of turns" — and the budget
 * endings say plainly which budget, because a run that stopped at forty turns
 * and one that stopped at fifty cents want different responses from whoever is
 * reading.
 */
export function endingNote(
  result: AgentRunResult,
  ending: { found: boolean; because: string } | null,
  steps: number
): string {
  switch (result.ended) {
    case 'done':
      return ending?.because ?? 'finished'
    case 'stopped':
      return steps === 0
        ? 'stopped before anything was pressed'
        : `stopped after ${steps} ${steps === 1 ? 'step' : 'steps'} — what was pressed stays pressed`
    case 'turns':
      return ending?.because ?? 'ran out of steps before finding it'
    case 'budget':
      return 'this one was getting expensive, so Mull stopped'
    case 'deadline':
      return 'gave up waiting — nothing was coming back'
    case 'error':
      return result.detail ? `the run failed: ${result.detail}` : 'the run failed'
  }
}
