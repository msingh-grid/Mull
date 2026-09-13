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
