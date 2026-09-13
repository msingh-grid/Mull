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

/**
 * What Mull could see when it acted.
 *
 * The receipt, and it exists because of a complaint no one could settle from
 * the outside: *"most of the time it refuses, saying it can only see headers,
 * or sometimes the sidebar."* Either the words were in front of the model or
 * they were not, and there was no way to find out which — the harvest went into
 * a prompt and was gone.
 *
 * So this shows the transcript **exactly as it was sent**, not a fresh read:
 * by now the user has clicked something and the window has moved on, so
 * re-reading it would answer a different question.
 *
 * The picture is loaded only when asked for. It is a couple of hundred
 * kilobytes and it is a photograph of someone's screen; neither is a thing to
 * put on screen by default in a window they opened to check an undo.
 */
function WhatMullSaw({ entry }: { entry: JournalEntryView }): JSX.Element | null {
  const capture = entry.capture
  const [image, setImage] = useState<string | null>(null)
  const [showing, setShowing] = useState(false)
  /** The file is gone, or the browser refused the bytes. Two sentences, not a glyph. */
  const [failed, setFailed] = useState<'missing' | 'unrenderable' | null>(null)

  useEffect(() => {
    if (!showing || image) return
    let cancelled = false
    void window.mull?.journal.capture(entry.id).then((data) => {
      if (cancelled) return
      if (data) setImage(data)
      else setFailed('missing')
    })
    return () => {
      cancelled = true
    }
  }, [showing, image, entry.id])

  if (!capture) return null

  return (
    <details className="saw">
      <summary>
        What Mull saw · {capture.blocks} blocks · {capture.chars} chars
        {capture.truncated ? ' · cut short' : ''} · {capture.harvestMs}ms
      </summary>

      {capture.windowTitle ? <div className="saw-title">{capture.windowTitle}</div> : null}

      {capture.text ? (
        <pre className="saw-text">{capture.text}</pre>
      ) : (
        <div className="why">Mull read no text from this window.</div>
      )}

      <div className="saw-shot">
        {capture.imageFile ? (
          showing ? (
            failed ? (
              <div className="why">{WHY_NO_IMAGE[failed]}</div>
            ) : image ? (
              // A broken <img> is the worst available failure: it renders, so
              // the row shows a broken-image glyph and its alt text, which
              // reads as "Mull is lying about the screenshot" rather than as a
              // file that has aged out. Say which.
              <img
                src={image}
                alt="The window Mull was looking at"
                onError={() => setFailed('unrenderable')}
              />
            ) : (
              <div className="why">…</div>
            )
          ) : (
            <button type="button" className="link" onClick={() => setShowing(true)}>
              Show the screenshot ({Math.round((capture.imageBytes ?? 0) / 1024)} KB)
            </button>
          )
        ) : (
          // The two cases that look identical in an empty box and are not at
          // all the same thing. Only one of them is the user's to fix.
          <div className="why">{describeNoPicture(capture.imageReason)}</div>
        )}
      </div>
    </details>
  )
}

const WHY_NO_IMAGE: Record<'missing' | 'unrenderable', string> = {
  missing:
    'The screenshot has been cleared — Mull keeps only the most recent 25, and this row’s has aged out.',
  unrenderable: 'Mull found the file but this window refused to display it.'
}

/** Why there is no picture, in a sentence that says whose problem it is. */
function describeNoPicture(reason: string | null): string {
  switch (reason) {
    case 'no-screen-recording':
      return 'No screenshot — Mull doesn’t have Screen Recording permission. System Settings → Privacy & Security → Screen Recording, then relaunch Mull.'
    case 'not-requested':
      return 'No screenshot — this action didn’t need one.'
    case 'not-retaken-mid-plan':
      return 'No screenshot — the picture is taken once, when you speak, not on every step of a plan.'
    case 'capture-failed':
      return 'Mull has the permission but the capture failed.'
    case 'could-not-save':
      return 'A screenshot was taken and sent, but Mull couldn’t keep a copy.'
    default:
      return reason ? `No screenshot — ${reason}.` : 'No screenshot.'
  }
}

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
      <WhatMullSaw entry={entry} />
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
