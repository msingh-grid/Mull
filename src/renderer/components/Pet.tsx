import { useRef, type CSSProperties, type JSX, type PointerEvent } from 'react'
import type { PetMood } from '../hud/pet'
import sheet from '../assets/marmalade.webp'

/**
 * Which way the cat runs on hover, as a row of the spritesheet.
 *
 * Row 1 faces right and row 2 is its mirror — confirmed by cropping a frame out
 * of each and looking at it, because "run, reversed" does not say which way
 * either of them points. 65px per row, so these are rows 1 and 2.
 */
const RUN_FACING_RIGHT = '-65px'
const RUN_FACING_LEFT = '-130px'

/**
 * Marmalade — Mull at rest (docs/DESIGN.md §6.1a).
 *
 * A button, not a div: it is the one control on the stage, and the only way to
 * open the panel by hand. It is also the drag handle for the whole HUD, which
 * is why the click is decided in `App.tsx` by pointer distance rather than by
 * an `onClick` here — an `onClick` fires at the end of a drag too, and dragging
 * the pet across the screen would fold the panel every time.
 *
 * The sprite is a `<span>` with a background rather than an `<img>` because the
 * frame is chosen by `background-position` from a 8 × 9 sheet of 192×208 cells.
 * Which frames a mood uses is hud.css's business, the same way the orb's pulse
 * is: `hud/pet.ts` decided the mood, and this decides nothing about it.
 *
 * ### The one thing it does decide
 *
 * Which way the cat faces while it runs under the pointer — because that is the
 * one presentational fact no stylesheet can reach. CSS knows the pointer is
 * *somewhere* on the element; it cannot know which half. So the handler below
 * measures it.
 *
 * Written straight onto the node rather than held in state, and that is
 * deliberate: `onPointerMove` fires every few milliseconds while the pointer is
 * over the cat, and a `useState` there would re-render the component on every
 * one of them to change a single CSS value. A custom property is the narrowest
 * thing that can carry it, and hud.css reads it only inside the hover rule, so
 * a stale value between hovers is unobservable.
 */
export function Pet({
  mood,
  label,
  expanded,
  decorative = false
}: {
  mood: PetMood
  label: string
  /** Whether the panel is showing — the pet is its disclosure control. */
  expanded: boolean
  /**
   * Mounted as an illustration rather than as the instrument — onboarding
   * page 1. Rendered as a span, because a button that cannot be pressed is a
   * promise the page has no way to keep.
   */
  decorative?: boolean
}): JSX.Element {
  const sprite = useRef<HTMLSpanElement>(null)

  /**
   * Turn to face the pointer.
   *
   * On enter as well as on move, so the cat is already facing the right way on
   * the first frame rather than turning a moment after it starts running.
   * Nothing resets it on leave: the hover rule is the only reader, so the value
   * left behind cannot be seen until the next hover sets it again.
   */
  const face = (event: PointerEvent<HTMLElement>): void => {
    const box = event.currentTarget.getBoundingClientRect()
    const toTheLeft = event.clientX < box.left + box.width / 2
    sprite.current?.style.setProperty(
      '--pet-run-row',
      toTheLeft ? RUN_FACING_LEFT : RUN_FACING_RIGHT
    )
  }

  // Imported rather than referenced from `public/`, so the bundler resolves it.
  // The windows load from `file://` in a packaged build, where a root-relative
  // URL means the root of the disk.
  const inside = (
    <>
      <span className="pet-shadow" aria-hidden="true" />
      <span
        ref={sprite}
        className="pet-sprite"
        style={{ '--pet-sheet': `url(${sheet})` } as CSSProperties}
        aria-hidden="true"
      />
    </>
  )
  if (decorative) {
    return (
      <span
        className={`pet is-${mood}`}
        role="img"
        aria-label={label}
        onPointerEnter={face}
        onPointerMove={face}
      >
        {inside}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={`pet is-${mood}`}
      aria-label={label}
      aria-expanded={expanded}
      onPointerEnter={face}
      onPointerMove={face}
    >
      {inside}
    </button>
  )
}
