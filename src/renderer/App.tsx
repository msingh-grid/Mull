import { useEffect, useState, type JSX } from 'react'
import { IDLE_HUD_STATE, type HudState } from '@shared/ipc'

/**
 * HUD placeholder (M1).
 *
 * Wired to real pipeline state, deliberately unstyled: the Studio Paper panel
 * lands in M3 against the frozen tokens in `tokens.css` (docs/DESIGN.md §6.1).
 * Until then this is a state read-out, so the pipeline can be watched while the
 * design is still on the drawing board.
 */

const PHASE_LABEL: Record<HudState['phase'], string> = {
  idle: 'IDLE',
  listening: 'LISTENING',
  thinking: 'THINKING',
  inserting: 'INSERTING',
  applied: 'APPLIED',
  blocked: 'PAUSED',
  error: 'ERROR'
}

export default function App(): JSX.Element {
  const [state, setState] = useState<HudState>(IDLE_HUD_STATE)

  useEffect(() => {
    // No bridge means this page is being viewed outside the app — most often
    // the dev server URL opened in a browser tab. Say so rather than throwing.
    const bridge = window.mull as typeof window.mull | undefined
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
  }, [])

  if (!(window.mull as typeof window.mull | undefined)) {
    return (
      <main style={{ padding: '10px 14px', fontSize: 12, lineHeight: 1.5 }}>
        <div>
          <strong>NO BRIDGE</strong>
        </div>
        <div>
          This is the HUD renderer opened without Mull’s preload — usually the dev-server URL in a
          browser. Use the app window that <code>npm run dev</code> opens.
        </div>
      </main>
    )
  }

  return (
    <main
      role="status"
      aria-live="polite"
      style={{ padding: '10px 14px', fontSize: 12, lineHeight: 1.5 }}
    >
      <div>
        <strong>{PHASE_LABEL[state.phase]}</strong>
        {state.app ? ` · ${state.app.name}` : ''}
      </div>
      <div style={{ minHeight: '2.6em' }}>
        {state.transcript || (state.phase === 'idle' ? 'Hold ⌥Space and speak' : '…')}
      </div>
      {state.notice ? <div>⚠ {state.notice}</div> : null}
      {state.lastAction ? <div>{state.lastAction.summary}</div> : null}
    </main>
  )
}
