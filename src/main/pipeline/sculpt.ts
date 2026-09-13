import { randomUUID } from 'node:crypto'
import type { ScreenContext } from '@shared/context'
import type { CardCommit, HudAction, HudCard, HudChip } from '@shared/hud'
import type { HudState } from '@shared/ipc'
import type { SidecarApi } from '@shared/sidecar-api'
import type { JournalDraft, JournalEntry } from '@shared/types'
import type { Bench } from '../bench'
import type { Engine, EngineState } from '../engine/types'
import { describeInsertionReason, type InsertionService } from '../services/insertion'
import { sendChord, type SendChord } from '../services/send-table'
import { describeSend, Sender, type SendOutcome } from '../services/sender'
import type { JournalStore } from '../store/journal'
import type { CaptureStore } from '../store/captures'
import { kb, Trace } from '../trace'
import { summarise } from './cleanup'
import { diffText } from './diff'
import { describeTargetCheck, stillMatches, type EditTarget } from './selection'

/**
 * Sculpt — the edit lane.
 *
 * The user selected some text, said what they wanted, and the router decided
 * that was an instruction. From here: ask the engine, show every mark it
 * proposes, and change nothing until they say so.
 *
 * Three rules hold this together, and all three are refusals:
 *
 *  1. **Nothing is applied that was not previewed.** The card is a proposal;
 *     ⏎ is the only thing that writes.
 *  2. **Nothing is applied to text that moved.** The selection is re-read
 *     immediately before the write and compared, character for character,
 *     against what was on screen when the preview was built. Anything else
 *     ends in a sentence explaining why, never in a guess.
 *  3. **Nothing happens silently.** Applied, cancelled and refused all leave a
 *     journal row. A record of only the successes is one nobody can trust.
 *
 * No `electron` import: the HUD is a port, so the whole lane runs in tests.
 */

export interface SculptHud {
  /** Working states. Refused mid-utterance — see DictationPipeline.patchState. */
  update(patch: Partial<HudState>): boolean
  /** Terminal states, with the linger back to idle the pipeline already owns. */
  announce(
    phase: 'applied' | 'error' | 'blocked',
    notice: string,
    lastAction?: HudState['lastAction']
  ): boolean
  openCard(card: HudCard, onAction: (action: HudAction) => void): void
  updateCard(card: HudCard): void
  closeCard(): void
}

export interface SculptRequest {
  instruction: string
  /** The raw transcript, for the journal. Often the fuller, spoken form. */
  transcript: string
  /** What the edit will rewrite: a selection, or the whole field. */
  target: EditTarget
  app: { bundleId: string; name: string } | null
  /**
   * The window the user was looking at when they spoke (M5a), or null when
   * Mull was not allowed to read it. Handed straight to the engine as context —
   * never as a passage, and never as a source of instructions.
   */
  context?: ScreenContext | null
  /**
   * Did the user's own words ask for this to be sent? (M5a)
   *
   * Set by `wantsSend()` in router.ts from the transcript, and from nothing
   * else — not from the model, not from the screen. All it does here is decide
   * whether the card carries a second button; the keystroke is the actuator,
   * and the user presses it.
   */
  send?: boolean
  /** How the routing decision was reached, for the ledger. */
  routedBy?: string
  classifyMs?: number | null
}

export interface SculptDeps {
  engine: Engine
  sidecar: SidecarApi
  insertion: InsertionService
  hud: SculptHud
  journal?: JournalStore
  /**
   * Where the evidence is kept: the window transcript that went into the
   * prompt, and the picture if there was one. Optional — without it a row
   * simply cannot explain itself, which is what every row did before M5a.
   */
  captures?: CaptureStore
  /**
   * The utterance's trace, so the engine's cost is logged beside the
   * classification that preceded it rather than in a story of its own.
   */
  trace?: () => Trace
  bench?: Bench
  onJournalChanged?: () => void
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  now?: () => number
  /** Let the target app service a send before reading the composer back. */
  sleep?: (ms: number) => Promise<void>
}

const INTENT_CHIP: HudChip = { kind: 'intent', label: 'Edit', id: 'intent' }
const DRAFT_CHIP: HudChip = { kind: 'intent', label: 'Reply', id: 'intent' }
/** A `cmd` chip, not an `intent` one: this utterance writes nothing. */
const SEND_CHIP: HudChip = { kind: 'cmd', label: 'Send', id: 'intent' }

