import type { JSX } from 'react'
import type { ChipKind, HudChip } from '@shared/hud'

/**
 * Chips (docs/DESIGN.md §6.2).
 *
 * A chip announces a classification *before* the action it describes (§7.5) —
 * which is the point: it is how the user finds out Mull thinks this utterance
 * is an edit rather than dictation, in time to stop it.
 */

const GLYPH: Partial<Record<ChipKind, string>> = {
  intent: '✎',
  cmd: '▸',
  mem: '◈'
}

export function Chips({
  chips,
  onCitation
}: {
  chips: HudChip[]
  /** Memory chips are real buttons — they open the citation they claim. */
  onCitation?: (id: string) => void
}): JSX.Element | null {
  if (chips.length === 0) return null

  return (
    <div className="chips">
      {chips.map((chip) => {
        const glyph = GLYPH[chip.kind]
        const inner = (
          <>
            {glyph ? (
              <span className="g" aria-hidden="true">
                {glyph}
              </span>
            ) : null}
            <span>{chip.label}</span>
            {chip.hint ? <span className="k">{chip.hint}</span> : null}
          </>
        )

        return chip.kind === 'mem' ? (
          <button
            key={chip.id}
            type="button"
            className="chip mem"
            aria-label={`Show memory citation: ${chip.label}`}
            onClick={() => onCitation?.(chip.id)}
          >
            {inner}
          </button>
        ) : (
          <span key={chip.id} className={`chip ${chip.kind}`}>
            {inner}
          </span>
        )
      })}
    </div>
  )
}
