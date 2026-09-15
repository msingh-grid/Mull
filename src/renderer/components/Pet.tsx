import type { CSSProperties, JSX } from 'react'
import type { PetMood } from '../hud/pet'
import sheet from '../assets/marmalade.webp'

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
 * is: this decides nothing, and `hud/pet.ts` decided the mood.
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
  // Imported rather than referenced from `public/`, so the bundler resolves it.
  // The windows load from `file://` in a packaged build, where a root-relative
  // URL means the root of the disk.
  const inside = (
    <>
      <span className="pet-shadow" aria-hidden="true" />
      <span
        className="pet-sprite"
        style={{ '--pet-sheet': `url(${sheet})` } as CSSProperties}
        aria-hidden="true"
      />
    </>
  )
  if (decorative) {
    return (
      <span className={`pet is-${mood}`} role="img" aria-label={label}>
        {inside}
      </span>
    )
  }
  return (
    <button type="button" className={`pet is-${mood}`} aria-label={label} aria-expanded={expanded}>
      {inside}
    </button>
  )
}
