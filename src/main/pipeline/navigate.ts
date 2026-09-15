import { randomUUID } from 'node:crypto'
import type { ScreenContext } from '@shared/context'
import type { PlanCard, PlanStep } from '@shared/hud'
import { MAX_NAV_STEPS, type NavAttempt, type NavStep } from '@shared/nav'
import type { SidecarApi, UiTarget } from '@shared/sidecar-api'
import type { HudLastAction } from '@shared/ipc'
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

/**
 * How much of a window one step is allowed to look at.
 *
 * 300 rather than 120 because a browser is not a Mail window. Chrome showing
 * Gmail returns 254 distinct targets once its page is deduplicated, and at 120
 * the list stopped inside Chrome's own toolbar — every page control, which is
 * the only part anyone means, fell off the end. Native apps are unaffected:
 * Notes still answers with eleven.
 *
 * The deadline moves with it. The same window takes ~500ms to walk, against a
 * cap that was 1s; a scan that times out half way returns a prefix of the
 * window and calls it the window.
 */
const SCAN_BUDGET = { maxTargets: 300, deadlineMs: 2_000 } as const

/**
 * How much budget a second attempt needs to be worth asking for.
 *
 * Two: one to take a different step, one to read what it found. With less than
 * that the re-ask can only produce the same `done` a turn later, having spent
 * three seconds to say it.
 */
const RETRY_MIN_STEPS = 2

/**
 * What to say when a browser will not show us the page.
 *
 * Names the app's own remedy rather than describing the mechanism. "Chromium
 * builds its renderer accessibility tree lazily" is true and helps nobody;
 * `chrome://accessibility` is a thing the reader can go and do.
 */
