import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent } from 'react'
import { IDLE_HUD_STATE, type HudAction, type HudState } from '@shared/ipc'
import { Hud } from './components/Hud'
import { Pet } from './components/Pet'
import { isTap, petView, petWakes } from './hud/pet'

/**
 * The HUD renderer.
 *
 * Its whole job: mirror the state main pushes, report the two chords the user
 * can answer a card with, and carry the pointer work main cannot see. It never
 * derives state and never asks for any — a HUD that computed its own view of
 * what happened could disagree with the journal, and the journal is the record.
 *
 * What it does own is one piece of local interface state: whether the panel is
 * showing. At rest Mull is a pet, and the panel is raised by the rules in
 * `hud/pet.ts` or by a click on it (docs/DESIGN.md §6.1a). Main has no opinion
 * and needs none — nothing about the window changes.
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
  /** Where the pointer went down, and whether it went down on the cat. */
  const down = useRef<{ x: number; y: number; onPet: boolean } | null>(null)

  /** The user's own answer about the panel. Null means "follow the rules". */
  const [wanted, setWanted] = useState<boolean | null>(null)
  /** When the HUD last changed — what the pet's doze is measured from. */
  const [quietSince, setQuietSince] = useState(() => Date.now())
  useEffect(() => {
    setQuietSince(Date.now())
  }, [state])

  /**
   * A dismissal applies to the action that was on screen, not to every action
   * after it — so closing the panel early does not stop the *next* one
   * appearing. A deliberate open is left alone: someone who asked for the panel
   * did not ask for it until the next time they dictated.
   */
  const actionAt = state.lastAction?.at ?? null
  useEffect(() => {
    setWanted((previous) => (previous === false ? null : previous))
  }, [actionAt])

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

  /**
   * The pet's rules change the view on their own — a linger expires, a doze
   * begins — and nothing pushes state at those moments, so the render has to be
   * asked for. One timeout at the exact moment rather than a second interval,
   * because the rule above still holds: an idle HUD re-renders never.
   *
   * `tick` is a dependency so that waking for one deadline schedules the next.
   * `petWakes` answers with the *nearest*, and after an action there are two:
   * the panel folding at 4s and the cat dozing at 90s. Without this the second
   * one would never be set, and the pet would stay awake until main happened to
   * push something.
   */
  useEffect(() => {
    const delay = petWakes(state, { wanted, quietSince })
    if (delay === null) return
    const timer = setTimeout(() => setTick(Date.now()), delay + 1)
    return () => clearTimeout(timer)
  }, [state, wanted, quietSince, tick])

  const view = petView(state, { wanted, quietSince }, tick)
  const { panelOpen, pinnable } = view

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      // Buttons and the diff body keep their own behaviour; everything else on
      // the panel is a handle, which is what makes "move it out of the way"
      // something you can do without hunting for a grip. The pet is the one
      // button that is also a handle — collapsed, it is the only handle there
      // is — so its click is decided on release instead, by distance.
      const target = event.target as HTMLElement
      // …and the transcript, once it is offering to be corrected: a click that
      // started a drag would never reach the field, and a drag is not what
      // someone aiming at a misheard name is doing.
      if (
        target.closest(
          'button:not(.pet), .diffbody, a, input, textarea, .transcript.is-correctable'
        )
      ) {
        return
      }
      if (event.button !== 0) return
      dragging.current = true
      down.current = { x: event.screenX, y: event.screenY, onPet: target.closest('.pet') !== null }
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

      // A press that went down on the cat and did not travel is a click. Done
      // here rather than with `onClick`, which fires at the end of a drag too —
      // and dragging the HUD across the screen must not fold the panel.
      const from = down.current
      down.current = null
      if (!from?.onPet || !pinnable) return
      if (!isTap(from, { x: event.screenX, y: event.screenY })) return
      setWanted(!panelOpen)
    },
    [bridge, panelOpen, pinnable]
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

  /**
   * Correcting what Mull heard.
   *
   * Passed straight through: everything that makes this work — lending the
   * panel the keyboard, giving the card's ⏎ and esc back for the duration,
   * putting the caret back in the app afterwards — is main's, because it is all
   * about windows this renderer cannot see. All that happens here is the two
   * ends of the correction being reported.
   */
  const correct = {
    begin: (): void => bridge.hud.editBegin(),
    end: (text: string | null): void => void bridge.hud.editEnd(text)
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
        {panelOpen ? (
          <Hud
            state={state}
            now={tick}
            onAction={onAction}
            onThinking={(on) => {
              // Optimistic, because main echoes the whole state back a moment
              // later: the toggle must feel like a switch, not like a request.
              setState((previous) => ({ ...previous, thinking: on }))
              void window.mull?.hudThinking(on)
            }}
            onCorrect={correct}
          />
        ) : null}
        <Pet mood={view.mood} label={view.label} expanded={panelOpen} />
      </div>
    </div>
  )
}
