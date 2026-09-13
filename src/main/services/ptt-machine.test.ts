import { describe, expect, it } from 'vitest'
import { PttStateMachine, type PttKeyEvent } from './ptt-machine'

const KEYS = { space: 57, alt: [56, 3640] } as const

function ev(
  type: 'keydown' | 'keyup',
  keycode: number,
  mods: Partial<Pick<PttKeyEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {}
): PttKeyEvent {
  return {
    type,
    keycode,
    altKey: mods.altKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    shiftKey: mods.shiftKey ?? false
  }
}

describe('PttStateMachine (edge mode)', () => {
  it('starts on ⌥ then Space, stops on Space up', () => {
    const m = new PttStateMachine(KEYS)
    expect(m.handle(ev('keydown', 56))).toBeNull()
    expect(m.handle(ev('keydown', 57, { altKey: true }))).toBe('start')
    expect(m.handle(ev('keyup', 57))).toBe('stop')
  })

  it('ignores key repeat while already recording', () => {
    const m = new PttStateMachine(KEYS)
    m.handle(ev('keydown', 56))
    expect(m.handle(ev('keydown', 57, { altKey: true }))).toBe('start')
    expect(m.handle(ev('keydown', 57, { altKey: true }))).toBeNull()
    expect(m.handle(ev('keydown', 57, { altKey: true }))).toBeNull()
  })

  it('stops when ⌥ is released first, and the trailing Space up is a no-op', () => {
    const m = new PttStateMachine(KEYS)
    m.handle(ev('keydown', 56))
    m.handle(ev('keydown', 57, { altKey: true }))
    expect(m.handle(ev('keyup', 56))).toBe('stop')
    expect(m.handle(ev('keyup', 57))).toBeNull()
  })

  it('ignores Space without ⌥', () => {
    const m = new PttStateMachine(KEYS)
    expect(m.handle(ev('keydown', 57))).toBeNull()
    expect(m.handle(ev('keyup', 57))).toBeNull()
  })

  it('ignores chords that belong to someone else', () => {
    const m = new PttStateMachine(KEYS)
    m.handle(ev('keydown', 56))
    expect(m.handle(ev('keydown', 57, { altKey: true, metaKey: true }))).toBeNull()
    expect(m.handle(ev('keydown', 57, { altKey: true, ctrlKey: true }))).toBeNull()
  })

  it('accepts the right-hand ⌥ key', () => {
    const m = new PttStateMachine(KEYS)
    m.handle(ev('keydown', 3640))
    expect(m.handle(ev('keydown', 57, { altKey: true }))).toBe('start')
  })

  it('reset() releases a stranded hold', () => {
    const m = new PttStateMachine(KEYS)
    m.handle(ev('keydown', 56))
    m.handle(ev('keydown', 57, { altKey: true }))
    expect(m.isActive).toBe(true)
    m.reset()
    expect(m.isActive).toBe(false)
    // and the next chord still works
    m.handle(ev('keydown', 56))
    expect(m.handle(ev('keydown', 57, { altKey: true }))).toBe('start')
  })
})

describe('PttStateMachine (up-only mode)', () => {
  it('never starts on its own — globalShortcut owns key-down', () => {
    const m = new PttStateMachine(KEYS, 'up-only')
    expect(m.handle(ev('keydown', 57, { altKey: true }))).toBeNull()
  })

  it('stops after markStarted()', () => {
    const m = new PttStateMachine(KEYS, 'up-only')
    m.markStarted()
    expect(m.isActive).toBe(true)
    expect(m.handle(ev('keyup', 57))).toBe('stop')
    expect(m.handle(ev('keyup', 56))).toBeNull()
  })
})
