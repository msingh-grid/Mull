import { describe, expect, it, vi } from 'vitest'
import { IDLE_HUD_STATE, type HudState } from '@shared/ipc'
import type { DiffCard } from '@shared/hud'
import { ChordScope, type GlobalShortcutLike } from './chords'
import { HudController, type HudPort } from './hud'

const card: DiffCard = { kind: 'diff', app: 'Mail', segments: [], changes: 1 }
const other: DiffCard = { kind: 'diff', app: 'Mail', segments: [], changes: 2 }

function harness(): {
  controller: HudController
  sent: HudState[]
  interactive: boolean[]
  shortcuts: Set<string>
  fire: (accelerator: string) => void
} {
  const sent: HudState[] = []
  const interactive: boolean[] = []
  const shortcuts = new Set<string>()
  const handlers = new Map<string, () => void>()

  const globalShortcut: GlobalShortcutLike = {
    register(accelerator, callback) {
      shortcuts.add(accelerator)
      handlers.set(accelerator, callback)
      return true
    },
    unregister(accelerator) {
      shortcuts.delete(accelerator)
      handlers.delete(accelerator)
    }
  }
  const port: HudPort = {
    send: (state) => sent.push(state),
    setInteractive: (value) => interactive.push(value)
  }

  return {
    controller: new HudController({ port, chords: new ChordScope({ globalShortcut }) }),
    sent,
    interactive,
    shortcuts,
    fire: (accelerator) => handlers.get(accelerator)?.()
  }
}

describe('HudController', () => {
  it('passes pipeline state through untouched when no card is open', () => {
    const h = harness()
    const state: HudState = { ...IDLE_HUD_STATE, phase: 'listening', transcript: 'send the' }
    h.controller.setPipelineState(state)
    expect(h.sent.at(-1)).toEqual(state)
  })

  it('shows the card and takes over the phase while one is open', () => {
    const h = harness()
    h.controller.setPipelineState({ ...IDLE_HUD_STATE, phase: 'thinking' })
    h.controller.openCard(card, () => {})

    expect(h.sent.at(-1)?.phase).toBe('preview')
    expect(h.sent.at(-1)?.card).toBe(card)
  })

  it('does not let a finishing utterance clear a card the user is still reading', () => {
    const h = harness()
    h.controller.openCard(card, () => {})
    // The pipeline returns to idle underneath the open proposal.
    h.controller.setPipelineState({ ...IDLE_HUD_STATE, phase: 'idle' })

    expect(h.controller.hasCard).toBe(true)
    expect(h.sent.at(-1)?.card).toBe(card)
    expect(h.sent.at(-1)?.phase).toBe('preview')
  })

  it('keeps the pipeline’s transcript and app visible under the card', () => {
    const h = harness()
    h.controller.setPipelineState({
      ...IDLE_HUD_STATE,
      phase: 'thinking',
      transcript: 'make this crisp',
      app: { bundleId: 'com.apple.mail', name: 'Mail' }
    })
    h.controller.openCard(card, () => {})

    expect(h.sent.at(-1)?.transcript).toBe('make this crisp')
    expect(h.sent.at(-1)?.app?.name).toBe('Mail')
  })

  it('claims ⏎ and esc only for the life of the card', () => {
    const h = harness()
    expect(h.shortcuts.size).toBe(0)

    h.controller.openCard(card, () => {})
    expect(h.shortcuts).toEqual(new Set(['Return', 'Escape']))

    h.controller.closeCard()
    expect(h.shortcuts.size).toBe(0)
  })

  it('routes the global chords to the card’s handler', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(card, onAction)

    h.fire('Return')
    expect(onAction).toHaveBeenCalledWith('apply')
    expect(h.controller.hasCard).toBe(false)
  })

  it('releases the chords even when the handler throws', () => {
    const h = harness()
    h.controller.openCard(card, () => {
      throw new Error('apply blew up')
    })

    expect(() => h.controller.act('apply')).toThrow('apply blew up')
    expect(h.shortcuts.size).toBe(0)
    expect(h.controller.hasCard).toBe(false)
  })

  it('answers a card exactly once', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(card, onAction)

    h.fire('Return')
    h.fire('Escape') // a stale chord, or a click racing the keypress
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('makes the panel interactive only while a card is open', () => {
    const h = harness()
    h.controller.setPipelineState({ ...IDLE_HUD_STATE, phase: 'listening' })
    expect(h.interactive).toEqual([])

    h.controller.openCard(card, () => {})
    expect(h.interactive).toEqual([true])

    h.controller.updateCard(other) // streaming must not thrash the window flag
    expect(h.interactive).toEqual([true])

    h.controller.closeCard()
    expect(h.interactive).toEqual([true, false])
  })

  it('ignores updates and closes when nothing is open', () => {
    const h = harness()
    h.controller.updateCard(card)
    h.controller.closeCard()
    h.controller.act('apply')
    expect(h.controller.hasCard).toBe(false)
    expect(h.sent).toHaveLength(0)
  })
})

describe('HudController — the second commit', () => {
  const sendable: DiffCard = {
    kind: 'diff',
    app: 'Slack',
    segments: [],
    changes: 1,
    commit: { label: 'Apply & send', hint: '⌘⏎', warning: 'sending can’t be undone' }
  }

  it('claims ⌘⏎ only for a card that carries one', () => {
    const plain = harness()
    plain.controller.openCard(card, () => {})
    expect(plain.shortcuts.has('CommandOrControl+Return')).toBe(false)

    const h = harness()
    h.controller.openCard(sendable, () => {})
    expect(h.shortcuts.has('CommandOrControl+Return')).toBe(true)
  })

  it('delivers apply-send and closes, giving ⌘⏎ back', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(sendable, onAction)

    h.fire('CommandOrControl+Return')
    expect(onAction).toHaveBeenCalledWith('apply-send')
    expect(h.controller.hasCard).toBe(false)
    expect(h.shortcuts.size).toBe(0)
  })

  /**
   * The renderer is data-driven and cannot show a button the card does not
   * carry — but `act()` is also reachable over IPC, and a send that only the
   * card may authorise must be authorised by the card, not by the caller.
   */
  it('downgrades apply-send to apply on a card with no commit', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(card, onAction)

    h.controller.act('apply-send')
    expect(onAction).toHaveBeenCalledWith('apply')
    expect(onAction).not.toHaveBeenCalledWith('apply-send')
  })
})

describe('HudController — the bare-send card', () => {
  const sendCard = {
    kind: 'send' as const,
    app: 'Slack',
    text: 'I will get the code done in 2 days.',
    commit: { label: 'Send', hint: '⏎', warning: 'sending can’t be undone' }
  }

  it('claims ⌘⏎ for it', () => {
    const h = harness()
    h.controller.openCard(sendCard, () => {})
    expect(h.shortcuts.has('CommandOrControl+Return')).toBe(true)
  })

  /**
   * Mull holds Return globally while a card is open. On this card ⏎ means
   * nothing — but releasing it would let the press reach Slack and send the
   * very message the card is still asking about, so it stays claimed and is
   * swallowed.
   */
  it('swallows ⏎ rather than letting it through or closing the card', () => {
    const h = harness()
    const onAction = vi.fn()
    h.controller.openCard(sendCard, onAction)

    h.fire('Return')
    expect(onAction).not.toHaveBeenCalled()
    expect(h.controller.hasCard).toBe(true)
    expect(h.shortcuts.has('Return')).toBe(true)

    // esc and ⌘⏎ still work.
    h.fire('CommandOrControl+Return')
    expect(onAction).toHaveBeenCalledWith('apply-send')
  })
})
