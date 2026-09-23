import { randomUUID } from 'node:crypto'
import type { ScreenContext } from '@shared/context'
import type { AnswerCard } from '@shared/hud'
import type { HudLastAction } from '@shared/ipc'
import type { JournalDraft } from '@shared/types'
import type { Engine } from '../engine/types'
import type { JournalStore } from '../store/journal'
import type { CaptureStore } from '../store/captures'
import { Trace } from '../trace'
import type { RecentTurn } from '../services/turns'

/**
 * Answering a question about the window in front of you.
 *
 * The shortest lane in Mull: read what is on screen, ask the model, show the
 * answer. It has no target, writes nothing, and its card has no Apply.
 *
 * ### Why it is a lane at all, and not a compose
 *
 * It used to be one. "Summarize all my tasks which I need to complete", spoken
 * over a page of notes, came back as an **EDIT PREVIEW** — a diff card, every
 * line marked as an insertion, an Apply button, and `⌥Z undoes after apply`
 * underneath. The summary was correct and the card was offering to paste it
 * into the very notes it summarised. ⏎ means Apply on every other card in the
 * app, so the reflex that dismisses a card would have written into the
 * document instead.
 *
 * The two jobs look identical from inside the model — read the screen, produce
 * sentences — and they differ entirely in what the user wants done with the
 * result. "Reply to this" is text for the box. "What did they decide" is not
 * text at all; it is an answer. Splitting the route is how that difference
 * survives as far as the buttons.
 *
 * ### What it shares with navigation
 *
 * `Engine.answer` — the same turn, the same prompt. A navigation is this lane
 * with a walk in front of it: go somewhere, read, answer. Here the window is
 * already the right one, so only the last step is left.
 */

export interface AskRequest {
  /** What the user wants to know, in their own words. */
  question: string
  /** The raw transcript, for the journal row. Often the fuller spoken form. */
  transcript: string
  app: { bundleId: string; name: string } | null
  /** The window read at key-down — the whole material for the answer. */
  context?: ScreenContext | null
  routedBy?: string
  /**
   * What was asked just before this, so a follow-up has a subject.
   *
   * "And what about Priya" reaches this lane already expanded by the
   * classifier, but the *answer* to the previous question is not in the
   * expansion — and "is that before or after the deadline she gave?" is only
   * answerable against it.
   */
  recent?: RecentTurn[] | null
}

export interface AskDeps {
  engine: Engine
  hud: {
    openCard(card: AnswerCard, onAction: (action: 'apply' | 'apply-send' | 'cancel') => void): void
    updateCard(card: AnswerCard): void
    closeCard(): void
    /**
     * The working line under the label, and the row left behind afterwards.
     *
     * `lastAction` rides this port rather than `announce` because an answered
     * question keeps its card open until the user dismisses it — there is no
     * announcement to attach it to. Writing it into base state here means the
     * row is already correct underneath by the time the card goes away.
     */
    update?(patch: {
      stage?: string | null
      stageAt?: number | null
      lastAction?: HudLastAction | null
    }): void
    announce?(phase: 'applied' | 'error' | 'blocked', notice: string): void
  }
  journal?: JournalStore
  captures?: CaptureStore
  onJournalChanged?: () => void
  trace?: () => Trace
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export class AskLane {
  constructor(private readonly deps: AskDeps) {}

  async run(request: AskRequest): Promise<void> {
    const trace = this.deps.trace?.() ?? new Trace({ log: this.deps.log })
    const askMs = trace.mark()
    trace.step('ask.ask', {
      question: request.question,
      screen: request.context?.chars ?? 0,
      image: request.context?.image ? `${Math.round(request.context.image.bytes / 1024)}KB` : undefined
    })
    this.deps.hud.update?.({ stage: 'reading what it saw', stageAt: Date.now() })

    const card = (text: string): AnswerCard => ({
      kind: 'answer',
      app: request.app?.name ?? null,
      text
    })

    // The card opens on the first token rather than up front, so an empty box
    // never sits on screen waiting — the working line is already saying what is
    // happening, and it says it better than an empty card would.
    let opened = false
    const show = (text: string): void => {
      if (!opened) {
        opened = true
        // Nothing to accept and nothing to undo: whichever way it closes, it
        // closes. The handler exists so the panel returns to idle rather than
        // holding the card's phase forever.
        this.deps.hud.openCard(card(text), () => {
          this.deps.hud.update?.({ stage: null, stageAt: null })
        })
        return
      }
      this.deps.hud.updateCard(card(text))
    }

    try {
      const { text } = await this.deps.engine.answer(
        { goal: request.question, context: request.context, recent: request.recent ?? null },
        (partial) => {
          if (partial.trim()) show(partial)
        }
      )
      const answer = text.trim()
      trace.step('ask.done', { ms: askMs(), chars: answer.length })

      if (!answer) {
        // A model that answered with nothing has not answered. Say so rather
        // than showing an empty card, which reads as a bug in Mull.
        this.deps.hud.closeCard()
        this.deps.hud.update?.({ stage: null, stageAt: null })
        this.deps.hud.announce?.('error', 'Mull had nothing to say about this window.')
        this.record(request, null)
        return
      }

      show(answer)
      const entry = this.record(request, answer)
      // The answer, kept where the idle panel can still show it. Without this
      // the row underneath goes on describing whatever was dictated before the
      // question, and the answer is gone the moment the card is dismissed.
      this.deps.hud.update?.({
        stage: null,
        stageAt: null,
        lastAction: {
          summary: `Answered · ${request.app?.name ?? 'this app'} · “${request.question}”`,
          at: Date.now(),
          chars: answer.length,
          entryId: entry?.id ?? null,
          // An answer is read, never written. There is nothing to take back.
          undoable: false,
          result: answer
        }
      })
    } catch (err) {
      trace.fail('ask.failed', { ms: askMs() }, err)
      this.deps.log?.('warn', 'ask: the engine did not answer', err)
      this.deps.hud.closeCard()
      this.deps.hud.update?.({ stage: null, stageAt: null })
      this.deps.hud.announce?.(
        'error',
        `Couldn’t answer that: ${err instanceof Error ? err.message : String(err)}`
      )
      this.record(request, null)
    }
  }

  /**
   * One row, carrying the picture.
   *
   * An ask reads the window — and photographs it — exactly as an edit does, so
   * it owes the same receipt. Never throws: a question that was answered must
   * not fail after the fact because the journal would not take it.
   */
  private record(request: AskRequest, answer: string | null): { id: string } | null {
    if (!this.deps.journal) return null
    try {
      const id = randomUUID()
      const draft: JournalDraft = {
        id,
        intent: { kind: 'ask', question: request.question, transcript: request.transcript },
        app: request.app,
        before: null,
        after: answer,
        strategyUsed: null,
        status: answer ? 'applied' : 'failed',
        summary: `Answered · “${request.question}”`,
        verified: answer !== null,
        caret: null,
        // There is nothing to take back. No text was written anywhere, which is
        // the entire point of this lane.
        undoable: false,
        capture: this.deps.captures?.save(id, request.context) ?? null
      }
      this.deps.journal.append(draft)
      this.deps.onJournalChanged?.()
      return { id }
    } catch (err) {
      this.deps.log?.('error', 'ask: journal write failed', err)
      return null
    }
  }
}
