import { randomUUID } from 'node:crypto'
import type { ScreenContext } from '@shared/context'
import type { PlanCard, PlanStep } from '@shared/hud'
import { MAX_NAV_STEPS, type NavAttempt, type NavStep } from '@shared/nav'
import type { SidecarApi, UiTarget } from '@shared/sidecar-api'
import type { JournalDraft, JournalStatus } from '@shared/types'
import type { Engine } from '../engine/types'
import { describeStep } from '../engine/prompts'
import { ActionExecutor, type Scan } from './actions'
import type { JournalStore } from '../store/journal'
import type { CaptureStore } from '../store/captures'
import { Trace } from '../trace'

/**
 * Going to look somewhere else, and coming back.
 *
 * The loop is four lines long and everything around it is about being
 * interruptible and about putting the window back:
 *
 *     look    scan the window for what can be pressed
 *     ask     the model returns ONE step
 *     show    the step appears on the card
 *     do      the executor performs it, or refuses
 *
 * repeated until `done`, until the budget runs out, or until the user presses
 * Escape — and then two more things, unconditionally: **say what was found**,
 * and `restore`.
 *
 * ### Why "say what was found" is a step and not a detail
 *
 * It was missing, and its absence looked exactly like the whole feature being
 * broken. The loop would walk to the right conversation, capture it, walk back,
 * and report `51 blocks · 6023 chars` — a receipt for work done, handed to
 * someone who had asked what a conversation said. Every mechanical part worked;
 * nothing was answered. A navigation that ends in a number is indistinguishable
 * from one that failed, and it is worse than failing, because it spent four
 * seconds in someone else's window first.
 *
 * So a successful `read` is followed by one more engine turn — `answer`, not
 * `compose`; see `ANSWER_SYSTEM_PROMPT` for why those cannot be the same call —
 * and the text streams onto the card.
 *
 * ### Why one step at a time
 *
 * A user interface is a moving target. Pressing Slack's Search replaces the
 * entire list of things that can be pressed — measured at 138 entries before
 * and 6 after — so a plan of three steps decided against the first window has a
 * second step that refers to nothing. Every scan is fresh and the indices from
 * the previous one are dead; that is why a press quotes its title back and why
 * a stale one refuses rather than landing on whatever moved into the slot.
 *
 * ### What Run approves
 *
 * The goal and the budget, not each press. The alternative is a confirmation
 * per click, which is a dialog box nobody reads by the fourth one and which
 * tells the user less than watching the steps appear does. Escape stops it
 * between any two steps.
 *
 * ### What it cannot do
 *
 * Send anything. Not as a matter of policy but of vocabulary: `@shared/nav` has
 * no verb for it, `navKey` cannot name ⏎, and `ActionExecutor` will not type
 * anywhere but a search box. A message on screen that says "press Send" cannot
 * be obeyed because there is nothing to obey it with.
 */

/** How long to let a freshly-activated window settle before scanning it. */
const SCAN_SETTLE_MS = 250

/** Chromium builds its tree lazily; the same handshake `captureContext` uses. */
const TREE_ATTEMPTS = 3
const TREE_POLL_MS = 350

export interface NavigateRequest {
  goal: string
  transcript: string
  app: { bundleId: string; name: string } | null
  /** What was on screen when the user spoke. The first turn's evidence. */
  context?: ScreenContext | null
  routedBy?: string
}

