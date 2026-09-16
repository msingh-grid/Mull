import { describe, expect, it } from 'vitest'
import { IDLE_HUD_STATE, type HudLastAction, type HudPhase, type HudState } from '@shared/ipc'
import type { DiffCard } from '@shared/hud'
import { PANEL_LINGER_MS, SLEEP_AFTER_MS, isTap, petView, petWakes, type PetUi } from './pet'

const NOW = 1_700_000_000_000

const state = (patch: Partial<HudState> = {}): HudState => ({ ...IDLE_HUD_STATE, ...patch })

/** Awake and with nothing asked of the panel. */
const ui = (patch: Partial<PetUi> = {}): PetUi => ({ wanted: null, quietSince: NOW, ...patch })

const lastAction = (patch: Partial<HudLastAction> = {}): HudLastAction => ({
  summary: 'Dictation · Mail',
  at: NOW,
  chars: 19,
  entryId: 'e1',
  undoable: true,
  ...patch
})

const diffCard: DiffCard = { kind: 'diff', app: 'Mail', segments: [], changes: 1 }

const BUSY_PHASES: HudPhase[] = ['listening', 'thinking', 'inserting', 'applied', 'blocked', 'error', 'preview']

describe('when the panel is worth its space', () => {
  it('shows only the pet at rest', () => {
    expect(petView(state(), ui(), NOW).panelOpen).toBe(false)
  })

  /**
   * The whole risk of this change in one test. A diff card that needed a click
   * to be discovered is a card nobody answers, and Mull would be sitting on an
   * un-applied edit waiting for a ⏎ the user cannot see it is asking for.
   */
  it('raises the panel for every phase that is not plain idle', () => {
    for (const phase of BUSY_PHASES) {
      expect(petView(state({ phase }), ui(), NOW).panelOpen).toBe(true)
    }
  })

  it('raises the panel for a card and for a notice, whatever the phase says', () => {
    expect(petView(state({ card: diffCard }), ui(), NOW).panelOpen).toBe(true)
    expect(petView(state({ notice: 'secure input — paused' }), ui(), NOW).panelOpen).toBe(true)
  })

  /**
   * `applied` lasts 1 400ms and then the phase is idle, so without the linger
   * the last-action row and its ⌥Z hint would appear and vanish inside a second
   * and a half — the panel at its least useful in the one moment it has
   * something to report.
   */
  it('holds the panel open for a while after an action, then folds', () => {
    const just = state({ lastAction: lastAction({ at: NOW }) })
    expect(petView(just, ui(), NOW + 1_000).panelOpen).toBe(true)
    expect(petView(just, ui(), NOW + PANEL_LINGER_MS - 1).panelOpen).toBe(true)
    expect(petView(just, ui(), NOW + PANEL_LINGER_MS).panelOpen).toBe(false)
  })

  it('does not reopen for an action from an hour ago', () => {
    const old = state({ lastAction: lastAction({ at: NOW - 3_600_000 }) })
    expect(petView(old, ui(), NOW).panelOpen).toBe(false)
  })
})

describe('what the user asked for', () => {
  it('opens a resting panel and keeps it open', () => {
    expect(petView(state(), ui({ wanted: true }), NOW).panelOpen).toBe(true)
    // Still open long after any linger would have expired.
    expect(petView(state(), ui({ wanted: true }), NOW + 600_000).panelOpen).toBe(true)
  })

  it('closes a lingering panel early', () => {
    const just = state({ lastAction: lastAction({ at: NOW }) })
    expect(petView(just, ui({ wanted: false }), NOW).panelOpen).toBe(false)
  })

  /**
   * A click cannot dismiss a card. The label must not offer to do it either —
   * a button that says "hide" and does not hide is worse than one that says
   * nothing.
   */
  it('cannot fold a panel something else is holding open', () => {
    const card = petView(state({ card: diffCard }), ui({ wanted: false }), NOW)
    expect(card.panelOpen).toBe(true)
    expect(card.pinnable).toBe(false)
    expect(card.label).not.toMatch(/click/i)

    expect(petView(state(), ui(), NOW).pinnable).toBe(true)
  })

  it('says which way the click goes', () => {
    expect(petView(state(), ui(), NOW).label).toMatch(/click to open/i)
    expect(petView(state(), ui({ wanted: true }), NOW).label).toMatch(/click to hide/i)
  })
})

