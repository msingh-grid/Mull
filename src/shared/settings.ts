import { z } from 'zod'

/**
 * User settings — the shape, shared by main, preload and every renderer.
 *
 * The schema lives here rather than beside the store because the settings
 * window sends patches back: both ends validating against the same object is
 * what stops a renderer from inventing a key the store will silently drop.
 * Persistence is src/main/store/settings.ts; this file never touches disk.
 */

export const SettingsSchema = z.object({
  /** Which chord starts dictation. `fn` needs the M3 sidecar event tap. */
  hotkey: z.enum(['opt-space', 'fn']).default('opt-space'),
  /** Window appearance. The HUD follows this too unless `hudTheme` overrides. */
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  /**
   * "Page in the dark" (docs/DESIGN.md §6.8): keep the HUD on paper-light even
   * when everything else goes lamplit.
   */
  hudTheme: z.enum(['follow', 'paper']).default('follow'),
  /** Epoch ms the user finished onboarding; null means they never have. */
  onboardingCompletedAt: z.number().int().nullable().default(null),
  launchAtLogin: z.boolean().default(false)
})

export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})
