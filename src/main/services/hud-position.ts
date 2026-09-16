/**
 * Where the HUD sits, and where it is allowed to sit.
 *
 * The panel used to be nailed to the bottom centre of the screen, which is
 * fine until it is sitting on top of the thing you are trying to click —
 * Slack's composer toolbar, in the report that prompted this. So it can be
 * dragged, and it remembers.
 *
 * The window is a mostly-transparent 520×420 stage with the panel anchored to
 * its **bottom** edge, growing upward as chips and a card arrive. That is what
 * makes the clamp below asymmetric: what has to stay on screen is the window's
 * bottom edge, not its top. Clamping the whole window inside the work area
 * would make the upper half of the screen unreachable, which is exactly where
 * someone moving the HUD out of the way wants to put it.
 *
 * No `electron` import, so the arithmetic is testable.
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Keep at least this much of the panel below the top of the work area. */
const MIN_VISIBLE = 96

/**
 * The window position for a pointer that has moved from `grab` to `pointer`,
 * having picked the window up at `origin`. Screen coordinates throughout.
 */
export function nextPosition(
  origin: Point,
  grab: Point,
  pointer: Point,
  size: { width: number; height: number },
  workArea: Rect
): Point {
  return clampPosition(
    { x: origin.x + (pointer.x - grab.x), y: origin.y + (pointer.y - grab.y) },
    size,
    workArea
  )
}

/**
 * Pull a position back onto the screen.
 *
 * Also used at launch, because a display can go away between runs: a HUD saved
 * on a monitor that is no longer attached would otherwise be invisible, and an
 * invisible HUD is indistinguishable from a broken one.
 */
export function clampPosition(
  position: Point,
  size: { width: number; height: number },
  workArea: Rect
): Point {
  const minX = workArea.x
  const maxX = workArea.x + workArea.width - size.width
  // The panel's bottom is the window's bottom, so that is the edge to keep in
  // view. Top of the range puts the panel near the top of the screen.
  const minY = workArea.y + MIN_VISIBLE - size.height
  const maxY = workArea.y + workArea.height - size.height

  return {
    x: Math.round(clamp(position.x, minX, Math.max(minX, maxX))),
    y: Math.round(clamp(position.y, minY, Math.max(minY, maxY)))
  }
}

/** The default: bottom centre of the work area, which is where §6.1 puts it. */
export function defaultPosition(
  size: { width: number; height: number },
  workArea: Rect
): Point {
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + workArea.height - size.height)
  }
}

/** Is a remembered position still somewhere the user could see it? */
export function isOnScreen(
  position: Point,
  size: { width: number; height: number },
  workArea: Rect
): boolean {
  const clamped = clampPosition(position, size, workArea)
  return clamped.x === position.x && clamped.y === position.y
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
