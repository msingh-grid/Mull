import type { ScreenContext } from '@shared/context'
import type { CardCommit, HudAction, HudCard, HudChip } from '@shared/hud'
import type { HudState } from '@shared/ipc'
import type { SidecarApi } from '@shared/sidecar-api'
import type { JournalDraft, JournalEntry } from '@shared/types'
import type { Bench } from '../bench'
import type { Engine, EngineState } from '../engine/types'
import { describeInsertionReason, type InsertionService } from '../services/insertion'
import { sendChord, type SendChord } from '../services/send-table'
import type { JournalStore } from '../store/journal'
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
  bench?: Bench
  onJournalChanged?: () => void
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  now?: () => number
  /** Let the target app service a send before reading the composer back. */
  sleep?: (ms: number) => Promise<void>
}

const INTENT_CHIP: HudChip = { kind: 'intent', label: 'Edit', id: 'intent' }
const DRAFT_CHIP: HudChip = { kind: 'intent', label: 'Reply', id: 'intent' }

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

/**
 * What to tell the user about the send, in one sentence.
 *
 * Three outcomes, three sentences, and the middle one is the reason this
 * function exists: Mull must never say "sent" about something it did not watch
 * leave, and must never say "failed" about something that may well have gone.
 * Both mistakes cost the user a duplicate message or a missing one, and neither
 * is recoverable from inside this app.
 */
