import { useEffect, useState, type JSX } from 'react'
import { IDLE_HUD_STATE, type HudAction, type HudState } from '@shared/ipc'
import { Hud } from './components/Hud'

/**
 * The HUD renderer.
 *
 * Its whole job: mirror the state main pushes, and report the two chords the
 * user can answer a card with. It never derives state and never asks for any —
 * a HUD that computed its own view of what happened could disagree with the
 * journal, and the journal is the record.
 */
export default function App(): JSX.Element {
  const [state, setState] = useState<HudState>(IDLE_HUD_STATE)
  const bridge = window.mull as typeof window.mull | undefined

  useEffect(() => {
    if (!bridge) return

    let cancelled = false
    void bridge.hud.getState().then((current) => {
      if (!cancelled && current) setState(current)
    })
    const off = bridge.hud.onState(setState)
    return () => {
      cancelled = true
      off()
    }
  }, [bridge])

  // Opened without the preload — almost always the dev-server URL in a browser
  // tab. Say so plainly rather than rendering a HUD that will never update.
  if (!bridge) {
    return (
      <div className="hud-stage">
        <div className="hud is-error">
          <div className="hud-top">
            <div className="transcript">
              This page has no bridge to Mull — use the window <code>npm run dev</code> opens.
            </div>
            <div className="state-label">No bridge</div>
          </div>
        </div>
      </div>
    )
  }

  const onAction = (action: HudAction): void => {
    void bridge.hud.action(action)
  }

  return (
    <div className="hud-stage">
      <Hud state={state} onAction={onAction} />
    </div>
  )
}
