import { describe, expect, it } from 'vitest'
import { cardFamily, type AnswerCard, type DiffCard, type PlanCard, type SendCard } from './hud'

/**
 * The one question a user has before touching the keyboard.
 *
 * It used to be answered four different ways by four card types, and the button
 * in the first position was sometimes the thing that writes, sometimes the thing
 * that starts a process, sometimes the thing that closes, and sometimes absent.
 * ⏎ therefore meant four things — which is how an **Apply** came to sit under a
 * summary of somebody's own notes, one reflexive Return from pasting it back in.
 *
 * Deriving it here is what makes that unrepeatable: a lane cannot set it, and a
 * new card kind cannot forget to decide, because the switch stops compiling.
 */

const diff: DiffCard = { kind: 'diff', app: 'Mail', segments: [], changes: 1 }
const send: SendCard = {
  kind: 'send',
  app: 'Slack',
  text: 'on my way',
  commit: { label: 'Send', hint: '⌘⏎', warning: 'sending can’t be undone' }
}
const answer: AnswerCard = { kind: 'answer', app: 'Notes', text: 'Three tasks remain.' }
const plan = (patch: Partial<PlanCard> = {}): PlanCard => ({
  kind: 'plan',
  steps: [],
  context: null,
  goal: 'open the conversation with Anil Turaga',
  app: 'Slack',
  limit: 6,
  running: false,
  ...patch
})
const step = { id: 'a', verb: 'press', object: 'Anil Turaga', state: 'done' as const }

describe('cardFamily', () => {
  it('puts everything that writes on fresh paper', () => {
    expect(cardFamily(diff)).toBe('will')
    expect(cardFamily(send)).toBe('will')
  })

  it('puts an answer in the well, always', () => {
    expect(cardFamily(answer)).toBe('wont')
  })

  /**
   * A plan is the only card that crosses. It is a proposal while Run is on
   * offer and while it walks, and a report the moment the walk is over.
   */
  it('crosses a plan over when its walk ends', () => {
    expect(cardFamily(plan())).toBe('will')
    expect(cardFamily(plan({ running: true, steps: [step] }))).toBe('will')
    expect(cardFamily(plan({ running: false, steps: [step] }))).toBe('wont')
    expect(cardFamily(plan({ running: false, answer: 'The redlines are with legal.' })))
      .toBe('wont')
  })

  /**
   * A plan that ran and came back empty-handed has still finished. Reading the
   * answer alone would leave a failed walk offering Run a second time — which
   * is exactly the bug: `running` going false put the button back.
   */
  it('finishes a plan that found nothing, not just one that found something', () => {
    expect(cardFamily(plan({ running: false, steps: [step], answer: null }))).toBe('wont')
  })
})
