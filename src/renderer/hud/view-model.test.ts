import { describe, expect, it } from 'vitest'
import { IDLE_HUD_STATE, type HudPhase, type HudState } from '@shared/ipc'
import type { DiffCard } from '@shared/hud'
import { hudView, relativeTime } from './view-model'

const state = (patch: Partial<HudState>): HudState => ({ ...IDLE_HUD_STATE, ...patch })

const diffCard: DiffCard = {
  kind: 'diff',
  app: 'Mail',
  segments: [{ kind: 'ins', text: 'Following up:' }],
  changes: 1
}

const ALL_PHASES: HudPhase[] = [
  'idle',
  'listening',
  'thinking',
  'inserting',
  'applied',
  'blocked',
  'error',
  'preview'
]

describe('hudView', () => {
  it('gives every phase a state class and a label', () => {
    for (const phase of ALL_PHASES) {
      const view = hudView(state({ phase }))
      expect(view.stateClass).toMatch(/^is-[a-z]+$/)
      expect(view.label).toMatch(/^[A-Z]+$/)
    }
  })

  it('shows the ghost hint only when idle and silent', () => {
    expect(hudView(state({})).transcript).toEqual({
      text: 'Hold ⌥Space to dictate · Fn to ask',
      ghost: true,
      caret: false
    })
    expect(hudView(state({ phase: 'listening', partial: true })).transcript).toEqual({
      text: '',
      ghost: false,
      caret: true
    })
  })

  it('shows a caret only while the transcript is still growing', () => {
    expect(hudView(state({ phase: 'listening', transcript: 'send the', partial: true })).transcript)
      .toEqual({ text: 'send the', ghost: false, caret: true })
    expect(hudView(state({ phase: 'thinking', transcript: 'send the deck', partial: false })).transcript)
      .toEqual({ text: 'send the deck', ghost: false, caret: false })
  })

  it('holds the THINKING label until the card can actually be judged', () => {
    expect(hudView(state({ phase: 'preview', card: null })).label).toBe('THINKING')
    expect(hudView(state({ phase: 'preview', card: diffCard })).label).toBe('PREVIEW')
  })

  /**
   * The card is the fact; the phase is a claim about it. Reading the label off
   * `phase` alone meant every lane had to remember to announce one — and the
   * navigator did not, so a plan card sat under the word THINKING and stayed
   * there after the plan had finished and the window had been put back.
   */
  it('says PREVIEW whenever a card is open, whatever the phase claims', () => {
    for (const phase of ['thinking', 'listening', 'inserting'] as const) {
      expect(hudView(state({ phase, card: diffCard })).label).toBe('PREVIEW')
    }
  })

  it('treats inserting as thinking visually, but says INSERTING', () => {
    const view = hudView(state({ phase: 'inserting' }))
    expect(view.stateClass).toBe('is-thinking')
    expect(view.label).toBe('INSERTING')
  })

  it('takes mouse events only while a card is open', () => {
    expect(hudView(state({ phase: 'idle' })).interactive).toBe(false)
    expect(hudView(state({ phase: 'listening' })).interactive).toBe(false)
    expect(hudView(state({ phase: 'preview', card: diffCard })).interactive).toBe(true)
  })

  it('shows the last-action ghost only when idle', () => {
    const lastAction = {
      summary: 'Dictation · Mail',
      at: 1_000_000,
      chars: 22,
      entryId: 'e1',
      undoable: true
    }
    expect(hudView(state({ lastAction }), 1_000_000).lastAction).toEqual({
      summary: 'Dictation · Mail',
      when: 'just now',
      undoable: true
    })
    expect(hudView(state({ phase: 'listening', lastAction })).lastAction).toBeNull()
  })

  it('passes chips and notices straight through', () => {
    const chips = [{ kind: 'warn' as const, label: 'secure input — paused', id: 'secure' }]
    const view = hudView(state({ phase: 'blocked', chips, notice: 'Secure input is on' }))
    expect(view.chips).toBe(chips)
    expect(view.notice).toBe('Secure input is on')
  })
})