/**
 * What this lane is doing, in the user's words.
 *
 * "Edit declined" on a card that wrote a new message would be a small lie in
 * the one place Mull cannot afford them — the journal is the record someone
 * checks when they are trying to work out what happened.
 */
function laneNoun(target: EditTarget): 'Edit' | 'Reply' {
  return target.kind === 'draft' ? 'Reply' : 'Edit'
}

/** State carried between `run` and the card's answer, which can arrive first. */
interface Session {
  answered: boolean
  failure: string | null
  firstTokenMs: number | null
  startedAt: number
  /**
   * The chord that would send here, decided in `run` when the card was built.
   *
   * Null on the overwhelming majority of cards, and null is what makes
   * `apply-send` impossible to honour — `answer` reads this, not the action, to
   * decide whether a keystroke leaves the process.
   */
  chord: SendChord | null
}

export class SculptLane {
  private readonly now: () => number
  private readonly log: NonNullable<SculptDeps['log']>
  private readonly sender: Sender

  constructor(private readonly deps: SculptDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? ((): void => {})
    // One implementation of the keystroke and the read-back, shared with the
    // bare-send card. The discipline is the part that must not vary.
    this.sender = new Sender({
      sidecar: deps.sidecar,
      journal: deps.journal,
      onJournalChanged: deps.onJournalChanged,
      log: deps.log,
      sleep: deps.sleep
    })
  }

