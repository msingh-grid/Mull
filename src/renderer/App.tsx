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
    let cancelled = false
    void window.mull.hud.getState().then((current) => {
      if (!cancelled && current) setState(current)
    })
    const off = window.mull.hud.onState(setState)
    return () => {
      cancelled = true
      off()
    }
  }, [])

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