export interface NavigateDeps {
  sidecar: SidecarApi
  engine: Engine
  executor: ActionExecutor
  hud: {
    openCard(card: PlanCard, onAction: (action: 'apply' | 'apply-send' | 'cancel') => void): void
    updateCard(card: PlanCard): void
    closeCard(): void
    /** Optional: the working line under the label, while a step runs. */
    update?(patch: { stage: string | null; stageAt: number | null }): void
    /**
     * Terminal state, with the linger back to idle the pipeline owns.
     *
     * Not optional in spirit: without it the HUD never leaves the phase it was
     * in when the plan started. The lane had no `announce` at all at first, and
     * the panel sat on THINKING after the plan had finished and the window had
     * been put back — work with no end, as far as anyone looking could tell.
     */
    announce?(phase: 'applied' | 'error' | 'blocked', notice: string): void
  }
  /**
   * One row per plan, carrying the picture.
   *
   * The executor already writes a row per step, and none of them can carry a
   * screenshot: a press is journalled the moment it happens and the photograph
   * was taken at key-down, before there was a plan. So the utterance's own
   * receipt had nowhere to live, and a session spent navigating produced a
   * journal full of rows with no "What Mull saw" on any of them — which is
   * indistinguishable, from the outside, from Mull never having looked.
   */
  journal?: JournalStore
  captures?: CaptureStore
  onJournalChanged?: () => void
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  sleep?: (ms: number) => Promise<void>
  maxSteps?: number
  /**
   * The utterance's trace. Forked when the plan runs, because a plan outlives
   * its utterance — the user reads the card and presses Run whenever they like,
   * and measuring the first press from the key-down would produce a column of
   * numbers about how long somebody spent deciding.
   */
  trace?: () => Trace
}

export class NavigateLane {
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxSteps: number
  /** Set when the user presses Escape. Checked between every step. */
  private stopped = false

  constructor(private readonly deps: NavigateDeps) {
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    this.maxSteps = deps.maxSteps ?? MAX_NAV_STEPS
  }