  async run(request: SculptRequest): Promise<void> {
    // The receipt for every row this request writes. See `journal`.
    this.seeing = request.context ?? null
    const session: Session = {
      answered: false,
      failure: null,
      firstTokenMs: null,
      startedAt: this.now(),
      chord: null
    }

    const ready = await this.engineState()
    if (ready.kind !== 'ready') return this.unavailable(request, ready, session)

    const before = request.target.text
    // What ⏎ will rewrite, said out loud in both the chip and the card title.
    // "the whole field" and "what I highlighted" are very different promises,
    // and the user is about to approve one of them.
    // What ⏎ will do, in three words, because "replaces what you highlighted"
    // and "adds it where your cursor is" are very different promises.
    const scope =
      request.target.kind === 'selection'
        ? 'selection'
        : request.target.kind === 'document'
          ? 'whole field'
          : request.target.kind === 'draft'
            ? 'a new reply'
            : 'to cursor'
    const appName = request.app?.name ?? null
    const cardApp = appName ? `${appName} — ${scope}` : scope

    /**
     * Does this card get a second button?
     *
     * Three things must all be true, and none of them is the model's opinion:
     * the user's own words asked (`request.send`, from `wantsSend()`), Mull
     * knows this app's send chord (`sendChord`, which returns null for
     * everything not on the table), and — implicitly — the user is about to
     * look at the draft before pressing anything.
     *
     * Decided once, here, and then carried on the card object. That makes the
     * button and the ⌘⏎ chord the same fact rather than two things that have to
     * be kept in step, and it means nothing that arrives later — a streamed
     * token, a context block, a slow classification — can add a send to a card
     * that opened without one.
     */
    const chord = request.send === true ? sendChord(request.app?.bundleId) : null
    session.chord = chord
    const commit: CardCommit | null = chord
      ? { label: 'Apply & send', hint: chord.hint, warning: 'sending can’t be undone' }
      : null
    if (request.send === true && !chord) {
      this.log('info', 'sculpt: asked to send, but this app has no known send chord', {
        app: request.app?.bundleId ?? null
      })
    }

    this.deps.hud.update({
      phase: 'thinking',
      transcript: request.instruction,
      partial: false,
      notice: null,
      chips: [
        request.target.kind === 'draft' ? DRAFT_CHIP : INTENT_CHIP,
        { kind: 'dict', label: cardApp, id: 'target' }
      ]
    })

    // Started before the card is opened so the first token can land in it, but
    // never awaited here — the card must be on screen (and escapable) while
    // the engine is still writing.
    const stage = (text: string | null): void => {
      this.deps.hud.update({ stage: text, stageAt: text ? this.now() : null })
    }
    stage(request.target.kind === 'draft' ? 'writing a draft' : 'editing')

    const trace = this.deps.trace?.()
    trace?.step(request.target.kind === 'draft' ? 'compose.ask' : 'edit.ask', {
      engine: this.deps.engine.name,
      model: this.deps.engine.model,
      instruction: request.instruction,
      before: before.length,
      screen: request.context?.chars ?? 0,
      image: kb(request.context?.image?.bytes),
      commit: commit?.hint
    })

    const onPartial = (partial: string): void => {
      if (session.firstTokenMs === null) {
        session.firstTokenMs = this.now() - session.startedAt
        // The number that decides whether the card feels alive or hung. Worth
        // its own line, because it is the one the user perceives and it is
        // nowhere near the total.
        trace?.step('engine.firstToken', { ms: session.firstTokenMs })
        // The word changes the moment the first token lands, which is the
        // cheapest possible proof that something is happening.
        stage('writing')
      }
      const { segments, changes } = diffText(before, partial)
      this.deps.hud.updateCard({ kind: 'diff', app: cardApp, segments, changes, commit })
    }

    // Two lanes, one card. A draft diffs against the empty string, so every
    // segment comes out as an insertion and the existing DiffCard renders it as
    // pure writing ink — which is exactly what a new reply is. No second card
    // type, no second renderer, no second thing to keep in step.
    const stream = (
      request.target.kind === 'draft'
        ? this.deps.engine.compose(
            {
              instruction: request.instruction,
              app: request.app,
              context: request.context ?? null
            },
            onPartial
          )
        : this.deps.engine.transform(
            {
              instruction: request.instruction,
              text: before,
              app: request.app,
              context: request.context ?? null
            },
            onPartial
          )
    )
      .then((result) => result.text)
      .catch((err: unknown) => {
        // Swallowed into `failure` rather than rethrown: the card's answer
        // handler awaits this promise too, and an unhandled rejection from a
        // keypress nobody is awaiting would take the process down.
        session.failure = err instanceof Error ? err.message : String(err)
        stage(null)
        trace?.fail('engine.failed', { ms: this.now() - session.startedAt }, err)
        this.log('error', 'sculpt: the engine failed', err)
        return before
      })

    this.deps.hud.openCard({ kind: 'diff', app: cardApp, segments: [], changes: 0, commit }, (action) => {
      session.answered = true
      stage(null)
      trace?.step('card.action', { action, whileStreaming: true })
      void this.answer(action, request, stream, session)
    })

    const after = await stream
    // ⏎ or esc arrived while the engine was still writing. Pressing Apply mid
    // stream is a decision, not an accident — `answer` waits for the complete
    // proposal before it writes anything, so it is never a partial rewrite.
    if (session.answered) return

    if (session.failure) {
      this.deps.hud.closeCard()
      this.fail(request, session, `The engine couldn’t finish that: ${session.failure}`)
      return
    }

    const final = diffText(before, after)
    if (final.changes === 0) {
      // An honest outcome, and a common one on text that is already tight.
      // Showing an empty card would ask the user to approve nothing.
      //
      // It means something different for a draft, though: nothing changed
      // against an empty string is nothing written, which is a failure rather
      // than a compliment about the user's prose.
      this.deps.hud.closeCard()
      this.record(request, session, {
        outcome: 'refused',
        reason: 'no-change',
        after,
        changes: 0,
        insertMs: 0
      })
      this.deps.hud.announce(
        request.target.kind === 'draft' ? 'error' : 'applied',
        request.target.kind === 'draft'
          ? 'Mull couldn’t draft anything from what’s on screen.'
          : 'Nothing to change — that already reads well.'
      )
      return
    }

    this.deps.hud.updateCard({
      kind: 'diff',
      app: cardApp,
      segments: final.segments,
      changes: final.changes,
      commit
    })
  }

