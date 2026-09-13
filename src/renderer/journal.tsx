import React, { useCallback, useEffect, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { DiffSegment } from '@shared/hud'
import type { JournalEntryView } from '@shared/types'
import { DiffBody } from './components/Cards'
import { KIND_LABEL, rowKind, rowMeasure, rowTime, undoAffordance } from './journal/row-model'
import { applyTheme } from './theme'
import './tokens.css'
import './hud.css'
import './windows.css'

/**
 * The journal window (docs/DESIGN.md §6.5).
 *
 * Everything Mull did, including the things that failed — a record of only
 * successes is one nobody trusts. Rows expand to the marks that were made,
 * rendered by the same component the HUD's preview used, so the record and the
 * proposal can never look like different events.
 *
 * The expanded row is reflected in `?entry=` so a row can be linked to.
 */

function Detail({ entry }: { entry: JournalEntryView }): JSX.Element {
  const [segments, setSegments] = useState<DiffSegment[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.mull?.journal.detail(entry.id).then((result) => {
      if (!cancelled) setSegments(result?.segments ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [entry.id])

  const affordance = undoAffordance(entry)

  return (
    <div className="journal-detail">
      {segments === null ? (
        <div className="card-body">…</div>
      ) : segments.length > 0 ? (
        <DiffBody segments={segments} />
      ) : (
        <div className="card-body">This entry didn’t change any text.</div>
      )}
      {affordance.why ? <div className="why">{affordance.why}</div> : null}
      <div className="meta">
        <span>{new Date(entry.at).toLocaleString()}</span>
        <span>strategy: {entry.strategyUsed ?? 'none'}</span>
        <span>
          verified: {entry.verified === null ? 'unknown' : entry.verified ? 'yes' : 'no'}
        </span>
        {entry.undoneAt ? <span>undone {rowTime(entry.undoneAt)}</span> : null}
      </div>
    </div>
  )
}

function Row({
  entry,
  expanded,
  onToggle,
  onUndo
}: {
  entry: JournalEntryView
  expanded: boolean
  onToggle: () => void
  onUndo: () => void
}): JSX.Element {
  const kind = rowKind(entry)
  const measure = rowMeasure(entry)
  const affordance = undoAffordance(entry)

  return (
    <div className="journal-entry">
      <div className="journal-row">
        <span className={`kind ${kind}`}>{KIND_LABEL[kind]}</span>
        <span className="app">{entry.app?.name ?? 'Unknown app'}</span>
        <span className="time">{rowTime(entry.at)}</span>
        <span className="sep">—</span>
        <button
          type="button"
          className="sum"
          onClick={onToggle}
          aria-expanded={expanded}
          style={{ background: 'none', border: 0, padding: 0, textAlign: 'left' }}
        >
          {entry.summary}
        </button>
        {measure ? <span className="changes">{measure}</span> : null}
        <button
          type="button"
          className="journal-undo"
          disabled={!affordance.enabled}
          title={affordance.why ?? 'Put this back'}
          onClick={onUndo}
        >
          {affordance.label}
        </button>
      </div>
      {expanded ? <Detail entry={entry} /> : null}
    </div>
  )
}

function Journal(): JSX.Element {
  const [entries, setEntries] = useState<JournalEntryView[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('entry')
  )
  const [toast, setToast] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.mull?.journal.recent(200).then(setEntries)
  }, [])

  useEffect(() => {
    refresh()
    void window.mull?.settings.get().then(applyTheme)
    const offTheme = window.mull?.settings.onChanged(applyTheme)
    const offJournal = window.mull?.journal.onChanged(refresh)
    return () => {
      offTheme?.()
      offJournal?.()
    }
  }, [refresh])

  const toggle = (id: string): void => {
    const next = expanded === id ? null : id
    setExpanded(next)
    // Deep-linkable without a router: the window's own query is the route.
    const url = new URL(window.location.href)
    if (next) url.searchParams.set('entry', next)
    else url.searchParams.delete('entry')
    window.history.replaceState(null, '', url)
  }

  const undo = async (id: string): Promise<void> => {
    const result = await window.mull?.journal.undoEntry(id)
    setToast(result?.message ?? null)
    refresh()
  }

  if (!window.mull) {
    return (
      <div className="win">
        <div className="win-head">
          <h1>Journal</h1>
          <p className="sub">This page has no bridge to Mull.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="win">
      <div className="win-head">
        <h1>Journal</h1>
        <p className="sub">
          Everything Mull did, and whether it could be taken back. Click a row to see the marks.
        </p>
      </div>
      <div className="win-body">
        {entries === null ? (
          <div className="empty">Reading the journal…</div>
        ) : entries.length === 0 ? (
          <div className="empty">Nothing yet. Hold ⌥Space and say something.</div>
        ) : (
          <div className="journal-list">
            {entries.map((entry) => (
              <Row
                key={entry.id}
                entry={entry}
                expanded={expanded === entry.id}
                onToggle={() => toggle(entry.id)}
                onUndo={() => void undo(entry.id)}
              />
            ))}
          </div>
        )}
        {toast ? (
          <div className="toast" role="status">
            {toast}
          </div>
        ) : null}
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('journal: #root element missing')
createRoot(container).render(
  <React.StrictMode>
    <Journal />
  </React.StrictMode>
)
