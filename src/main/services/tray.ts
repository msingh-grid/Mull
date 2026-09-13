import { Menu, Tray, nativeImage } from 'electron'
import type { HudPhase, MullWindow } from '@shared/ipc'

/**
 * Menu-bar presence (docs/DESIGN.md §6.7).
 *
 * With `LSUIElement: true` there is no Dock icon, so this is the only way to
 * reach the journal, settings and onboarding — and the only place that says
 * "Mull is running" when the HUD is idle and invisible.
 *
 * **M3 uses text glyphs, not template images.** §6.7 asks for a monochrome
 * template icon with an ochre attention badge; that needs real assets, which
 * arrive in M6 with the app icon. A glyph is an honest placeholder: it shows
 * the four states, it tints correctly with the menu bar, and it does not
 * pretend to be the finished mark. The attention state degrades to `!` rather
 * than the badge.
 */

export type TrayState = 'idle' | 'listening' | 'working' | 'attention'

/** §6.7's four states, as the phases that actually produce them. */
export function trayStateFor(phase: HudPhase): TrayState {
  switch (phase) {
    case 'listening':
      return 'listening'
    case 'thinking':
    case 'inserting':
    case 'preview':
      return 'working'
    case 'blocked':
    case 'error':
      return 'attention'
    case 'idle':
    case 'applied':
      return 'idle'
  }
}

const GLYPH: Record<TrayState, string> = {
  idle: '◦', // hollow ring — resident, not listening
  listening: '●', // filled
  working: '● ⋯', // filled + trailing dot
  attention: '● !'
}

export interface TrayMenuHandlers {
  /**
   * Windows whose renderer exists. M3 lands them one stage at a time, and a
   * menu item that opens a blank window is worse than one that is greyed out.
   */
  available: MullWindow[]
  openWindow: (window: MullWindow) => void
  undoLast: () => void
  demoCard: (kind: 'diff' | 'plan') => void
  quit: () => void
}

export class TrayPresence {
  private tray: Tray | null = null
  private state: TrayState = 'idle'
  private status = ''

  constructor(private readonly handlers: TrayMenuHandlers) {}

  start(): void {
    if (this.tray) return
    // An empty image plus a title: macOS renders the title in the menu bar and
    // tints it for us, which is exactly the template behaviour we want.
    this.tray = new Tray(nativeImage.createEmpty())
    this.tray.setToolTip('Mull')
    this.apply()
  }

  /** Called on every HUD state push; cheap and idempotent. */
  setPhase(phase: HudPhase): void {
    const next = trayStateFor(phase)
    if (next === this.state) return
    this.state = next
    this.apply()
  }

  /** One line of truth at the top of the menu, e.g. the hotkey mode. */
  setStatus(status: string): void {
    if (status === this.status) return
    this.status = status
    this.apply()
  }

  private apply(): void {
    if (!this.tray) return
    this.tray.setTitle(GLYPH[this.state])
    this.tray.setContextMenu(this.buildMenu())
  }

  private buildMenu(): Menu {
    const { available, openWindow, undoLast, demoCard, quit } = this.handlers
    const has = (name: MullWindow): boolean => available.includes(name)
    return Menu.buildFromTemplate([
      { label: this.status || 'Mull', enabled: false },
      { type: 'separator' },
      { label: 'Journal…', enabled: has('journal'), click: () => openWindow('journal') },
      {
        label: 'Settings…',
        accelerator: 'Command+,',
        enabled: has('settings'),
        click: () => openWindow('settings')
      },
      { label: 'Onboarding…', enabled: has('onboarding'), click: () => openWindow('onboarding') },
      { type: 'separator' },
      { label: 'Undo last', accelerator: 'Alt+Z', click: () => undoLast() },
      {
        label: 'Preview demo',
        submenu: [
          { label: 'Edit preview', click: () => demoCard('diff') },
          { label: 'Plan', click: () => demoCard('plan') }
        ]
      },
      { type: 'separator' },
      { label: 'Quit Mull', accelerator: 'Command+Q', click: () => quit() }
    ])
  }

  stop(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