  /**
   * "Send the message" — the composer is already full and there is nothing to
   * write.
   *
   * The odd one out in this file: no engine, no diff, no target to re-check.
   * What it shows is not a proposal but a *reading* — the text Mull found in
   * the box a moment ago, printed back so the user can see exactly what one
   * keystroke is about to do. Every other card in Mull answers "is this what
   * you want me to write?"; this one answers "is this what you want to send?".
   *
   * It refuses two ways, and both are sentences rather than silence: an app
   * with no known send chord (`send-table.ts` has no default), and an empty
   * box. Neither can be salvaged by guessing.
   */
  async sendOnly(request: {
    app: { bundleId: string; name: string } | null
    /** What the composer held when the user spoke. Re-read before the keystroke. */
    text: string
    transcript: string
    routedBy?: string
  }): Promise<void> {
    const startedAt = this.now()
    const chord = sendChord(request.app?.bundleId)
    const name = request.app?.name ?? 'this app'

    if (!chord) {
      this.deps.hud.announce(
        'blocked',
        `Mull doesn’t know how to send in ${name} — press send yourself.`
      )
      return
    }
    if (!request.text.trim()) {
      this.deps.hud.announce('blocked', 'There’s nothing in the box to send.')
      return
    }

    this.deps.hud.update({
      phase: 'thinking',
      transcript: request.transcript,
      partial: false,
      notice: null,
      chips: [SEND_CHIP, { kind: 'dict', label: name, id: 'target' }]
    })

    this.deps.hud.openCard(
      {
        kind: 'send',
        app: name,
        text: request.text,
        commit: { label: 'Send', hint: chord.hint, warning: 'sending can’t be undone' }
      },
      (action) => {
        void this.answerSend(action, request, chord, startedAt)
      }
    )
  }

  private async answerSend(
    action: HudAction,
    request: { app: { bundleId: string; name: string } | null; text: string; transcript: string; routedBy?: string },
    chord: SendChord,
    startedAt: number
  ): Promise<void> {
    if (action !== 'apply-send') {
      this.journal({
        intent: { kind: 'command', verb: 'send', args: {}, transcript: request.transcript },
        app: request.app,
        before: null,
        after: null,
        strategyUsed: null,
        status: 'cancelled',
        summary: `Send declined · ${request.app?.name ?? 'this app'}`,
        verified: null,
        caret: null,
        undoable: false
      })
      this.deps.hud.announce('applied', 'Cancelled — nothing was sent.')
      return
    }

    // Read it again. The card has been on screen for as long as the user took
    // to decide, and they can type into the box while it is up — what leaves
    // has to be what they just approved, not what was there when they spoke.
    const live = await this.deps.sidecar
      .focusedElement({ contextBytes: 4_096 })
      .catch(() => null)
    if (!live?.element) {
      this.deps.hud.announce('error', 'Mull couldn’t re-read the box, so it didn’t send.')
      return
    }
    if (live.element.text.trim() !== request.text.trim()) {
      this.deps.hud.announce(
        'error',
        'That text has changed since Mull read it — nothing was sent.'
      )
      return
    }

    const outcome = await this.sender.send({
      app: request.app,
      chord,
      text: request.text,
      transcript: request.transcript
    })
    this.deps.hud.announce(
      outcome.sent === false ? 'error' : 'applied',
      describeSend(outcome, request.app?.name ?? null)
    )
    this.deps.bench?.record({
      kind: 'edit',
      engine: 'none',
      model: 'n/a',
      app: request.app?.bundleId ?? null,
      outcome: outcome.sent === false ? 'failed' : 'applied',
      reason: outcome.sent === true || outcome.sent === 'unknown' ? undefined : outcome.reason,
      strategy: null,
      routedBy: request.routedBy,
      classifyMs: null,
      instructionChars: request.transcript.length,
      beforeChars: request.text.length,
      afterChars: request.text.length,
      changes: 0,
      firstTokenMs: null,
      engineMs: 0,
      insertMs: 0,
      totalMs: this.now() - startedAt,
      sent: outcome.sent === true ? 'yes' : outcome.sent === 'unknown' ? 'unknown' : 'no'
    })
  }

  // -------------------------------------------------------------------------

