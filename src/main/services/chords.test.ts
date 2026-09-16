import { describe, expect, it, vi } from 'vitest'
import { ChordScope, type GlobalShortcutLike } from './chords'

function fakeShortcuts(refuse: string[] = []): GlobalShortcutLike & {
  registered: Set<string>
  handlers: Map<string, () => void>
} {
  const registered = new Set<string>()
  const handlers = new Map<string, () => void>()
  return {
    registered,
    handlers,
    register(accelerator, callback) {
      if (refuse.includes(accelerator)) return false
      registered.add(accelerator)
      handlers.set(accelerator, callback)
      return true
    },
    unregister(accelerator) {
      registered.delete(accelerator)
      handlers.delete(accelerator)
    }
  }
}

describe('ChordScope', () => {
  it('claims nothing until a card is open', () => {
    const gs = fakeShortcuts()
    const scope = new ChordScope({ globalShortcut: gs })
    expect(scope.active).toBe(false)
    expect(gs.registered.size).toBe(0)
  })

  it('claims ⏎ and esc while held, and gives them back on release', () => {
    const gs = fakeShortcuts()
    const scope = new ChordScope({ globalShortcut: gs })

    const release = scope.hold(() => {})
    expect(gs.registered).toEqual(new Set(['Return', 'Escape']))

    release()
    expect(gs.registered.size).toBe(0)
    expect(scope.active).toBe(false)
  })

  it('routes each chord to its action', () => {
    const gs = fakeShortcuts()
    const onAction = vi.fn()
    new ChordScope({ globalShortcut: gs }).hold(onAction)

    gs.handlers.get('Return')?.()
    gs.handlers.get('Escape')?.()
    expect(onAction.mock.calls).toEqual([['apply'], ['cancel']])
  })

  it('refuses to hold just one of the pair — a card you can apply but not cancel is a trap', () => {
    const gs = fakeShortcuts(['Escape'])
    const scope = new ChordScope({ globalShortcut: gs })

    scope.hold(() => {})
    expect(gs.registered.size).toBe(0)
    expect(scope.active).toBe(false)
  })

  it('swaps the handler when a second card replaces the first, without double-registering', () => {
    const gs = fakeShortcuts()
    const scope = new ChordScope({ globalShortcut: gs })
    const first = vi.fn()
    const second = vi.fn()

    scope.hold(first)
    const release = scope.hold(second)
    expect(gs.registered.size).toBe(2)

    gs.handlers.get('Return')?.()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('apply')

    // One release is enough — the second hold did not add a registration.
    release()
    expect(gs.registered.size).toBe(0)
  })

  it('is safe to release twice, and stops calling back after release', () => {
    const gs = fakeShortcuts()
    const scope = new ChordScope({ globalShortcut: gs })
    const onAction = vi.fn()
    const release = scope.hold(onAction)
    const stale = gs.handlers.get('Return')

    release()
    release()
    stale?.() // a shortcut that fired in the same tick as the release
    expect(onAction).not.toHaveBeenCalled()
  })

  it('survives a globalShortcut that throws', () => {
    const scope = new ChordScope({
      globalShortcut: {
        register() {
          throw new Error('nope')
        },
        unregister() {}
      }
    })
    expect(() => scope.hold(() => {})).not.toThrow()
    expect(scope.active).toBe(false)
  })
})

describe('ChordScope — the send chord', () => {
  it('does not claim ⌘⏎ for an ordinary card', () => {
    const gs = fakeShortcuts()
    new ChordScope({ globalShortcut: gs }).hold(() => {})
    expect(gs.registered.has('CommandOrControl+Return')).toBe(false)
  })

  it('claims it for a card that offers a second commit, and routes it', () => {
    const gs = fakeShortcuts()
    const onAction = vi.fn()
    const release = new ChordScope({ globalShortcut: gs }).hold(onAction, { send: true })
    expect(gs.registered.has('CommandOrControl+Return')).toBe(true)

    gs.handlers.get('CommandOrControl+Return')?.()
    expect(onAction).toHaveBeenCalledWith('apply-send')

    release()
    expect(gs.registered.size).toBe(0)
  })

  /**
   * Best-effort, unlike ⏎ and esc. ⌘⏎ is a common shortcut inside other apps,
   * and losing it must not take the card's Apply and Cancel down with it — the
   * button is still clickable.
   */
  it('keeps the card usable when ⌘⏎ is claimed elsewhere', () => {
    const gs = fakeShortcuts(['CommandOrControl+Return'])
    const scope = new ChordScope({ globalShortcut: gs })

    scope.hold(() => {}, { send: true })
    expect(scope.active).toBe(true)
    expect(gs.registered).toEqual(new Set(['Return', 'Escape']))
  })
})
