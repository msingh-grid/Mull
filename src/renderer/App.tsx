import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent } from 'react'
import { IDLE_HUD_STATE, type HudAction, type HudState } from '@shared/ipc'
import { Hud } from './components/Hud'

/**
 * The HUD renderer.
 *
 * Its whole job: mirror the state main pushes, report the two chords the user
 * can answer a card with, and carry the pointer work main cannot see. It never
 * derives state and never asks for any — a HUD that computed its own view of
 * what happened could disagree with the journal, and the journal is the record.
 *
 * Two pointer responsibilities, both of which exist because the window is
 * click-through over its transparent stage:
 *
 *  - **Hover.** `setIgnoreMouseEvents(true, { forward: true })` still delivers
 *    mouse moves here, so this is the only place that knows when the pointer is
 *    actually over the panel rather than over the empty stage around it. Main
 *    mirrors that into whether the window takes clicks at all.
 *  - **Drag.** Reported as screen coordinates, which `PointerEvent` hands over
 *    directly; main does the arithmetic and the clamping.
 */
export default function App(): JSX.Element {
  const [state, setState] = useState<HudState>(IDLE_HUD_STATE)
  /**
   * A clock, ticking only while something is in flight.
   *
   * Main pushes state on change, and a wait is precisely the period when
   * nothing changes — so without this the working line's counter would freeze
   * at the moment it was set, which is worse than having no counter at all.
   * Stopped when there is no stage, so an idle HUD re-renders never.
   */
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (!state.stage) return
    const timer = setInterval(() => setTick(Date.now()), 500)
    return () => clearInterval(timer)
  }, [state.stage])
  const bridge = window.mull as typeof window.mull | undefined
  const dragging = useRef(false)

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

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      // Buttons and the diff body keep their own behaviour; everything else on
      // the panel is a handle, which is what makes "move it out of the way"
      // something you can do without hunting for a grip.
      if ((event.target as HTMLElement).closest('button, .diffbody, a, input')) return
      if (event.button !== 0) return
      dragging.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
      bridge?.hud.dragStart({ x: event.screenX, y: event.screenY })
    },
    [bridge]
  )

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (!dragging.current) return
      bridge?.hud.dragMove({ x: event.screenX, y: event.screenY })
    },
    [bridge]
  )

  const endDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (!dragging.current) return
      dragging.current = false
      event.currentTarget.releasePointerCapture(event.pointerId)
      bridge?.hud.dragEnd()
    },
    [bridge]
  )

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
      <div
        className="hud-grip"
        onPointerEnter={() => bridge.hud.hover(true)}
        onPointerLeave={() => {
          // A drag that leaves the panel keeps going — pointer capture holds —
          // so the window must stay interactive until the button comes up.
          if (!dragging.current) bridge.hud.hover(false)
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <Hud state={state} now={tick} onAction={onAction} />
      </div>
    </div>
  )
}
