import type { Settings } from '@shared/settings'

/**
 * Apply the user's theme choice to this document.
 *
 * tokens.css is built for three states (bare `:root` light, the
 * `prefers-color-scheme` media query, and an explicit `[data-theme]` stamp), so
 * "follow the system" is the *absence* of a stamp — not a stamp that happens
 * to match. Removing the attribute is therefore a real operation here, and the
 * reason this is a function rather than an inline `setAttribute`.
 */
export function applyTheme(settings: Pick<Settings, 'theme'>): void {
  const root = document.documentElement
  if (settings.theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', settings.theme)
}

/**
 * The HUD's variant: "a page in the dark" (docs/DESIGN.md §6.8) keeps the panel
 * on paper-light even when the rest of the desk goes lamplit.
 */
export function applyHudTheme(settings: Pick<Settings, 'theme' | 'hudTheme'>): void {
  if (settings.hudTheme === 'paper') {
    document.documentElement.setAttribute('data-theme', 'light')
    return
  }
  applyTheme(settings)
}
