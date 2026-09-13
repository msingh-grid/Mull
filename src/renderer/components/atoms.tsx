import type { CSSProperties, JSX, ReactNode } from 'react'
import { WAVE_BARS } from '../hud/view-model'

/**
 * The small parts every Studio Paper surface is built from.
 *
 * Each one is a direct reading of docs/DESIGN.md; none of them decide
 * anything. Styling lives in hud.css / windows.css against tokens, so these
 * carry structure and semantics only.
 */

/** A key hint. Always non-breaking-spaced from its label (§8 copy rules). */
export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <kbd>{children}</kbd>
}

export function Btn({
  kind = 'ghost',
  hint,
  onClick,
  children
}: {
  kind?: 'primary' | 'ghost'
  /** The chord printed inside the label — the HUD is never focused (§7.1). */
  hint?: string
  onClick?: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button type="button" className={`btn ${kind}`} onClick={onClick}>
      <span>{children}</span>
      {hint ? <span className="k">{hint}</span> : null}
    </button>
  )
}

/** Listening indicator. Decoration — the state label carries the meaning (§8). */
export function Orb(): JSX.Element {
  return <span className="orb" aria-hidden="true" />
}

/**
 * Six bars on staggered phases. Amplitudes are fixed rather than driven by the
 * microphone: a real level meter would make a quiet room look like a failure,
 * and the orb already says whether Mull is listening.
 */
export function Waveform(): JSX.Element {
  return (
    <span className="wave" aria-hidden="true">
      {WAVE_BARS.map((bar, index) => (
        <i
          key={index}
          style={
            {
              '--h': `${bar.height}px`,
              '--amp': bar.amp,
              '--d': `${bar.delay}ms`
            } as CSSProperties
          }
        />
      ))}
    </span>
  )
}
