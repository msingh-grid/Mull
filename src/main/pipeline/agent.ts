import { randomUUID } from 'node:crypto'
import type { ScreenContext } from '@shared/context'
import type { PlanCard, PlanStep } from '@shared/hud'
import type { HudLastAction } from '@shared/ipc'
import type { JournalDraft, JournalStatus } from '@shared/types'
import type { SidecarApi, UiTarget } from '@shared/sidecar-api'
import { MAX_AGENT_TURNS } from '@shared/agent'
import type { Engine } from '../engine/types'
import type { AgentRunResult } from '../engine/agent-loop'
import type { JournalStore } from '../store/journal'
import type { CaptureStore } from '../store/captures'
import { Trace } from '../trace'
import type { ActionExecutor, Scan } from './actions'
import {
  find,
  look,
  note,
  press,
  setText,
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
 *   restore        always, however the run ended
 *   the journal    one row per act, grouped under one row for the run
 *   the answer     a separate turn, in a different voice — see below
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

export interface AgentRequest {
  goal: string
  transcript: string
  app: { bundleId: string; name: string } | null
  /** What was on screen when the user spoke. The first turn's evidence. */
  context?: ScreenContext | null
  routedBy?: string
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
    handlers: {
      look(input: { want: 'text' | 'targets' | 'both' }): Promise<string>
      find(input: { query: string; kind?: 'press' | 'type' }): Promise<string>
      press(input: { index: number; expectTitle: string }): Promise<string>
      setText(input: { index: number; expectTitle: string; text: string }): Promise<string>
      note(input: { text: string }): Promise<string>
      done(input: { found: boolean; because: string }): Promise<string>
    }
    stopped: () => boolean
  }) => Promise<AgentRunResult>
  hud: {
    openCard(card: PlanCard, onAction: (action: 'apply' | 'apply-send' | 'cancel') => void): void
    updateCard(card: PlanCard): void
    closeCard(): void
    update?(patch: { stage: string | null; stageAt: number | null }): void
    announce?(
      phase: 'applied' | 'error' | 'blocked',
      notice: string,
      lastAction?: HudLastAction
    ): void
  }
  journal?: JournalStore
  captures?: CaptureStore
  onJournalChanged?: () => void
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
   * Put the proposal on screen. Nothing moves until the user presses Run.
   *
   * The card cannot list the steps in advance any more — the model decides them
   * as it goes — so it names the goal, the app and the budget, and Run approves
   * those. That is what Run always actually approved; the old card merely looked
   * as though it were promising more.
   */
  async propose(request: AgentRequest): Promise<void> {
    const origin = await this.where()
    this.stopped = false
    const parent = this.deps.trace?.() ?? new Trace({ log: this.deps.log })
    parent.step('agent.propose', {
      goal: request.goal,
      app: origin.app?.name,
      window: origin.windowTitle
    })

    const card = (patch: Partial<PlanCard> = {}): PlanCard => ({
      kind: 'plan',
      steps: [],
      context: null,
      goal: request.goal,
      app: request.app?.name ?? origin.app?.name ?? null,
      limit: MAX_AGENT_TURNS,
      note: 'read-only · nothing is written or sent',
      running: false,
      // Run starts something that reports back onto this card. Without it the
      // card closes on the press and takes Escape with it.
      startsRun: true,
      ...patch
    })

    let started = false

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
      if (action !== 'apply' || started) return
      started = true
      const trace = parent.fork()
      trace.step('agent.run', { goal: request.goal })
      void this.walk(request, origin, card, trace).catch((err) => {
        trace.fail('agent.threw', {}, err)
        this.deps.hud.closeCard()
        this.deps.hud.announce?.(
          'error',
          `The run stopped: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    })
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
    let note_ = 'read-only · nothing is written or sent'
    let answer: string | null = null
    /** What the model said when it finished, and whether it got there. */
    let ending: { found: boolean; because: string } | null = null
    /**
     * Read it without letting control-flow analysis narrow it away.
     *
     * `ending` is only ever assigned inside the `done` handler, which is a
     * closure, so TypeScript narrows the variable to its initialiser and types
     * every later read as `never`. A call's result is not narrowed. The same
     * trap `scripts/probe-router.ts` documents, and the same way out.
     */
    const finished = (): { found: boolean; because: string } | null => ending

    const draw = (): void =>
      this.deps.hud.updateCard(card({ steps: [...steps], running: true, note: note_, answer }))
    const stage = (text: string | null): void =>
      this.deps.hud.update?.({ stage: text, stageAt: text ? Date.now() : null })
    draw()

    const context: ToolContext = {
      sidecar: this.deps.sidecar,
      executor: this.deps.executor,
      plan: { app: request.app, goal: request.goal, groupId },
      stopped: () => this.stopped,
      scan: null,
      pressed: null,
      read: request.context ?? null,
      steps: 0,
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
      trace.step(`act.${verb}`, { n: steps.length, detail: outcome.detail, ok: outcome.ok !== false })
      draw()
      return outcome.text
    }

    await this.sleep(SETTLE_MS)

    let result: AgentRunResult
    try {
      result = await this.deps.run({
        goal: request.goal,
        app: request.app,
        context: request.context ?? null,
        stopped: () => this.stopped,
        handlers: {
          look: (input) =>
            act('look', input.want, () => look(context, input, this.sleep)),
          find: (input) =>
            act('find', `“${input.query}”`, () => find(context, input, this.sleep)),
          press: (input) =>
            act('press', `“${input.expectTitle}”`, () => press(context, input)),
          setText: (input) =>
            // The text on the card rather than the field name: a write is the
            // one act where what went in matters more than where it went, and
            // it is the only thing a watching user can check.
            act('type', `“${input.text}” → ${input.expectTitle}`, () => setText(context, input)),
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
          { goal: request.goal, context: context.read },
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

    // Always. After a finished run, a stopped one and a failed one alike.
    stage('putting the window back')
    const back = await this.deps.executor
      .restore(origin, await this.scan())
      .catch((err) => {
        trace.fail('agent.restore.threw', {}, err)
        return { ok: false, detail: 'could not put the window back' }
      })
    stage(null)
    trace.step('agent.restore', { ok: back.ok, detail: back.detail })

    // The card has settled into the `wont` family by now, so the promise
    // under it is a flat statement of fact rather than an undo path.
    const closing = answer
      ? `Nothing was written · ${back.detail}`
      : `${note_} · ${back.detail}`
    this.deps.hud.updateCard(
      card({ steps: [...steps], running: false, note: closing, answer })
    )

    const arrived = answer !== null && arrivedAt
    const entry = this.record(request, {
      id: groupId,
      status: result.ended === 'stopped' ? 'cancelled' : arrived ? 'applied' : 'failed',
      answer,
      summary: arrived ? `Looked · ${request.goal}` : `Looked · ${request.goal} · ${note_}`,
      steps: steps.length,
      ms: Date.now() - startedAt,
      because: note_,
      turns: result.turns,
      costUsd: result.costUsd
    })

    this.deps.hud.announce?.(arrived ? 'applied' : 'error', answer ?? `${note_} · ${back.detail}`, {
      summary: `Looked · ${request.app?.name ?? 'this app'} · “${request.goal}”`,
      at: Date.now(),
      chars: answer?.length ?? 0,
      entryId: entry?.id ?? null,
      // Nothing was written anywhere, and the window has already been put back.
      undoable: false,
      result: answer ?? note_
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
