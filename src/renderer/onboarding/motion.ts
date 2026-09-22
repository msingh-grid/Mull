/**
 * Onboarding motion vocabulary.
 *
 * This file deliberately departs from docs/DESIGN.md §5, which restricts the
 * app to opacity/transform, forbids bounce, and forbids exit animations
 * entirely ("the instrument stops reporting; it doesn't perform leaving").
 * That rule still governs the HUD, the journal and settings. Onboarding is the
 * one surface where the user is being introduced rather than worked with, so it
 * is allowed to perform — springs overshoot here, and pages animate out.
 *
 * Everything below still collapses under `prefers-reduced-motion`; that part is
 * accessibility, not house style, and is not negotiable. The reduced variants
 * keep the same start and end states with the travel removed.
 */

import type { Transition, Variants } from 'framer-motion'

/** The house curve: fast out of the gate, long settle. */
export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1]

/** Expressive spring — visible overshoot. Used on things the user acts on. */
export const SPRING: Transition = { type: 'spring', stiffness: 420, damping: 26, mass: 0.7 }

/** Softer spring for larger bodies, where overshoot would read as wobble. */
export const SPRING_SOFT: Transition = { type: 'spring', stiffness: 220, damping: 30, mass: 0.9 }

/** Page-level travel, in px. Pages enter from the side they are headed toward. */
const PAGE_SHIFT = 42

/**
 * Direction-aware page transition. `custom` carries +1 for forward and -1 for
 * back, so Continue and Back feel like opposite gestures rather than the same
 * crossfade twice.
 */
export const pageVariants: Variants = {
  enter: (direction: number) => ({
    opacity: 0,
    x: direction * PAGE_SHIFT,
    scale: 0.985,
    filter: 'blur(3px)'
  }),
  settled: {
    opacity: 1,
    x: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: { ...SPRING_SOFT, filter: { duration: 0.28 }, opacity: { duration: 0.24 } }
  },
  leave: (direction: number) => ({
    opacity: 0,
    x: direction * -PAGE_SHIFT,
    scale: 0.985,
    filter: 'blur(3px)',
    transition: { duration: 0.2, ease: EASE_OUT }
  })
}

/** Reduced-motion page transition: the state change still reads, nothing moves. */
export const pageVariantsReduced: Variants = {
  enter: { opacity: 0 },
  settled: { opacity: 1, transition: { duration: 0.12 } },
  leave: { opacity: 0, transition: { duration: 0.08 } }
}

/**
 * Container for staggered reveals. Children inherit by name, so a page only has
 * to mark its own blocks as `riseItem` and the sequence falls out.
 */
export const staggerParent: Variants = {
  enter: {},
  settled: { transition: { staggerChildren: 0.055, delayChildren: 0.08 } }
}

export const riseItem: Variants = {
  enter: { opacity: 0, y: 14 },
  settled: { opacity: 1, y: 0, transition: SPRING_SOFT }
}

export const riseItemReduced: Variants = {
  enter: { opacity: 0 },
  settled: { opacity: 1, transition: { duration: 0.12 } }
}

/** Empty variants — the shape a reduced-motion parent still needs to orchestrate. */
export const staggerParentReduced: Variants = {
  enter: {},
  settled: { transition: { staggerChildren: 0.02 } }
}

/** Button feel. Pressed state is a real push, not a colour change. */
export const pressable = {
  whileHover: { y: -1, scale: 1.02 },
  whileTap: { y: 0, scale: 0.97 },
  transition: SPRING
} as const