describe('relativeTime', () => {
  it('reads as recency while undo is still plausible', () => {
    const now = 1_700_000_000_000
    expect(relativeTime(now, now)).toBe('just now')
    expect(relativeTime(now - 30_000, now)).toBe('just now')
    expect(relativeTime(now - 120_000, now)).toBe('2m ago')
    expect(relativeTime(now - 59 * 60_000, now)).toBe('59m ago')
  })

  it('falls back to clock time past an hour', () => {
    const now = 1_700_000_000_000
    expect(relativeTime(now - 3 * 3_600_000, now)).toMatch(/\d/)
    expect(relativeTime(now - 3 * 3_600_000, now)).not.toContain('ago')
  })

  it('never reports the future as elapsed time', () => {
    const now = 1_700_000_000_000
    expect(relativeTime(now + 5_000, now)).toBe('just now')
  })
})

/**
 * The working line (docs/DESIGN.md §6.1).
 *
 * THINKING can sit unchanged for twenty seconds — a cold session, a long screen
 * transcript, a classifier answering at its measured p50 of 5.4s. An unchanging
 * word for that long is indistinguishable from a hang, and it was reported as
 * one. This is the same fact the log's trace carries, in the place the user is
 * already looking.
 */
describe('the working line', () => {
  const working = (patch: Partial<HudState>): HudState =>
    state({ phase: 'thinking', stage: 'asking the model', stageAt: 1_000, ...patch })

  it('says what Mull is doing while it is doing it', () => {
    expect(hudView(working({}), 1_000).stage).toEqual({
      text: 'asking the model',
      seconds: null
    })
  })

  /**
   * A counter that starts at 0s on every step turns a fast pipeline into a
   * flickering stopwatch, which reads as less confident rather than more.
   */
  it('holds the seconds back until there is actually a wait', () => {
    expect(hudView(working({}), 2_400).stage?.seconds).toBeNull()
    expect(hudView(working({}), 2_600).stage?.seconds).toBe(1)
    expect(hudView(working({}), 12_000).stage?.seconds).toBe(11)
  })

  it('says nothing when nothing is in flight', () => {
    expect(hudView(state({ phase: 'idle' })).stage).toBeNull()
  })

  /** A card on screen is its own answer to "what is happening". */
  it('gives way to a card rather than describing the past', () => {
    expect(hudView(working({ card: diffCard }), 9_000).stage).toBeNull()
  })

  it('survives a stage with no clock rather than counting from 1970', () => {
    expect(hudView(working({ stageAt: null }), 9_000).stage).toEqual({
      text: 'asking the model',
      seconds: null
    })
  })
})

/**
 * The thinking toggle (M5a).
 *
 * Off by default, and the default is the important half: the Agent SDK runs
 * extended reasoning unless told not to, measured at p50 20086ms against 954ms
 * with it off. This is the escape hatch for the occasional piece of writing
 * where those seconds buy something.
 */
describe('the thinking toggle', () => {
  it('is offered when idle, where the decision is actually made', () => {
    expect(hudView(state({ phase: 'idle', thinking: false })).thinking).toEqual({ on: false })
  })

  /**
   * Mid-utterance it is either too late to matter or describing the turn
   * already in flight — both worse than not being there.
   */
  it('gets out of the way while Mull is working', () => {
    expect(hudView(state({ phase: 'thinking', thinking: false })).thinking).toBeNull()
    expect(hudView(state({ phase: 'listening', thinking: false })).thinking).toBeNull()
  })

  /**
   * Armed is the exception: it stays visible throughout, because the cost is
   * seconds on every turn and leaving it on by accident is the failure mode.
   */
  it('stays visible while it is armed, whatever Mull is doing', () => {
    for (const phase of ['listening', 'thinking', 'preview'] as const) {
      expect(hudView(state({ phase, thinking: true })).thinking).toEqual({ on: true })
    }
  })
})
