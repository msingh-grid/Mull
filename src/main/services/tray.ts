import { Menu, Tray, nativeImage } from 'electron'
import type { HudPhase, MullWindow } from '@shared/ipc'
import { TRAY_ICON_1X, TRAY_ICON_2X } from './tray-icon'

/**
 * Menu-bar presence (docs/DESIGN.md §6.7).
 *
 * With `LSUIElement: true` there is no Dock icon, so this is the only way to
 * reach the journal, settings and onboarding — and the only place that says
 * "Mull is running" when the HUD is idle and invisible.
 *
 * ### The mark, at last
 *
 * This shipped with text glyphs — `◦` for idle — as an honest placeholder,
 * because §6.7 asks for a monochrome template icon and there was no artwork.
 * There is now. The glyph was doing its job badly in one specific way: at rest,
 * which is nearly all of the time, Mull was a full stop in the menu bar and
 * indistinguishable from a rendering artefact.
 *
 * It is a **template image**, which is the whole reason it works: macOS
 * discards the colour and re-tints the alpha for light mode, dark mode and the
 * highlighted state, so Mull never has to know which one it is in. The pixels
 * are black-on-transparent for that reason, not by preference.
 *
 * ### Why a glyph survives beside it
 *
 * §6.7 wants an ochre badge for the attention state, and a badge is a second
 * asset composited at runtime. Until there is one, the states are carried by a
 * short suffix next to the mark — which is what the placeholder always did,
 * and the part of it that was working. Idle carries nothing at all, so the
 * common case is the icon alone.
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

/**
 * What sits beside the mark, per state.
 *
 * Idle is empty on purpose: at rest the icon says everything there is to say,
 * and a glyph next to it would be Mull decorating someone's menu bar for no
 * reason. The other three are a space and one character — enough to notice out
 * of the corner of an eye, not enough to read as a second icon.
 */
const GLYPH: Record<TrayState, string> = {
  idle: '',
  listening: ' ●',
  working: ' ⋯',
  attention: ' !'
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
  /** Back to bottom centre, for a HUD dragged somewhere unhelpful. */
  resetHudPosition: () => void
  quit: () => void
}

/**
 * The mark, at both scale factors, as one image.
 *
 * Two representations rather than two files: macOS picks 1× or 2× per display,
 * and a Mac with one of each attached wants both available at once. Built from
 * data URLs because `TRAY_ICON_*` is a bundled module rather than a path — see
 * `tray-icon.ts` for why that is not a shortcut.
 */
function trayIcon(): Electron.NativeImage {
  const icon = nativeImage.createEmpty()
  icon.addRepresentation({ scaleFactor: 1, dataURL: `data:image/png;base64,${TRAY_ICON_1X}` })
  icon.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${TRAY_ICON_2X}` })
  // The line that makes macOS own the colour. Without it the mark stays black
  // and disappears into a dark menu bar.
  icon.setTemplateImage(true)
  return icon
}

export class TrayPresence {
  private tray: Tray | null = null
  private state: TrayState = 'idle'
  private status = ''

  constructor(private readonly handlers: TrayMenuHandlers) {}

  start(): void {
    if (this.tray) return
    this.tray = new Tray(trayIcon())
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
    const { available, openWindow, undoLast, demoCard, resetHudPosition, quit } = this.handlers
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
      // The way back from dragging the panel onto a display you unplugged, or
      // just somewhere you regret. Cheap to offer, unrecoverable without it.
      { label: 'Reset HUD position', click: () => resetHudPosition() },
      { type: 'separator' },
      { label: 'Quit Mull', accelerator: 'Command+Q', click: () => quit() }
    ])
  }

  stop(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
