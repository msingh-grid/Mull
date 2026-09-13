import type { JSX } from 'react'
import type { DiffCard, DiffSegment, HudCard, PlanCard, PlanStepState } from '@shared/hud'
import type { HudAction } from '@shared/ipc'
import { Btn } from './atoms'

/**
 * Diff and plan cards (docs/DESIGN.md §6.3, §6.4).
 *
 * A card is a **proposal**: nothing it describes has happened. Both cards
 * therefore state their undo path in the same breath as their action (§7.2),
 * and neither runs anything on arrival.
 */

/**
 * The marks themselves. Exported on its own because the journal window renders
 * the identical thing when a row is expanded — one implementation, so a diff
 * can never look like one thing in the HUD and another in the record.
 */
export function DiffBody({ segments }: { segments: DiffSegment[] }): JSX.Element {
  return (
    <div className="card-body">
      {segments.map((segment, index) => {
        if (segment.kind === 'del') return <del key={index}>{segment.text}</del>
        if (segment.kind === 'ins') return <ins key={index}>{segment.text}</ins>
        return <span key={index}>{segment.text}</span>
      })}
    </div>
  )
}

function DiffCardView({
  card,
  onAction
}: {
  card: DiffCard
  onAction?: (action: HudAction) => void
}): JSX.Element {
  return (
    <div className="card">
      <div className="card-title">
        <span>Edit preview{card.app ? ` · ${card.app}` : ''}</span>
        <span className="count">
          {card.changes} {card.changes === 1 ? 'change' : 'changes'}
        </span>
      </div>
      <DiffBody segments={card.segments} />
      <div className="card-actions">
        <Btn kind="primary" hint="⏎" onClick={() => onAction?.('apply')}>
          Apply
        </Btn>
        {/*
          The second commit, when there is one. Rendered *after* Apply and never
          as the primary: Apply is what ⏎ has always done on this card, and a
          send that looked like the default would be one someone pressed by
          habit. Its warning replaces the undo promise rather than sitting
          beside it, because "⌥Z undoes after apply" is not true of the button
          next to it and two promises would be one too many to read (§7.2).
        */}
        {card.commit ? (
          <Btn kind="send" hint={card.commit.hint} onClick={() => onAction?.('apply-send')}>
            {card.commit.label}
          </Btn>
        ) : null}
        <Btn hint="esc" onClick={() => onAction?.('cancel')}>
          Cancel
        </Btn>
        <span className={`undo-promise${card.commit ? ' is-warning' : ''}`}>
          {card.commit ? (
            card.commit.warning
          ) : (
            <>
              <kbd>⌥Z</kbd> undoes after apply
            </>
          )}
        </span>
      </div>
    </div>
  )
}

const STEP_GLYPH: Record<PlanStepState, string> = {
  pending: '·',
  running: '…',
  done: '✓',
  failed: '✕'
}

function PlanCardView({
  card,
  onAction
}: {
  card: PlanCard
  onAction?: (action: HudAction) => void
}): JSX.Element {
  return (
    <div className="card">
      <div className="card-title">
        <span>
          Plan · {card.steps.length} {card.steps.length === 1 ? 'step' : 'steps'}
        </span>
        {card.context ? <span className="count">{card.context}</span> : null}
      </div>
      <div className="card-body">
        {card.steps.map((step, index) => (
          <div key={step.id} className={`plan-step is-${step.state}`}>
            <span className="n">{index + 1}.</span>
            <span className="what">
              {step.verb} {step.object}
            </span>
            <span className="st" aria-label={step.state}>
              {STEP_GLYPH[step.state]}
            </span>
          </div>
        ))}
      </div>
      <div className="card-actions">
        <Btn kind="primary" hint="⏎" onClick={() => onAction?.('apply')}>
          Run
        </Btn>
        <Btn hint="esc" onClick={() => onAction?.('cancel')}>
          Cancel
        </Btn>
        <span className="undo-promise">each step journaled</span>
      </div>
    </div>
  )
}

export function CardView({
  card,
  onAction
}: {
  card: HudCard
  onAction?: (action: HudAction) => void
}): JSX.Element {
  return card.kind === 'diff' ? (
    <DiffCardView card={card} onAction={onAction} />
  ) : (
    <PlanCardView card={card} onAction={onAction} />
  )
}