  private async answer(
    action: HudAction,
    request: SculptRequest,
    stream: Promise<string>,
    session: Session
  ): Promise<void> {
    const after = await stream
    this.deps.trace?.()?.step('engine.done', {
      after: after.length,
      changes: diffText(request.target.text, after).changes,
      ms: this.now() - session.startedAt
    })
    if (session.failure) {
      this.fail(request, session, `The engine couldn’t finish that: ${session.failure}`)
      return
    }

    if (action === 'cancel') {
      this.journal({
        intent: {
          kind: 'edit',
          instruction: request.instruction,
          target: request.target.kind,
          transcript: request.transcript
        },
        app: request.app,
        before: request.target.text,
        after,
        strategyUsed: null,
        status: 'cancelled',
        summary: `${laneNoun(request.target)} declined · ${request.app?.name ?? 'this app'} · “${summarise(request.instruction)}”`,
        verified: null,
        caret: null,
        undoable: false
      })
      this.record(request, session, {
        outcome: 'cancelled',
        after,
        changes: diffText(request.target.text, after).changes,
        insertMs: 0
      })
      this.deps.hud.announce('applied', 'Cancelled — nothing changed.')
      return
    }

    // Rule 2: the text has to still be the text we previewed.
    const check = await stillMatches(this.deps.sidecar, request.target)
    if (!check.ok) {
      const message = describeTargetCheck(check.reason)
      this.journal({
        intent: {
          kind: 'edit',
          instruction: request.instruction,
          target: request.target.kind,
          transcript: request.transcript
        },
        app: request.app,
        before: request.target.text,
        after: null,
        strategyUsed: null,
        status: 'failed',
        summary: `${laneNoun(request.target)} refused · ${message}`,
        verified: null,
        caret: null,
        undoable: false
      })
      this.record(request, session, {
        outcome: 'refused',
        reason: check.reason,
        after,
        changes: 0,
        insertMs: 0
      })
      this.deps.hud.announce('error', message)
      return
    }

    this.deps.hud.update({ phase: 'inserting' })
    const insertStart = this.now()
    const outcome = await this.write(request.target, after)
    const insertMs = this.now() - insertStart

    if (!outcome.inserted) {
      const message = describeInsertionReason(outcome.reason)
      this.journal({
        intent: {
          kind: 'edit',
          instruction: request.instruction,
          target: request.target.kind,
          transcript: request.transcript
        },
        app: request.app,
        before: request.target.text,
        after: null,
        strategyUsed: null,
        status: 'failed',
        summary: `${laneNoun(request.target)} · ${request.app?.name ?? 'this app'} — not applied`,
        verified: null,
        caret: null,
        undoable: false
      })
      this.record(request, session, {
        outcome: 'failed',
        reason: outcome.reason ?? 'unknown',
        after,
        changes: 0,
        insertMs
      })
      this.deps.hud.announce('error', message)
      return
    }

    const summary = `${laneNoun(request.target)} · ${request.app?.name ?? 'this app'} · “${summarise(request.instruction)}”`
    const entry = this.journal({
      intent: {
        kind: 'edit',
        instruction: request.instruction,
        target: request.target.kind,
        transcript: request.transcript
      },
      app: request.app,
      // `replacedText` is what the sidecar actually overwrote; it and the
      // snapshot agree by rule 2, but the write's own account of itself is the
      // one worth keeping.
      // A reference edit replaced nothing, so it has no `before` — and undo
      // must remove the insertion rather than restore anything.
      before:
        request.target.kind === 'reference' || request.target.kind === 'draft'
          ? null
          : outcome.replacedText ?? request.target.text,
      after,
      strategyUsed: outcome.strategyUsed,
      status: 'applied',
      summary,
      verified: outcome.verified,
      caret: outcome.caret,
      // Exactly the bar dictation clears: undo only where the write was read
      // back and the caret is known.
      undoable: outcome.verified === true && outcome.caret !== null
    })

    // Stamped before the send so `totalMs` keeps meaning what it has always
    // meant: instruction to text-on-screen. The send is measured separately.
    const editEndedAt = this.now()

    this.log('info', 'edit applied', {
      chars: after.length,
      strategy: outcome.strategyUsed,
      verified: outcome.verified,
      firstTokenMs: session.firstTokenMs
    })

    const ghost: HudState['lastAction'] = {
      summary,
      at: this.now(),
      chars: after.length,
      entryId: entry?.id ?? null,
      undoable: entry?.undoable ?? false
    }

    // The text is in. Everything above this line is undoable; everything below
    // it is not, which is why it is a separate keypress and a separate journal
    // row rather than a flag on the one above.
    if (action === 'apply-send' && session.chord) {
      const sendStart = this.now()
      const sent = await this.sender.send({
        app: request.app,
        chord: session.chord,
        text: after,
        transcript: request.transcript
      })
      this.record(request, session, {
        outcome: 'applied',
        after,
        changes: diffText(request.target.text, after).changes,
        insertMs,
        strategy: outcome.strategyUsed,
        endedAt: editEndedAt,
        sent: sent.sent === true ? 'yes' : sent.sent === 'unknown' ? 'unknown' : 'no',
        sendMs: this.now() - sendStart
      })
      this.deps.hud.announce(
        // `unknown` is not an error: the text is in, the chord went, and the
        // only honest thing left to say is that Mull could not watch it leave.
        sent.sent === false ? 'error' : 'applied',
        describeSend(sent, request.app?.name ?? null),
        ghost
      )
      return
    }

    this.record(request, session, {
      outcome: 'applied',
      after,
      changes: diffText(request.target.text, after).changes,
      insertMs,
      strategy: outcome.strategyUsed,
      endedAt: editEndedAt
    })
    this.deps.hud.announce('applied', `${laneNoun(request.target)} applied.`, ghost)
  }