function describeSend(outcome: SendOutcome, appName: string | null): string {
  const where = appName ? ` in ${appName}` : ''
  if (outcome.sent === true) return `Sent${where}.`
  if (outcome.sent === 'unknown') {
    return `Applied — Mull couldn’t confirm the send${where}. Check the window.`
  }
  switch (outcome.reason) {
    case 'different-app':
      return `You’ve switched apps — the text was applied, but nothing was sent.`
    case 'chord-refused':
      return `The text was applied, but Mull couldn’t press send${
        outcome.detail ? ` (${outcome.detail})` : ''
      }.`
    case 'unchanged':
      return `The text is in${where}, but it didn’t send — press send yourself.`
    default:
      return `The text was applied, but nothing was sent.`
  }
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

/**
 * How long to let the app act on the send chord before reading the box back.
 *
 * The same shape of number as `insertion-table.ts`'s `settleMs`, and for the
 * same reason: the keystroke returns the instant the window server accepts it,
 * which says nothing about whether the app has done anything with it yet.
 * Reading too early would report "unchanged" on a send that was simply still in
 * flight, which is the one wrong answer that matters here — it would invite the
 * user to press send again on a message that had already gone.
 */
const SEND_SETTLE_MS = 320

/** What the read-back found. `unknown` is a real answer and is said out loud. */
type SendOutcome =
  | { sent: true }
  | { sent: false; reason: 'no-chord' | 'different-app' | 'chord-refused'; detail: string | null }
  /** The chord went in and the composer did not empty. Probably nothing happened. */
  | { sent: false; reason: 'unchanged'; detail: null }
  /** Mull could not read the box afterwards, so it will not claim either way. */
  | { sent: 'unknown' }

export class SculptLane {
  private readonly now: () => number
  private readonly log: NonNullable<SculptDeps['log']>
  private readonly sleep: NonNullable<SculptDeps['sleep']>

  constructor(private readonly deps: SculptDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? ((): void => {})
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  async run(request: SculptRequest): Promise<void> {
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
    const onPartial = (partial: string): void => {
      if (session.firstTokenMs === null) session.firstTokenMs = this.now() - session.startedAt
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
        this.log('error', 'sculpt: the engine failed', err)
        return before
      })

    this.deps.hud.openCard({ kind: 'diff', app: cardApp, segments: [], changes: 0, commit }, (action) => {
      session.answered = true
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

  // -------------------------------------------------------------------------

  private async answer(
    action: HudAction,
    request: SculptRequest,
    stream: Promise<string>,
    session: Session
  ): Promise<void> {
    const after = await stream
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
      const sent = await this.send(request, session.chord, after)
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
   * Press the app's send chord, then go and look.
   *
   * The read-back is the whole method. `keyChord` reports that the window
   * server accepted the event, which is not the same claim as "the message
   * went" — the app may have a different preference set, the composer may not
   * have had focus, the chord may be bound to something else entirely. Nothing
   * in macOS will tell us. So Mull re-reads the box it just filled and answers
   * from what it finds:
   *
   *   empty, or no longer holding the draft   -> sent
   *   still holding the draft                 -> not sent, and say so
   *   unreadable                              -> unknown, and say that instead
   *
   * The third case is a real outcome, not a failure of nerve. Mail's ⌘⇧D closes
   * the compose window, so there is frequently nothing left to read; claiming
   * success there would be a guess, and claiming failure would send the user
   * back to press Return on a message that has already gone.
   *
   * The app is checked once more first. Between Apply and this line the user
   * could have switched windows, and a Return pressed into the wrong app is
   * precisely the harm this feature has to not cause.
   */
  private async send(
    request: SculptRequest,
    chord: SendChord,
    text: string
  ): Promise<SendOutcome> {
    const outcome = await this.pressSend(request, chord, text)
    const ok = outcome.sent === true
    const name = request.app?.name ?? 'this app'

    this.journal({
      // A whitelisted verb with a fixed argument list — the same shape M5's
      // command table will use, and deliberately not an `edit`. A reader
      // scanning the journal for "what did Mull actually do out there" should
      // find this row as its own event, not as an adjective on the edit above.
      intent: {
        kind: 'command',
        verb: 'send',
        args: { app: request.app?.bundleId ?? null, chord: chord.hint },
        transcript: request.transcript
      },
      app: request.app,
      before: null,
      after: null,
      strategyUsed: null,
      status: ok ? 'applied' : outcome.sent === 'unknown' ? 'applied' : 'failed',
      summary: ok
        ? `Sent · ${name}`
        : outcome.sent === 'unknown'
          ? `Sent · ${name} — unconfirmed`
          : `Send failed · ${name} · ${outcome.reason}`,
      verified: outcome.sent === 'unknown' ? null : ok,
      caret: null,
      // Not a claim about how well it went. There is no keystroke that unsends
      // a message, so there is nothing for ⌥Z to offer and it must not pretend
      // otherwise — `UndoService` refuses this row by name.
      undoable: false
    })

    this.log(ok ? 'info' : 'warn', 'sculpt: send', {
      app: request.app?.bundleId ?? null,
      chord: chord.hint,
      sent: outcome.sent,
      reason: outcome.sent === true || outcome.sent === 'unknown' ? null : outcome.reason
    })
    return outcome
  }

  /** The mechanics, so `send` can be about the record and this about the keys. */
  private async pressSend(
    request: SculptRequest,
    chord: SendChord,
    text: string
  ): Promise<SendOutcome> {
    if (request.app) {
      const front = await this.deps.sidecar.frontmostApp({}).catch(() => null)
      if (front?.app && front.app.bundleId !== request.app.bundleId) {
        return { sent: false, reason: 'different-app', detail: front.app.name }
      }
    }

    const pressed = await this.deps.sidecar
      .keyChord({ key: chord.key, modifiers: chord.modifiers })
      .catch((err: unknown) => {
        this.log('error', 'sculpt: keyChord threw', err)
        return { sent: false, reason: 'failed' as string | null }
      })
    if (!pressed.sent) {
      return { sent: false, reason: 'chord-refused', detail: pressed.reason }
    }

    await this.sleep(SEND_SETTLE_MS)

    const composer = await this.deps.sidecar
      .focusedElement({ contextBytes: 4_096 })
      .catch(() => null)
    if (!composer?.element) return { sent: 'unknown' }

    const remaining = composer.element.text
    if (!remaining.trim()) return { sent: true }
    // A composer that still holds the draft is a composer that did not send it.
    // Compared by containment rather than equality because some apps keep a
    // trailing newline or a quoted header around whatever was typed.
    if (remaining.includes(text.trim())) return { sent: false, reason: 'unchanged', detail: null }
    return { sent: true }
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
  private journal(draft: JournalDraft): JournalEntry | null {
    if (!this.deps.journal) return null
    try {
      const entry = this.deps.journal.append(draft)
      this.deps.onJournalChanged?.()
      return entry
    } catch (err) {
      this.log('error', 'journal write failed', err)
      return null
    }
  }

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
