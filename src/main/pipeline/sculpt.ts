import type { ScreenContext } from '@shared/context'
import type { HudAction, HudCard, HudChip } from '@shared/hud'
import type { HudState } from '@shared/ipc'
import type { SidecarApi } from '@shared/sidecar-api'
import type { JournalDraft, JournalEntry } from '@shared/types'
import type { Bench } from '../bench'
import type { Engine, EngineState } from '../engine/types'
import { describeInsertionReason, type InsertionService } from '../services/insertion'
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
}

const INTENT_CHIP: HudChip = { kind: 'intent', label: 'Edit', id: 'intent' }

/** State carried between `run` and the card's answer, which can arrive first. */
interface Session {
  answered: boolean
  failure: string | null
  firstTokenMs: number | null
  startedAt: number
}

export class SculptLane {
  private readonly now: () => number
  private readonly log: NonNullable<SculptDeps['log']>

  constructor(private readonly deps: SculptDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? ((): void => {})
  }

  async run(request: SculptRequest): Promise<void> {
    const session: Session = {
      answered: false,
      failure: null,
      firstTokenMs: null,
      startedAt: this.now()
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
          : 'to cursor'
    const appName = request.app?.name ?? null
    const cardApp = appName ? `${appName} — ${scope}` : scope

    this.deps.hud.update({
      phase: 'thinking',
      transcript: request.instruction,
      partial: false,
      notice: null,
      chips: [INTENT_CHIP, { kind: 'dict', label: cardApp, id: 'target' }]
    })

    // Started before the card is opened so the first token can land in it, but
    // never awaited here — the card must be on screen (and escapable) while
    // the engine is still writing.
    const stream = this.deps.engine
      .transform(
        {
          instruction: request.instruction,
          text: before,
          app: request.app,
          context: request.context ?? null
        },
        (partial) => {
          if (session.firstTokenMs === null) session.firstTokenMs = this.now() - session.startedAt
          const { segments, changes } = diffText(before, partial)
          this.deps.hud.updateCard({ kind: 'diff', app: cardApp, segments, changes })
        }
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

    this.deps.hud.openCard({ kind: 'diff', app: cardApp, segments: [], changes: 0 }, (action) => {
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
      this.fail(request, session, `The engine couldn’t finish that edit: ${session.failure}`)
      return
    }

    const final = diffText(before, after)
    if (final.changes === 0) {
      // An honest outcome, and a common one on text that is already tight.
      // Showing an empty card would ask the user to approve nothing.
      this.deps.hud.closeCard()
      this.record(request, session, {
        outcome: 'refused',
        reason: 'no-change',
        after,
        changes: 0,
        insertMs: 0
      })
      this.deps.hud.announce('applied', 'Nothing to change — that already reads well.')
      return
    }

    this.deps.hud.updateCard({
      kind: 'diff',
      app: cardApp,
      segments: final.segments,
      changes: final.changes
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
      this.fail(request, session, `The engine couldn’t finish that edit: ${session.failure}`)
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
        summary: `Edit declined · ${request.app?.name ?? 'this app'} · “${summarise(request.instruction)}”`,
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
        summary: `Edit refused · ${message}`,
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
        summary: `Edit · ${request.app?.name ?? 'this app'} — not applied`,
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

    const summary = `Edit · ${request.app?.name ?? 'this app'} · “${summarise(request.instruction)}”`
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
      before: request.target.kind === 'reference' ? null : outcome.replacedText ?? request.target.text,
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

    this.record(request, session, {
      outcome: 'applied',
      after,
      changes: diffText(request.target.text, after).changes,
      insertMs,
      strategy: outcome.strategyUsed
    })

    this.log('info', 'edit applied', {
      chars: after.length,
      strategy: outcome.strategyUsed,
      verified: outcome.verified,
      firstTokenMs: session.firstTokenMs
    })

    this.deps.hud.announce('applied', 'Edit applied.', {
      summary,
      at: this.now(),
      chars: after.length,
      entryId: entry?.id ?? null,
      undoable: entry?.undoable ?? false
    })
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
    if (target.kind === 'reference') {
      // Insert, don't replace. There is nothing here Mull is allowed to
      // destroy, which also makes this the one path with no `before`.
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
      summary: `Edit withheld · ${state.kind === 'signed-out' ? 'no engine' : 'local-only'} · “${summarise(request.instruction)}”`,
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
      summary: `Edit failed · “${summarise(request.instruction)}”`,
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
      engineMs: this.now() - session.startedAt - outcome.insertMs,
      insertMs: outcome.insertMs,
      totalMs: this.now() - session.startedAt
    })
  }
}