  /**
   * Put the proposal on screen. Nothing moves until the user presses Run.
   *
   * Returns as soon as the card is open — the loop runs after the user decides,
   * and the panel belongs to this lane until it closes.
   */
  async propose(request: NavigateRequest): Promise<void> {
    const origin = await this.where()
    this.stopped = false
    const parent = this.deps.trace?.() ?? new Trace({ log: this.deps.log })
    parent.step('plan.propose', {
      goal: request.goal,
      app: origin.app?.name,
      window: origin.windowTitle,
      limit: this.maxSteps
    })

    const card = (patch: Partial<PlanCard> = {}): PlanCard => ({
      kind: 'plan',
      steps: [],
      context: null,
      goal: request.goal,
      app: request.app?.name ?? origin.app?.name ?? null,
      limit: this.maxSteps,
      // The place a diff card's commit warning goes, saying the opposite thing
      // — because here the reassurance is the true one.
      note: 'read-only · nothing is written or sent',
      running: false,
      ...patch
    })

    this.deps.hud.openCard(card(), (action) => {
      if (action === 'cancel') {
        this.stopped = true
        parent.step('plan.cancelled', { beforeRunning: true })
        this.deps.hud.closeCard()
        // Journalled even though nothing was pressed. The window was still read
        // and possibly photographed during the hold, and a capture with no row
        // to account for it is the one thing the journal exists to make
        // impossible — declining the plan is exactly when somebody checking up
        // on Mull would look.
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
      // Run. From here the card belongs to the loop, and Escape means stop.
      const trace = parent.fork()
      trace.step('plan.run', { goal: request.goal })
      void this.walk(request, origin, card, trace).catch((err) => {
        trace.fail('plan.threw', {}, err)
        this.deps.hud.closeCard()
        this.deps.hud.announce?.(
          'error',
          `The plan stopped: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    })
  }

  // -------------------------------------------------------------------------

  private async walk(
    request: NavigateRequest,
    origin: { app: { bundleId: string; name: string } | null; windowTitle: string | null },
    card: (patch?: Partial<PlanCard>) => PlanCard,
    trace: Trace
  ): Promise<void> {
    const steps: PlanStep[] = []
    const history: NavAttempt[] = []
    let scan: Scan = { harvestId: '', targets: [] }
    let note = 'read-only · nothing is written or sent'
    /** What was read, and then what was made of it. Both may stay null. */
    let found: ScreenContext | null = null
    let answer: string | null = null

    const draw = (): void =>
      this.deps.hud.updateCard(card({ steps: [...steps], running: true, note, answer }))
    const stage = (text: string | null): void =>
      this.deps.hud.update?.({ stage: text, stageAt: text ? Date.now() : null })
    draw()

    for (let taken = 0; taken < this.maxSteps; taken += 1) {
      if (this.stopped) {
        note = 'stopped'
        trace.step('plan.stopped', { afterSteps: taken })
        break
      }

      const scanMs = trace.mark()
      stage(`looking · step ${taken + 1}`)
      scan = await this.scan()
      trace.step('scan', {
        step: taken + 1,
        targets: scan.targets.length,
        press: scan.targets.filter((t) => t.kind === 'press').length,
        type: scan.targets.filter((t) => t.kind === 'type').length,
        ms: scanMs()
      })
      const context =
        taken === 0 && request.context ? request.context : await this.read(request)

      const askMs = trace.mark()
      stage(`choosing · step ${taken + 1}`)
      let step: NavStep
      try {
        step = await this.deps.engine.navigate({
          goal: request.goal,
          app: request.app,
          context,
          targets: scan.targets,
          history,
          stepsLeft: this.maxSteps - taken
        })
      } catch (err) {
        // A step that did not parse, or an engine that refused. Either way the
        // plan ends here rather than improvising in someone else's window.
        trace.fail('step.unusable', { ms: askMs() }, err)
        this.deps.log?.('warn', 'navigate: no usable step', err)
        note = engineNote(err)
        break
      }

      trace.step('step.chosen', {
        n: taken + 1,
        what: describeStep(step),
        askMs: askMs(),
        screen: context?.chars ?? 0
      })

      if (step.verb === 'done') {
        note = step.because
        break
      }

      const id = `nav-${taken}`
      steps.push({ id, verb: verbOf(step), object: objectOf(step), state: 'running' })
      draw()

      stage(describeStep(step))
      const result = await this.deps.executor.perform(step, scan, {
        app: request.app,
        goal: request.goal
      })
      trace[result.ok ? 'step' : 'fail'](result.ok ? 'step.done' : 'step.refused', {
        n: taken + 1,
        what: describeStep(step),
        detail: result.detail,
        refusedBy: result.refusedBy
      })
      const shown = steps.find((candidate) => candidate.id === id)
      if (shown) {
        shown.state = result.ok ? 'done' : 'failed'
        if (!result.ok) shown.object = `${shown.object} — ${result.detail}`
      }
      history.push({ step, ok: result.ok, detail: result.detail })
      draw()

      // A read is the arrival, not a move: once the window has been captured
      // there is nothing further to press for.
      if (step.verb === 'read' && result.ok) {
        found = result.read ?? null
        note = result.detail
        break
      }
    }

    // Say what was found. The last turn, and the only one the user reads as
    // prose — everything above this is Mull moving around, which is means.
    if (found) {
      const answerMs = trace.mark()
      stage('reading what it found')
      try {
        const said = await this.deps.engine.answer(
          { goal: request.goal, context: found },
          (partial) => {
            answer = partial
            draw()
          }
        )
        answer = said.text.trim() || null
        trace.step('answer.done', {
          ms: answerMs(),
          chars: answer?.length ?? 0,
          from: found.chars
        })
      } catch (err) {
        // The walk succeeded and only the last turn failed, so the honest
        // report is that: it got there, and could not say what it saw.
        trace.fail('answer.failed', { ms: answerMs() }, err)
        this.deps.log?.('warn', 'navigate: could not say what it found', err)
        note = `read ${found.chars} characters, but couldn’t summarise them`
      }
      draw()
    }

    // Always. After a finished plan, a cancelled one and a failed one alike —
    // leaving someone's Slack on a stranger's DM is rude in a way no amount of
    // correctness elsewhere makes up for.
    stage('putting the window back')
    const back = await this.deps.executor.restore(origin, await this.scan())
    stage(null)
    trace.step('plan.restore', { ok: back.ok, detail: back.detail, note })

    // The answer is the note once there is one: "51 blocks · 6023 chars · back
    // in Prahastha" under a card that has just printed three paragraphs about
    // Anil would be Mull talking about itself over its own answer.
    const closing = answer ? back.detail : `${note} · ${back.detail}`
    this.deps.hud.updateCard(
      card({ steps: [...steps], running: false, note: closing, answer })
    )

    // The receipt. One row for the whole plan, and the only one that can carry
    // the photograph — see `NavigateDeps.journal`.
    this.record(request, {
      status: answer ? 'applied' : 'failed',
      answer,
      summary: answer ? `Looked · ${request.goal}` : `Looked · ${request.goal} · ${note}`,
      steps: steps.length
    })

    // The plan is over. Say so, or the panel keeps the phase it started in
    // forever — there is nothing else in the pipeline still running that would
    // ever move it on.
    this.deps.hud.announce?.('applied', answer ?? `${note} · ${back.detail}`)
  }

  /**
   * One journal row for the whole expedition.
   *
   * Written after `restore`, so it can say where the window was left, and
   * carrying the `ScreenContext` from key-down — which is the picture the model
   * was actually shown when it chose the first step, not a fresh read of a
   * window that has since been put back.
   *
   * Never throws. A plan that has already happened must not be undone by a
   * failure to write it down, and the steps themselves are journalled
   * separately by the executor.
   */
  private record(
    request: NavigateRequest,
    outcome: {
      status: JournalStatus
      /** The prose the user read, when there was any. */
      answer: string | null
      summary: string
      steps: number
    }
  ): void {
    if (!this.deps.journal) return
    try {
      const id = randomUUID()
      const draft: JournalDraft = {
        id,
        intent: {
          kind: 'command',
          verb: 'nav.plan',
          args: { goal: request.goal, steps: outcome.steps },
          transcript: request.transcript
        },
        app: request.app,
        before: null,
        // The answer goes in `after` so the journal row shows it the way every
        // other row shows what Mull produced, rather than inventing a second
        // place for text to live.
        after: outcome.answer,
        strategyUsed: null,
        status: outcome.status,
        summary: outcome.summary,
        verified: outcome.answer !== null,
        caret: null,
        // Nothing to take back: no text was written anywhere, and the window
        // has already been put back where it was.
        undoable: false,
        capture: this.deps.captures?.save(id, request.context) ?? null
      }
      this.deps.journal.append(draft)
      this.deps.onJournalChanged?.()
    } catch (err) {
      this.deps.log?.('error', 'navigate: journal write failed', err)
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
   * What can be pressed here, now.
   *
   * Fresh every step, never cached — the whole point is that the previous
   * scan's numbers stopped meaning anything the moment something was pressed.
   */
  private async scan(): Promise<Scan> {
    await this.sleep(SCAN_SETTLE_MS)
    let seen = await this.deps.sidecar.uiTargets({ maxTargets: 120, deadlineMs: 1_000 })
    for (let attempt = 0; seen.stoppedBy === 'tree-warming' && attempt < TREE_ATTEMPTS; attempt++) {
      await this.sleep(TREE_POLL_MS)
      seen = await this.deps.sidecar.uiTargets({ maxTargets: 120, deadlineMs: 1_000 })
    }
    return { harvestId: seen.harvestId, targets: seen.targets as UiTarget[] }
  }

  /** The window's words, for the turn after we have moved. */
  private async read(request: NavigateRequest): Promise<ScreenContext | null> {
    try {
      const seen = await this.deps.sidecar.windowContext({ maxChars: 6_000, screenshot: false })
      return {
        app: request.app,
        windowTitle: seen.windowTitle,
        blocks: seen.blocks,
        truncated: seen.truncated,
        image: null,
        // The picture is taken once, at key-down, and not again per step: it
        // costs a capture and a base64 on every turn of a loop the user is
        // already watching, and the target list is the part that moves.
        imageReason: 'not-retaken-mid-plan',
        chars: seen.blocks.reduce((n, block) => n + block.text.length, 0),
        harvestMs: seen.harvestMs
      }
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------

/** The left column of a plan row. One word, so the column reads as a column. */
function verbOf(step: NavStep): string {
  return step.verb === 'navKey' ? 'key' : step.verb
}

/** The right column: what the step is about, in the user's terms. */
function objectOf(step: NavStep): string {
  switch (step.verb) {
    case 'press':
      return `“${step.label}”`
    case 'type':
      return `“${step.text}”`
    case 'navKey':
      return step.key
    case 'read':
      return 'this window'
    case 'done':
      return step.because
  }
}

/** Why the plan stopped, when the engine is what stopped it. */
function engineNote(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/no step in reply|invalid|expected/i.test(message)) {
    return 'Mull couldn’t make sense of the next step'
  }
  return message
}

export { describeStep }
