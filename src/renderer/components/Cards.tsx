import type { JSX } from 'react'
import type {
  AnswerCard,
  DiffCard,
  DiffSegment,
  HudCard,
  PlanCard,
  PlanStepState,
  SendCard
} from '@shared/hud'
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
  const scope = [card.app, card.limit ? `up to ${card.limit} steps` : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="card">
      <div className="card-title">
        <span>
          Plan{scope ? ` · ${scope}` : ` · ${card.steps.length} ${card.steps.length === 1 ? 'step' : 'steps'}`}
        </span>
        {card.context ? <span className="count">{card.context}</span> : null}
      </div>
      {card.goal ? (
        <div className="plan-goal">
          <span className="n">goal</span>
          <span className="what">{card.goal}</span>
        </div>
      ) : null}
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
        {/*
          What was found, under the steps that found it. Streams in, so the
          card is visibly writing rather than sitting still — and it is the
          only part of a plan card the user is actually reading for.
        */}
        {card.answer ? <div className="plan-answer">{card.answer}</div> : null}
      </div>
      <div className="card-actions">
        {card.running ? null : (
          <Btn kind="primary" hint="⏎" onClick={() => onAction?.('apply')}>
            Run
          </Btn>
        )}
        <Btn hint="esc" onClick={() => onAction?.('cancel')}>
          {card.running ? 'Stop' : 'Cancel'}
        </Btn>
        <span className="undo-promise">{card.note ?? 'each step journaled'}</span>
      </div>
    </div>
  )
}

/**
 * The bare-send card: "send the message", over a composer already full.
 *
 * What it shows is not a proposal — it is the text that is about to leave,
 * read back out of the app a moment ago. Hence no diff marks and no Apply:
 * there is nothing to write, only something to check. The body carries the
 * `is-quote` class so it reads as *their* words rather than Mull's ink.
 *
 * ⏎ is deliberately absent from this card. Mull holds Return globally while a
 * card is open, so an accidental press cannot reach Slack and send the very
 * message this card is still asking about — it simply does nothing.
 */
function SendCardView({
  card,
  onAction
}: {
  card: SendCard
  onAction?: (action: HudAction) => void
}): JSX.Element {
  return (
    <div className="card">
      <div className="card-title">
        <span>Send{card.app ? ` · ${card.app}` : ''}</span>
        <span className="count">already written</span>
      </div>
      <div className="card-body is-quote">{card.text}</div>
      <div className="card-actions">
        <Btn kind="send" hint={card.commit.hint} onClick={() => onAction?.('apply-send')}>
          {card.commit.label}
        </Btn>
        <Btn hint="esc" onClick={() => onAction?.('cancel')}>
          Cancel
        </Btn>
        <span className="undo-promise is-warning">{card.commit.warning}</span>
      </div>
    </div>
  )
}

/**
 * An answer, and nothing to do with it.
 *
 * The one card with no commit of any kind. "Summarize the tasks I need to
 * finish" used to come back as a diff card with an **Apply** that would write
 * the summary into the note being read — and ⏎, which means Apply everywhere
 * else, would do it by reflex. There is nothing here to apply, so the card says
 * so in the place every other card puts its warning.
 */
function AnswerCardView({
  card,
  onAction
}: {
  card: AnswerCard
  onAction?: (action: HudAction) => void
}): JSX.Element {
  return (
    <div className="card">
      <div className="card-title">
        <span>Answer{card.app ? ` · ${card.app}` : ''}</span>
      </div>
      <div className="card-body is-answer">{card.text}</div>
      <div className="card-actions">
        {/* `cancel`, not `apply`: closing is the only thing this card does. The
            ⏎ hint is honest because the HUD reads Return as done here — see
            `acceptsApply` in services/hud.ts. */}
        <Btn kind="primary" hint="⏎" onClick={() => onAction?.('cancel')}>
          Done
        </Btn>
        <span className="undo-promise">nothing was written</span>
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
  if (card.kind === 'diff') return <DiffCardView card={card} onAction={onAction} />
  if (card.kind === 'send') return <SendCardView card={card} onAction={onAction} />
  if (card.kind === 'answer') return <AnswerCardView card={card} onAction={onAction} />
  return <PlanCardView card={card} onAction={onAction} />
}