const BROWSER_COLD_NOTE =
  'this browser isn’t sharing the page — only its own toolbar is visible. ' +
  'Turning on “Native accessibility API support” at chrome://accessibility fixes it'

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
     *
     * `lastAction` is what the idle panel shows afterwards. This lane used to
     * omit it, so a finished expedition left the row describing whatever was
     * dictated before it — the user asked a question and the panel answered
     * with something they had said minutes ago.
     */
    announce?(
      phase: 'applied' | 'error' | 'blocked',
      notice: string,
      lastAction?: HudLastAction
    ): void
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
      // Run does not answer this card, it starts something that reports back
      // onto it. See `HudController.act` — without this the card closes on the
      // press, every `draw` below becomes a no-op, and Escape goes back to the
      // app being driven.
      startsRun: true,
      ...patch
    })

    /** Has Run been pressed? What a cancel means depends entirely on it. */
    let started = false

    this.deps.hud.openCard(card(), (action) => {
      if (action === 'cancel') {
        this.stopped = true
        if (started) {
          /**
           * A stop, not a decline — and they are not the same row.
           *
           * Every cancel used to be filed as `Declined · …` with `steps: 0` and
           * announced as "nothing was pressed". Fired mid-walk that is three
           * false statements at once, and the last is the one that matters: a
           * press already dispatched cannot be un-pressed, so a stop that
           * claimed otherwise would be the journal lying about the thing it
           * exists to record.
           *
           * Nothing is written here. `walk` is still running, it still has a
           * window to put back, and the row it files at the end covers the
           * steps that did happen.
           */
          parent.step('plan.stopped', { byUser: true })
          return
        }
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
      // `started` is belt and braces — `HudController` will not deliver a second
      // apply once a run is in flight — but it costs nothing here and every
      // future lane copying this shape gets it free.
      if (action !== 'apply' || started) return
      started = true
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
    /** The window as it looked before the last step. See `describeChange`. */
    let before: Scan | null = null
    /** How many steps actually moved the window. Told to the model each turn. */
    let moved = 0
    /**
     * The expedition's own id, made before the first step rather than when the
     * row is written at the end — a step cannot be stamped with an id that does
     * not exist yet, and without the stamp the journal has five loose rows
     * instead of one plan.
     */
    const groupId = randomUUID()
    const startedAt = Date.now()
    /** The row each step wrote, so its effect can be added once it is known. */
    let lastEntryId: string | undefined
    /** One second attempt per plan, and only after a `done(found:false)`. */
    let retried = false
    /** Set when the plan ended by giving up rather than by arriving. */
    let gaveUp = false
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
        // Says what was already done, because "stopped" on its own reads as
        // "nothing happened" — and that is the one thing a stop must never be
        // mistaken for. A press already dispatched cannot be un-pressed.
        note = steps.length === 0
          ? 'stopped before anything was pressed'
          : `stopped after ${steps.length} ${steps.length === 1 ? 'step' : 'steps'} — what was pressed stays pressed`
        trace.step('plan.stopped', { afterSteps: taken })
        break
      }

      const scanMs = trace.mark()
      stage(`looking · step ${taken + 1}`)
      // Guarded rather than left to the caller's catch: a throw out of `walk`
      // skips the restore, the journal row and the announce below, so the
      // window stays wherever the plan left it and nothing records that it
      // went. Every exit has to reach the tail.
      try {
        scan = await this.scan()
      } catch (err) {
        trace.fail('scan.threw', { step: taken + 1 }, err)
        note = 'could not read the window'
        break
      }
      trace.step('scan', {
        step: taken + 1,
        targets: scan.targets.length,
        press: scan.targets.filter((t) => t.kind === 'press').length,
        type: scan.targets.filter((t) => t.kind === 'type').length,
        stoppedBy: scan.stoppedBy,
        ms: scanMs()
      })

      /**
       * Did the last step actually do anything?
       *
       * Asked here rather than in the executor because here it is free: the
       * loop scans at the top of every turn anyway, so the window before and
       * the window after are both already in hand. The executor would have to
       * buy a second scan — ~500ms in Chrome — to learn the same thing.
       *
       * It replaces a much weaker signal. The executor compares window
       * *titles*, which is right when a press changes windows and silent when
       * it opens an overlay, a pane, a modal, or navigates in place — most of
       * what a press does. A Slack search box opening took the target list
       * from 300 entries to 6 and left the title untouched, so history said
       * "the window is still …", and the model, one step from the answer,
       * concluded it could not get there and stopped.
       */
      const last = history.at(-1)
      // `read` moves nothing, and a `done` entry here is the synthetic note the
      // retry below pushes rather than a step anyone took — appending "the
      // window did not change" to either would be describing work that never
      // happened.
      if (last && before && last.step.verb !== 'read' && last.step.verb !== 'done') {
        const change = describeChange(before, scan)
        if (change.moved) moved += 1
        last.detail = `${last.detail} — ${change.detail}`
        trace.step('step.effect', { n: history.length, moved: change.moved, what: change.detail })
        // The same sentence the model just got, written onto the row that step
        // already wrote. The journal used to record "the window is still …" —
        // the weak title check — and nothing at all about what really happened.
        if (lastEntryId) {
          this.deps.journal?.amend(lastEntryId, { detail: { evidence: change.detail } })
        }
      }
      before = scan

      // The browser is not showing us the page. Stop rather than spend the
      // budget pressing Reload and Back, and say which of the two problems
      // this is — the model would otherwise report "no target matches", which
      // is true, useless, and reads as Mull not understanding the request.
      if (scan.stoppedBy === 'browser-cold') {
        note = BROWSER_COLD_NOTE
        trace.fail('scan.browser-cold', { step: taken + 1 })
        break
      }
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
          stoppedBy: scan.stoppedBy,
          history,
          stepsLeft: this.maxSteps - taken,
          progress: { taken, moved }
        })
      } catch (err) {
        // A step that did not parse, or an engine that refused. Either way the
        // plan ends here rather than improvising in someone else's window.
        trace.fail('step.unusable', { ms: askMs() }, err)
        this.deps.log?.('warn', 'navigate: no usable step', err)
        note = engineNote(err)
        break
      }

      // Read once and reused: `askMs` is a stopwatch, so calling it twice
      // would put two different numbers on the same decision.
      const chosenMs = askMs()
      trace.step('step.chosen', {
        n: taken + 1,
        what: describeStep(step),
        askMs: chosenMs,
        screen: context?.chars ?? 0
      })

      if (step.verb === 'done') {
        /**
         * Giving up, with the budget to try again.
         *
         * The failure this exists for is not a step that errored — those
         * already recover, because the reason lands in `<history>` and the next
         * turn routes around it. It is a step that *succeeded* and was read as
         * failure: a press that opened a search box while the window title
         * stayed put, reported as "nothing moved", and a model that concluded
         * it was stuck one step from the answer.
         *
         * §1 fixes the reading. This is the second line of defence for the
         * times it is still wrong, and it is deliberately narrow — one re-ask
         * per plan, only on `found:false`, only with steps to spare. A loop
         * that argues with itself is worse than one that stops.
         */
        if (step.found === false && !retried && this.maxSteps - taken >= RETRY_MIN_STEPS) {
          retried = true
          note = step.because
          history.push({
            step,
            ok: false,
            detail:
              `you answered done(found:false) — "${step.because}". Before that stands: ` +
              'a window whose list of things to press has changed since you started is a window ' +
              'you have already moved through, and a short list after a long one is usually a ' +
              'search or dialog waiting for input. Look again and either take a step you have ' +
              'not tried, or answer done(found:false) once more and it will be accepted.'
          })
          trace.step('plan.retry', { after: taken + 1, because: step.because })
          stage('looking again')
          draw()
          continue
        }
        note = step.because
        gaveUp = step.found === false
        break
      }

      const id = `nav-${taken}`
      steps.push({ id, verb: verbOf(step), object: objectOf(step), state: 'running' })
      draw()

      stage(describeStep(step))
      let result: Awaited<ReturnType<typeof this.deps.executor.perform>>
      try {
        result = await this.deps.executor.perform(step, scan, {
          app: request.app,
          goal: request.goal,
          groupId,
          step: taken + 1,
          scan: {
            targets: scan.targets.length,
            press: scan.targets.filter((t) => t.kind === 'press').length,
            type: scan.targets.filter((t) => t.kind === 'type').length,
            stoppedBy: scan.stoppedBy ?? 'complete'
          },
          askMs: chosenMs
        })
      } catch (err) {
        // Same reason as the scan above: the tail has to be reached.
        trace.fail('step.threw', { n: taken + 1, what: describeStep(step) }, err)
        const shown = steps.find((candidate) => candidate.id === id)
        if (shown) shown.state = 'failed'
        note = `the step could not be carried out: ${err instanceof Error ? err.message : String(err)}`
        break
      }
      lastEntryId = result.entryId
      trace[result.ok ? 'step' : 'fail'](result.ok ? 'step.done' : 'step.refused', {
        n: taken + 1,
        what: describeStep(step),
        detail: result.detail,
        refusedBy: result.refusedBy
      })
      const shown = steps.find((candidate) => candidate.id === id)
      if (shown) {
        shown.state = result.ok ? 'done' : 'failed'
        // What happened, not the label the model chose. A press reports the
        // window it landed in — "Anil Turaga → Anil Turaga (DM) · Slack", or
        // that the window is still the one we started in — which is the whole
        // difference between a step that worked and one that was merely
        // accepted. The executor has returned this since the navigator was
        // caught pressing the same row twice; only the card ignored it.
        if (!result.ok) shown.object = `${shown.object} — ${result.detail}`
        else if (result.detail) shown.object = result.detail
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
    // Never allowed to throw: the row and the announce below are how the run
    // ends, and a failed restore is a sentence to print rather than a reason to
    // leave the panel showing a plan that never finished.
    const back = await this.deps.executor
      .restore(origin, await this.scan().catch(() => null))
      .catch((err) => {
        trace.fail('plan.restore.threw', {}, err)
        return { ok: false, detail: 'could not put the window back' }
      })
    stage(null)
    trace.step('plan.restore', { ok: back.ok, detail: back.detail, note })

    // The answer is the note once there is one: "51 blocks · 6023 chars · back
    // in Prahastha" under a card that has just printed three paragraphs about
    // Anil would be Mull talking about itself over its own answer.
    // The card has settled into the `wont` family by now, so the promise
    // under it is a flat statement of fact rather than an undo path.
    const closing = answer
      ? `Nothing was written · ${back.detail}`
      : `${note} · ${back.detail}`
    this.deps.hud.updateCard(
      card({ steps: [...steps], running: false, note: closing, answer })
    )

    // A plan that gave up did not succeed, whatever it read on the way. The
    // old rule was "did we produce text", which called a graceful surrender
    // `applied` and filed the excuse as the answer — so the journal recorded a
    // run that pressed four things and found nothing as a success.
    const arrived = answer !== null && !gaveUp

    // The receipt. One row for the whole plan, and the only one that can carry
    // the photograph — see `NavigateDeps.journal`.
    const entry = this.record(request, {
      id: groupId,
      status: arrived ? 'applied' : 'failed',
      answer,
      summary: arrived ? `Looked · ${request.goal}` : `Looked · ${request.goal} · ${note}`,
      steps: steps.length,
      ms: Date.now() - startedAt,
      because: note
    })

    // The plan is over. Say so, or the panel keeps the phase it started in
    // forever — there is nothing else in the pipeline still running that would
    // ever move it on.
    //
    // The `lastAction` is the part that was missing: this lane announced with
    // two arguments, so the idle panel went on showing whatever the previous
    // *dictation* had written. A user who had just asked a question saw a row
    // about something they said minutes ago, and the answer — which had been on
    // the card a moment earlier — was gone with no way back to it.
    this.deps.hud.announce?.(
      arrived ? 'applied' : 'error',
      answer ?? `${note} · ${back.detail}`,
      {
        summary: `Looked · ${request.app?.name ?? 'this app'} · “${request.goal}”`,
        at: Date.now(),
        chars: answer?.length ?? 0,
        entryId: entry?.id ?? null,
        // Nothing was written anywhere, and the window has already been put
        // back. There is nothing for ⌥Z to take.
        undoable: false,
        result: answer ?? note
      }
    )
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
      /**
       * The id made before the first step, so this row and the steps stamped
       * with it agree. Generated here only when a caller has none.
       */
      id?: string
      status: JournalStatus
      /** The prose the user read, when there was any. */
      answer: string | null
      summary: string
      steps: number
      ms?: number
      /** How the plan ended, in the model's own words where there are any. */
      because?: string
    }
  ): { id: string } | null {
    if (!this.deps.journal) return null
    try {
      const id = outcome.id ?? randomUUID()
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
        capture: this.deps.captures?.save(id, request.context) ?? null,
        // The plan is its own group: the steps point at this row's id, and this
        // row points at itself, so grouping needs no special case for the head.
        groupId: id,
        ms: outcome.ms ?? null,
        detail: outcome.because ? { because: outcome.because } : null
      }
      this.deps.journal.append(draft)
      this.deps.onJournalChanged?.()
      return { id }
    } catch (err) {
      this.deps.log?.('error', 'navigate: journal write failed', err)
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
   * What can be pressed here, now.
   *
   * Fresh every step, never cached — the whole point is that the previous
   * scan's numbers stopped meaning anything the moment something was pressed.
   */
  private async scan(): Promise<Scan> {
    await this.sleep(SCAN_SETTLE_MS)
    let seen = await this.deps.sidecar.uiTargets(SCAN_BUDGET)
    for (let attempt = 0; seen.stoppedBy === 'tree-warming' && attempt < TREE_ATTEMPTS; attempt++) {
      await this.sleep(TREE_POLL_MS)
      seen = await this.deps.sidecar.uiTargets(SCAN_BUDGET)
    }
    return {
      harvestId: seen.harvestId,
      targets: seen.targets as UiTarget[],
      stoppedBy: seen.stoppedBy
    }
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

/**
 * What changed between two looks at the window, in a sentence.
 *
 * The navigator's only honest answer to *did that press do anything*. It reads
 * the set of things that can be pressed, because that set is what a user means
 * by "the window changed": a search overlay, a switched conversation, an
 * expanded folder and a modal all replace it, and none of them need touch the
 * window title.
 *
 * ### The threshold, and why it is not zero
 *
 * Any difference at all is too sensitive. A Slack channel receiving a message
 * while Mull is thinking gains a row, and calling that "the press worked" would
 * be exactly the false confidence this is meant to remove. So movement means a
 * *substantial* replacement — most of what was there is gone — measured by how
 * much the two sets overlap.
 *
 * Compared by title rather than by index, because indices are positions in a
 * list that was rebuilt and mean nothing across a step.
 */
export function describeChange(
  before: Scan,
  after: Scan
): { moved: boolean; detail: string } {
  const was = new Set(before.targets.map((target) => target.title))
  const now = new Set(after.targets.map((target) => target.title))
  if (was.size === 0 && now.size === 0) return { moved: false, detail: 'nothing to press either way' }

  let shared = 0
  for (const title of now) if (was.has(title)) shared += 1
  // Against the smaller side: going from 300 things to 6 is a complete
  // replacement even though 6 of the 300 survived, and measuring against the
  // larger side would call that a 98% match.
  const overlap = shared / Math.max(1, Math.min(was.size, now.size))

  if (overlap >= CHANGE_OVERLAP) {
    return {
      moved: false,
      detail: `the window did not change — the same ${now.size} things are still here, so pressing that again will do the same nothing`
    }
  }
  return {
    moved: true,
    detail: `the window changed: ${was.size} things to press became ${now.size}, ${shared} in common`
  }
}

/**
 * How much overlap still counts as the same window.
 *
 * Two thirds. Generous on purpose — the cost of calling a real change "no
 * change" is the model giving up one step early, which is the bug this exists
 * to fix; the cost of the opposite is one wasted step.
 */
const CHANGE_OVERLAP = 0.67

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
