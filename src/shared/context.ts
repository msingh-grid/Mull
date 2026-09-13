import type { ContextBlock } from './sidecar-api'

/**
 * What Mull can see, as data.
 *
 * Shared because three layers need the same shape: the pipeline builds it, the
 * engine seam carries it, and the HUD names it in a chip while the user is
 * still speaking. That chip is not decoration — it is the only reason capturing
 * the window by default is acceptable rather than creepy. If Mull is reading
 * something, the user finds out before they finish the sentence, not after.
 */

/** How much of the screen Mull may look at. Mirrored in Settings. */
export type ContextMode = 'off' | 'text' | 'text+screen'

export interface ContextImage {
  mediaType: 'image/jpeg'
  /** Already base64; the temp file it came from is deleted by then. */
  dataBase64: string
  width: number
  height: number
  bytes: number
}

export interface ScreenContext {
  app: { bundleId: string; name: string } | null
  windowTitle: string | null
  /** The window's Accessibility tree in reading order. */
  blocks: ContextBlock[]
  /** A budget stopped the read before the window ran out. */
  truncated: boolean
  image: ContextImage | null
  /**
   * Why there is no picture. Always set when `image` is null, because "no
   * image" and "no image *because the user turned it off*" are different facts
   * — one of them belongs in a chip the user can act on.
   */
  imageReason: string | null
  /** Characters of text, for the ledger and the chip. Never the text itself. */
  chars: number
  harvestMs: number
}

/** Is there anything here worth showing a model? */
export function hasContext(context: ScreenContext | null): context is ScreenContext {
  if (!context) return false
  return context.chars > 0 || context.image !== null
}