describe('mood', () => {
  it('reads the phase', () => {
    const mood = (phase: HudPhase): string => petView(state({ phase }), ui(), NOW).mood
    expect(mood('idle')).toBe('rest')
    expect(mood('listening')).toBe('listening')
    expect(mood('thinking')).toBe('working')
    expect(mood('inserting')).toBe('working')
    expect(mood('preview')).toBe('working')
    expect(mood('applied')).toBe('done')
    expect(mood('blocked')).toBe('trouble')
    expect(mood('error')).toBe('trouble')
  })

  // The card is the fact; the phase is a claim about it — the same rule
  // `hudView`'s label follows, and for the same reason.
  it('lets a card outrank the phase', () => {
    expect(petView(state({ phase: 'thinking', card: diffCard }), ui(), NOW).mood).toBe('waiting')
  })

  it('treats a notice as trouble even in idle', () => {
    expect(petView(state({ notice: 'no microphone' }), ui(), NOW).mood).toBe('trouble')
  })

  it('dozes off once it has been left alone', () => {
    expect(petView(state(), ui(), NOW + SLEEP_AFTER_MS - 1).mood).toBe('rest')
    expect(petView(state(), ui(), NOW + SLEEP_AFTER_MS).mood).toBe('asleep')
  })

  it('never dozes through something happening', () => {
    const late = NOW + SLEEP_AFTER_MS * 2
    expect(petView(state({ phase: 'listening' }), ui(), late).mood).toBe('listening')
  })

  it('gives every mood a sentence', () => {
    for (const phase of [...BUSY_PHASES, 'idle' as const]) {
      expect(petView(state({ phase }), ui(), NOW).label).toMatch(/^Mull /)
    }
  })
})

describe('petWakes', () => {
  it('asks to be woken when the linger expires', () => {
    const just = state({ lastAction: lastAction({ at: NOW }) })
    expect(petWakes(just, ui(), NOW + 1_000)).toBe(PANEL_LINGER_MS - 1_000)
  })

  it('asks to be woken when the pet is due to fall asleep', () => {
    expect(petWakes(state(), ui(), NOW + 1_000)).toBe(SLEEP_AFTER_MS - 1_000)
  })

  it('takes whichever comes first', () => {
    const just = state({ lastAction: lastAction({ at: NOW }) })
    expect(petWakes(just, ui(), NOW)).toBe(PANEL_LINGER_MS)
  })

  /**
   * An action leaves two deadlines — the panel folding at 4s and the cat dozing
   * at 90s — and only the nearer is ever scheduled. So waking for the first
   * must still report the second, or the pet stays awake until main happens to
   * push something. (`App.tsx` depends on `tick` for exactly this.)
   */
  it('reports the doze once the linger has been and gone', () => {
    const just = state({ lastAction: lastAction({ at: NOW }) })
    expect(petWakes(just, ui(), NOW + PANEL_LINGER_MS)).toBe(SLEEP_AFTER_MS - PANEL_LINGER_MS)
  })

  /**
   * Nothing to wait for is the common case, and it is what keeps an idle HUD
   * from re-rendering forever — `App.tsx` schedules exactly what this returns.
   */
  it('asks for nothing once everything has already happened', () => {
    const slept = ui({ quietSince: NOW - SLEEP_AFTER_MS })
    expect(petWakes(state(), slept, NOW)).toBeNull()
  })

  it('asks for nothing while main is driving the panel anyway', () => {
    expect(petWakes(state({ phase: 'thinking' }), ui(), NOW)).toBeNull()
  })

  it('does not wait for a linger the user has already overruled', () => {
    const just = state({ lastAction: lastAction({ at: NOW }) })
    const slept = { wanted: false, quietSince: NOW - SLEEP_AFTER_MS }
    expect(petWakes(just, slept, NOW)).toBeNull()
  })
})

describe('isTap', () => {
  // 4px, not 0: a click on a trackpad drifts a pixel or two, and a pet that
  // only answers a perfectly still pointer reads as broken.
  it('forgives a small drift and nothing more', () => {
    expect(isTap({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(true)
    expect(isTap({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(true)
    expect(isTap({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(true)
    expect(isTap({ x: 10, y: 10 }, { x: 15, y: 10 })).toBe(false)
    expect(isTap({ x: 10, y: 10 }, { x: 50, y: 40 })).toBe(false)
  })
})