  // -------------------------------------------------------------------------

  /**
   * Put the proposal where the target is.
   *
   * Three kinds, three write paths, and the differences are all about not
   * writing to the wrong place:
   *
   *   selection   the M2 insertion chain (`ax → paste → type`) when the
   *               selection is in the focused element, so Sculpt still works in
   *               Electron apps that refuse AX writes. When the selection lives
   *               somewhere else in the app, AX only: a keystroke lands where
   *               the caret is, and pasting over a selection held elsewhere
   *               would replace whatever the caret is sitting in instead.
   *   document    `replaceRange` with `expect` — AX-only, refuses unless that
   *               exact range still holds exactly the text the preview was
   *               built from. A whole-field rewrite has to be exact; a paste
   *               fallback would need ⌘A first, and "select everything in
   *               whatever has focus, then overwrite it" is not a thing to do
   *               on a guess.
   *   reference   nothing is replaced. The rewrite is inserted at the caret,
   *               because the text it came from cannot be written to — a sent
   *               message, a web page, someone else's document.
   *
   * `replaceRange` reports `verified` but no caret, so the caret is computed —
   * and only when the write was read back, which is what makes it a fact rather
   * than an assumption. Undo needs it to offer ⌥Z at all.
   */
  private async write(
    target: EditTarget,
    after: string
  ): Promise<{
    inserted: boolean
    strategyUsed: 'ax' | 'paste' | 'type' | null
    verified: boolean | null
    caret: number | null
    replacedText: string | null
    reason: string | null
  }> {
    if (target.kind === 'reference' || target.kind === 'draft') {
      // Insert, don't replace. Nothing here is Mull's to destroy — a reference
      // is text it may not rewrite, and a draft never had anything under it.
      return this.deps.insertion.insert(after, target.app)
    }

    if (target.kind === 'selection') {
      return target.keystrokesSafe
        ? this.deps.insertion.replaceSelection(after, target.app)
        : this.deps.insertion.replaceSelection(after, target.app, { onlyAx: true })
    }

    const result = await this.deps.sidecar.replaceRange({
      start: target.start,
      length: target.length,
      text: after,
      expect: target.text
    })

    return {
      inserted: result.replaced,
      strategyUsed: result.replaced ? 'ax' : null,
      verified: result.verified,
      caret: result.verified === true ? target.start + after.length : null,
      replacedText: result.replaced ? target.text : null,
      reason: result.reason
    }
  }

