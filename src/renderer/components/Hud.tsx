import type { JSX } from 'react'
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
  now
}: {
  state: HudState
  onAction?: (action: HudAction) => void
  /** Injected so a statically-mounted HUD renders deterministically. */
  now?: number
}): JSX.Element {
  const view = hudView(state, now)

  return (
    <div className={`hud ${view.stateClass}`}>
      <div className="hud-top">
        <Orb />
        <Waveform />
        <div className="transcript" role="status" aria-live="polite">
          {view.transcript.ghost ? (
            <span className="ghost">{view.transcript.text}</span>
          ) : (
            <span>{view.transcript.text}</span>
          )}
          {view.transcript.caret ? <span className="caret" aria-hidden="true" /> : null}
        </div>
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

      {view.lastAction ? (
        <div className="last-action">
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
      ) : null}
    </div>
  )
}
