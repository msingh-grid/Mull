import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type RefObject
} from 'react'
import type { HudAction, HudState } from '@shared/ipc'
import { hudView } from '../hud/view-model'
import { Orb, Waveform } from './atoms'
import { Chips } from './Chips'
import { CardView } from './Cards'

/**
 * The HUD panel (docs/DESIGN.md §6.1).
 *
 * Renders `hudView(state)` and nothing else — every decision was made in the
 * view-model. The panel is also mounted, static, inside onboarding page 1, so
 * the first thing a new user meets is the real instrument at rest rather than
 * a picture of it.
 *
 * Accessibility (§8): orb and waveform are decoration; the state label and the
 * transcript are the live region.
 */
export function Hud({
  state,
  onAction,
  onThinking,
  onAutoRun,
  onCorrect,
  now
}: {
  state: HudState
  onAction?: (action: HudAction) => void
  /** Arm or disarm thinking for the writing lanes. Absent in the demo HUD. */
  onThinking?: (on: boolean) => void
  /**
   * Arm or disarm starting a run without pressing Run. Absent in the demo HUD,
   * which has no lane behind it to start.
   */
  onAutoRun?: (on: boolean) => void
  /**
   * Correct what Mull heard. Absent in the demo HUD, which has no pipeline
   * behind it to run again.
   *
   * `begin` asks main for the keyboard; `end` gives it back, with the corrected
   * words or with null for "never mind". Both halves are needed because the
   * panel is not focusable and does not own its own chords — see
   * `services/chords.ts`.
   */
  onCorrect?: { begin: () => void; end: (text: string | null) => void }
  /** Injected so a statically-mounted HUD renders deterministically. */
  now?: number
}): JSX.Element {
  const view = hudView(state, now)
  const correcting = useCorrection(view.transcript, onCorrect)

  return (
    <div className={`hud ${view.stateClass}`}>
      <div className="hud-top">
        <Orb />
        <Waveform />
        {/*
          The transcript, and — while a card is waiting on an answer — the one
          thing on this panel you fix by touching it rather than by pressing
          something. Whisper mishears names, and the card on screen was built
          from the misheard one; clicking the line opens it for editing and ⏎
          runs the whole utterance again from the corrected words.

          No pencil, no Edit button. A button here would be a third thing
          competing with Apply and Cancel for the same glance, to say something
          the caret already says the moment you hover.
        */}
        {correcting.open ? (
          <textarea
            ref={correcting.ref}
            className="transcript transcript-edit"
            value={correcting.draft}
            rows={2}
            spellCheck={false}
            aria-label="Correct what Mull heard, then press Return to run it again"
            onChange={(event) => correcting.setDraft(event.target.value)}
            onKeyDown={correcting.onKeyDown}
            onBlur={correcting.commit}
          />
        ) : (
          <div
            className={`transcript${view.transcript.editable ? ' is-correctable' : ''}`}
            role="status"
            aria-live="polite"
            title={view.transcript.editable ? 'Misheard? Click to correct it.' : undefined}
            onClick={correcting.start}
          >
            {view.transcript.ghost ? (
              <span className="ghost">{view.transcript.text}</span>
            ) : (
              <span>{view.transcript.text}</span>
            )}
            {view.transcript.caret ? <span className="caret" aria-hidden="true" /> : null}
          </div>
        )}
        <div className="state-label">
          {view.label}
          {/* The seconds tick in the label's own column rather than in the
              working line below, so a long wait grows a number instead of
              shifting the layout under it. */}
          {view.stage?.seconds ? (
            <span className="state-elapsed"> {view.stage.seconds}s</span>
          ) : null}
        </div>
      </div>

      {view.stage ? (
        <div className="stage" role="status" aria-live="polite">
          <span className="stage-pulse" aria-hidden="true" />
          {view.stage.text}
        </div>
      ) : null}

      <Chips chips={view.chips} />

      {view.card ? <CardView card={view.card} onAction={onAction} /> : null}

      {view.notice ? <div className="notice">{view.notice}</div> : null}

      {/*
        The two things you arm before speaking rather than after, on one row.
        Both are decisions about the sentence you are on the point of saying —
        one buys deliberation, the other spends the press that would have
        followed — and neither is a thing anybody opens a preferences window
        for mid-thought. They share `.think` because they are the same kind of
        control, and the armed treatment is the same warn wash: on is the state
        worth noticing from across the desk.

        Both labels are short enough that the row holds at 480px with both
        armed. The sentence each one used to grow into when armed ("slower, for
        hard writing") moved to `title`: it is worth reading once and never
        again, and paying for it in a second row of chrome — on a panel whose
        whole argument is that it stays out of the way — was the wrong trade.
      */}
      {(view.thinking && onThinking) || (view.autoRun && onAutoRun) ? (
        <div className="arms">
          {view.thinking && onThinking ? (
            <button
              type="button"
              className={`think ${view.thinking.on ? 'is-on' : ''}`}
              aria-pressed={view.thinking.on}
              title="Let the writing lanes deliberate before answering. Much slower — worth it for a hard piece of writing and for nothing else."
              onClick={() => onThinking(!view.thinking?.on)}
            >
              <span className="dot" aria-hidden="true" />
              {view.thinking.on ? 'thinking on · slower' : 'thinking'}
            </button>
          ) : null}
          {view.autoRun && onAutoRun ? (
            <button
              type="button"
              className={`think ${view.autoRun.on ? 'is-on' : ''}`}
              aria-pressed={view.autoRun.on}
              title="Start a run as soon as it is proposed, instead of waiting for Run. The card still opens and esc still stops it — but a misheard goal starts moving before you have read it."
              onClick={() => onAutoRun(!view.autoRun?.on)}
            >
              <span className="dot" aria-hidden="true" />
              {view.autoRun.on ? 'auto-run on · skips Run' : 'auto-run'}
            </button>
          ) : null}
        </div>
      ) : null}

      {view.lastAction ? (
        <div className="last-action">
          <div className="last-action-meta">
            <span>{view.lastAction.summary}</span>
            <span className="sep">·</span>
            <span>{view.lastAction.when}</span>
            {/* Offered only when undo would actually work — the journal's
                `undoable` flag, not a hopeful button (docs/DESIGN.md §7.2). */}
            {view.lastAction.undoable ? (
              <span className="undo">
                <kbd>⌥Z</kbd> undo
              </span>
            ) : null}
          </div>
          {/* What it produced, for the lanes that produce something to read.
              The line above names the request; without this the panel answers
              a question by repeating it back. */}
          {view.lastAction.result ? (
            <div className="last-action-result">{view.lastAction.result}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The transcript, while it is being corrected.
 *
 * Kept here rather than in the renderer's top-level state because it is
 * interface state and nothing else: main learns about it twice, at the start
 * (to lend the panel the keyboard) and at the end (with the words, or without
 * them). Between those two moments nothing outside this component needs to
 * know, and a round trip per keystroke would make typing feel like dictation.
 *
 * Every way out goes through `finish`, exactly once. Return commits, Escape
 * abandons, and losing focus commits — including the focus lost to the app the
 * panel is about to hand the caret back to, which is why the guard is a ref and
 * not a piece of state: the blur arrives after the re-render that closed the
 * field.
 */
function useCorrection(
  transcript: { text: string; editable: boolean },
  onCorrect?: { begin: () => void; end: (text: string | null) => void }
): {
  open: boolean
  draft: string
  ref: RefObject<HTMLTextAreaElement | null>
  setDraft: (text: string) => void
  start: () => void
  commit: () => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
} {
  const [draft, setDraft] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  const open = draft !== null && onCorrect !== undefined

  // Focus and select on open. A correction is nearly always one word in a
  // sentence, so the caret goes to the end rather than over the whole thing —
  // selecting it all would make the first keystroke destroy what you came to
  // fix.
  useEffect(() => {
    if (!open) return
    const field = ref.current
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }, [open])

  // The card went away underneath the field — a new utterance, a lane that
  // closed itself. There is nothing left to re-run against, so the correction
  // ends without one.
  useEffect(() => {
    if (draft === null || transcript.editable) return
    setDraft(null)
    if (!done.current) {
      done.current = true
      onCorrect?.end(null)
    }
  }, [draft, transcript.editable, onCorrect])

  const finish = (text: string | null): void => {
    if (done.current) return
    done.current = true
    setDraft(null)
    onCorrect?.end(text)
  }

  return {
    open,
    draft: draft ?? '',
    ref,
    setDraft,
    start: () => {
      if (!transcript.editable || !onCorrect || draft !== null) return
      done.current = false
      setDraft(transcript.text)
      onCorrect.begin()
    },
    commit: () => finish(draft !== null && draft.trim() !== transcript.text ? draft : null),
    onKeyDown: (event) => {
      // ⇧⏎ is a newline, the way it is in every other field — a transcript can
      // be two sentences, and the only key that runs it should be the plain one.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        finish(draft !== null && draft.trim() !== transcript.text ? draft : null)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(null)
      }
    }
  }
}