  /**
   * No engine. The instruction was already typed nowhere and the selection is
   * untouched, so this is purely a matter of saying so clearly — and of not
   * pretending an `Edit` chip means anything right now.
   */
  private unavailable(
    request: SculptRequest,
    state: Exclude<EngineState, { kind: 'ready' }>,
    session: Session
  ): void {
    const notice =
      state.kind === 'signed-out'
        ? 'No engine is connected — open Settings → Engine to sign in. Dictation still works.'
        : `Mull can’t edit right now: ${state.reason} Dictation still works.`

    this.deps.hud.update({
      chips: [{ kind: 'warn', label: state.kind === 'signed-out' ? 'no engine' : 'local-only', id: 'engine' }]
    })
    this.journal({
      intent: {
        kind: 'edit',
        instruction: request.instruction,
        target: request.target.kind,
        transcript: request.transcript
      },
      app: request.app,
      before: request.target.text,
      after: null,
      strategyUsed: null,
      status: 'cancelled',
      summary: `${laneNoun(request.target)} withheld · ${state.kind === 'signed-out' ? 'no engine' : 'local-only'} · “${summarise(request.instruction)}”`,
      verified: null,
      caret: null,
      undoable: false
    })
    this.record(request, session, {
      outcome: 'unavailable',
      reason: state.kind,
      after: request.target.text,
      changes: 0,
      insertMs: 0
    })
    this.deps.hud.announce('blocked', notice)
  }

  private fail(request: SculptRequest, session: Session, message: string): void {
    this.journal({
      intent: {
        kind: 'edit',
        instruction: request.instruction,
        target: request.target.kind,
        transcript: request.transcript
      },
      app: request.app,
      before: request.target.text,
      after: null,
      strategyUsed: null,
      status: 'failed',
      summary: `${laneNoun(request.target)} failed · “${summarise(request.instruction)}”`,
      verified: null,
      caret: null,
      undoable: false
    })
    this.record(request, session, {
      outcome: 'failed',
      reason: session.failure ?? 'unknown',
      after: request.target.text,
      changes: 0,
      insertMs: 0
    })
    this.deps.hud.announce('error', message)
  }

  private async engineState(): Promise<EngineState> {
    try {
      return await this.deps.engine.ready()
    } catch (err) {
      this.log('warn', 'sculpt: engine.ready() failed', err)
      return { kind: 'local-only', reason: 'the engine did not answer.' }
    }
  }

  /** Journalling must never be why an edit fails; the text is already placed. */
  /**
   * Write the row, and staple the receipt to it.
   *
   * `seeing` is the window this request was decided from, stashed on the way in
   * rather than threaded through ten call sites. The lane is serial — one
   * request at a time, by construction — so there is exactly one answer to
   * "what was Mull looking at" at any moment.
   *
   * The id is minted here rather than inside `append` because the picture is
   * filed under it, and a screenshot that cannot be tied back to a row is a
   * screenshot of nothing in particular.
   */
  private journal(draft: JournalDraft): JournalEntry | null {
    if (!this.deps.journal) return null
    try {
      const id = draft.id ?? randomUUID()
      const entry = this.deps.journal.append({
        ...draft,
        id,
        capture: draft.capture ?? this.deps.captures?.save(id, this.seeing) ?? null
      })
      this.deps.onJournalChanged?.()
      return entry
    } catch (err) {
      this.log('error', 'journal write failed', err)
      return null
    }
  }

  /** The window the request in flight was decided from. See `journal`. */
  private seeing: ScreenContext | null = null

  private record(
    request: SculptRequest,
    session: Session,
    outcome: {
      outcome: 'applied' | 'cancelled' | 'refused' | 'failed' | 'unavailable'
      reason?: string
      after: string
      changes: number
      insertMs: number
      strategy?: string | null
      /** When the *edit* finished, so a send after it does not inflate totalMs. */
      endedAt?: number
      sent?: 'yes' | 'no' | 'unknown'
      sendMs?: number
    }
  ): void {
    this.deps.bench?.record({
      kind: 'edit',
      engine: this.deps.engine.name ?? 'unknown',
      model: this.deps.engine.model ?? 'n/a',
      app: request.app?.bundleId ?? null,
      outcome: outcome.outcome,
      reason: outcome.reason,
      strategy: outcome.strategy ?? null,
      routedBy: request.routedBy,
      classifyMs: request.classifyMs ?? null,
      instructionChars: request.instruction.length,
      beforeChars: request.target.text.length,
      afterChars: outcome.after.length,
      changes: outcome.changes,
      firstTokenMs: session.firstTokenMs,
      engineMs: (outcome.endedAt ?? this.now()) - session.startedAt - outcome.insertMs,
      insertMs: outcome.insertMs,
      totalMs: (outcome.endedAt ?? this.now()) - session.startedAt,
      sent: outcome.sent,
      sendMs: outcome.sendMs
    })
  }
}
