import type { JSX } from 'react'
import {
  cardFamily,
  type AnswerCard,
  type DiffCard,
  type DiffSegment,
  type HudCard,
  type PlanCard,
  type PlanStepState,
  type SendCard
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
    <div className={`card is-${cardFamily(card)}`}>
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
      </div>
      {/*
        Under the buttons, not out at the right margin. The promise describes
        what Apply costs, and three hundred pixels of separation from the
        button it describes is how an Apply ended up under an answer with the
        only thing that would have warned you set in 11px grey, far away.
      */}
      <div className={`promise${card.commit ? ' is-warning' : ''}`}>
        {card.commit ? (
          card.commit.warning
        ) : (
          <>
            <kbd>⌥Z</kbd> undoes this after you apply it
          </>
        )}
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

/**
 * A plan, and then a report — the same card, twice.
 *
 * While it waits for Run and while it walks, it is a proposal on fresh paper
 * with the one filled button in the app. The moment the walk is over it settles
 * into the desk: the ground recesses, Run becomes Done, and ⏎ closes instead of
 * starting a second walk — which it used to do, because `running` going false
 * put the Run button straight back on a card that had already finished.
 *
 * The steps stay either way. They are how the answer was come by, and a report
 * that hid its working would be a worse report.
 */
function PlanCardView({
  card,
  onAction
}: {
  card: PlanCard
  onAction?: (action: HudAction) => void
}): JSX.Element {
  const family = cardFamily(card)
  const over = family === 'wont'
  // `auto` sits in the title rather than replacing the promise line, which is
  // carrying the clause that matters most ("nothing is submitted"). It is here
  // at all because a card that starts walking with nobody pressing anything
  // has to account for itself — see `PlanCard.auto`.
  const auto = card.auto === true && !over
  const scope = [card.app, card.limit && !over ? `up to ${card.limit} steps` : null, auto ? 'auto' : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className={`card is-${family}`}>
      <div className="card-title">
        <span>
          {over ? 'Answer' : 'Plan'}
          {scope ? ` · ${scope}` : ` · ${card.steps.length} ${card.steps.length === 1 ? 'step' : 'steps'}`}
        </span>
        {card.context ? <span className="count">{card.context}</span> : null}
      </div>
      {card.goal && !over ? (
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
      </div>
      {/*
        What was found, under the steps that found it — and *outside* the
        scrolling body, which is the whole point. It used to sit inside, where
        the steps and the answer shared one 150px window: two short steps and it
        showed, six and the thing the user actually asked for had scrolled out of
        sight under the thing that fetched it.

        Streams in, so the card is visibly writing rather than sitting still.
      */}
      {card.answer ? <div className="plan-answer">{card.answer}</div> : null}
      <div className="card-actions">
        {/*
          No Run on an auto-run card even before the first draw arrives. The
          walk has already been started by the time this renders, so the button
          would be an offer to do something that is happening — and ⏎ on it is
          claimed and inert (`HudController.act`), which is a button that
          visibly does nothing.
        */}
        {card.running || over || auto ? null : (
          <Btn kind="primary" hint="⏎" onClick={() => onAction?.('apply')}>
            Run
          </Btn>
        )}
        <Btn hint={over ? '⏎' : 'esc'} onClick={() => onAction?.('cancel')}>
          {card.running || auto ? 'Stop' : over ? 'Done' : 'Cancel'}
        </Btn>
      </div>
      <div className="promise">{card.note ?? 'each step journaled'}</div>
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
    <div className={`card is-${cardFamily(card)}`}>
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
      </div>
      <div className="promise is-warning">{card.commit.warning}</div>
    </div>
  )
}

/**
 * An answer, and nothing to do with it.
 *
 * The one card with no commit of any kind. "Summarize the tasks I need to
 * finish" used to come back as a diff card with an **Apply** that would write
 * the summary into the note being read — and ⏎, which means Apply everywhere
 * else, would do it by reflex.
 *
 * Done is a *ghost* button, not the filled one it shipped as. A filled accent
 * button is this app's word for "this commits", and spending it on the one card
 * that commits nothing is the same mistake in a quieter voice.
 */
function AnswerCardView({
  card,
  onAction
}: {
  card: AnswerCard
  onAction?: (action: HudAction) => void
}): JSX.Element {
  return (
    <div className={`card is-${cardFamily(card)}`}>
      <div className="card-title">
        <span>Answer{card.app ? ` · ${card.app}` : ''}</span>
      </div>
      <div className="card-body is-answer">{card.text}</div>
      <div className="card-actions">
        {/* `cancel`, not `apply`: closing is the only thing this card does. The
            ⏎ hint is honest because the HUD reads Return as done on any `wont`
            card — see `cardFamily` and `acceptsApply` in services/hud.ts. */}
        <Btn hint="⏎" onClick={() => onAction?.('cancel')}>
          Done
        </Btn>
      </div>
      <div className="promise">Nothing was written.</div>
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
