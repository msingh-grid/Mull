import { describe, expect, it } from 'vitest'
import { clampPosition, defaultPosition, isOnScreen, nextPosition } from './hud-position'

const SIZE = { width: 520, height: 420 }
/** A 1512×982 work area at the origin — a MacBook with the menu bar removed. */
const SCREEN = { x: 0, y: 0, width: 1512, height: 982 }

describe('defaultPosition', () => {
  it('puts the panel at the bottom centre, per docs/DESIGN.md §6.1', () => {
    expect(defaultPosition(SIZE, SCREEN)).toEqual({ x: 496, y: 562 })
  })

  it('follows the work area onto a second display', () => {
    const external = { x: -1920, y: -200, width: 1920, height: 1080 }
    expect(defaultPosition(SIZE, external)).toEqual({ x: -1220, y: 460 })
  })
})

describe('nextPosition', () => {
  const origin = { x: 496, y: 562 }

  it('moves the window by exactly what the pointer moved', () => {
    const moved = nextPosition(origin, { x: 700, y: 700 }, { x: 640, y: 620 }, SIZE, SCREEN)
    expect(moved).toEqual({ x: 436, y: 482 })
  })

  it('stays put when the pointer does', () => {
    expect(nextPosition(origin, { x: 700, y: 700 }, { x: 700, y: 700 }, SIZE, SCREEN)).toEqual(
      origin
    )
  })

  it('cannot be dragged off the left or right', () => {
    expect(nextPosition(origin, { x: 700, y: 700 }, { x: -5_000, y: 700 }, SIZE, SCREEN).x).toBe(0)
    expect(nextPosition(origin, { x: 700, y: 700 }, { x: 5_000, y: 700 }, SIZE, SCREEN).x).toBe(992)
  })

  it('cannot be dragged below the bottom of the screen', () => {
    const down = nextPosition(origin, { x: 700, y: 700 }, { x: 700, y: 5_000 }, SIZE, SCREEN)
    expect(down.y + SIZE.height).toBe(SCREEN.height)
  })

  /**
   * The reason the clamp is asymmetric. The panel hangs off the window's bottom
   * edge, so "on screen" means that edge is visible — and dragging the HUD up
   * out of the way is the whole point of being able to drag it.
   */
  it('can be dragged to the top, with the panel still showing', () => {
    const up = nextPosition(origin, { x: 700, y: 700 }, { x: 700, y: -5_000 }, SIZE, SCREEN)
    expect(up.y).toBeLessThan(0)
    expect(up.y + SIZE.height).toBe(96)
  })
})

describe('clampPosition', () => {
  it('rescues a position saved on a display that is gone', () => {
    const onTheOldMonitor = { x: -1_800, y: -400 }
    const rescued = clampPosition(onTheOldMonitor, SIZE, SCREEN)
    expect(isOnScreen(rescued, SIZE, SCREEN)).toBe(true)
  })

  it('leaves a position that is already fine exactly alone', () => {
    const fine = { x: 496, y: 562 }
    expect(clampPosition(fine, SIZE, SCREEN)).toEqual(fine)
    expect(isOnScreen(fine, SIZE, SCREEN)).toBe(true)
  })

  it('survives a work area smaller than the window', () => {
    // Not a real Mac, but the arithmetic must not produce min > max.
    const tiny = { x: 0, y: 0, width: 200, height: 200 }
    const clamped = clampPosition({ x: 9_999, y: 9_999 }, SIZE, tiny)
    expect(Number.isFinite(clamped.x)).toBe(true)
    expect(Number.isFinite(clamped.y)).toBe(true)
  })
})
