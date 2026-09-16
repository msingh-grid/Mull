import React, { useCallback, useEffect, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { DiffSegment } from '@shared/hud'
import type { JournalEntryView } from '@shared/types'
import { DiffBody } from './components/Cards'
import {
  KIND_LABEL,
  groupEntries,
  groupView,
  planMeasure,
  rowElapsed,
  rowKind,
  rowMeasure,
  rowTime,
  stepToggleTarget,
  undoAffordance,
  type JournalGroup
} from './journal/row-model'
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
      <Everything entry={entry} />
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

/**
 * The whole of what was recorded, summarised nowhere.
 *
 * The row above is a sentence and the sentence is a choice about what mattered.
 * This is the rest: the verb and its arguments, what the user actually said,
 * how long it took, what the model was choosing from, and what the step turned
 * out to have done. A record you have to take on trust is not much of a record,
 * and "press · DMs" told nobody why DMs.
 */
function Everything({ entry }: { entry: JournalEntryView }): JSX.Element | null {
  const intent = entry.intent
  const detail = entry.detail
  const facts: Array<[string, string]> = []

  const say = (label: string, value: string | number | null | undefined): void => {
    if (value === null || value === undefined || value === '') return
    facts.push([label, String(value)])
  }

  if (intent.kind === 'command') {
    say('verb', intent.verb)
    const args = Object.entries(intent.args ?? {})
    for (const [key, value] of args) say(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  say('said', 'transcript' in intent ? intent.transcript : undefined)
  if (intent.kind === 'edit') say('instruction', intent.instruction)
  if (intent.kind === 'ask') say('question', intent.question)
  say('app', entry.app?.bundleId)
  say('status', entry.status)
  say('took', rowElapsed(entry.ms))
  say('step', detail?.step)
  say('decided in', rowElapsed(detail?.askMs))
  say('because', detail?.because)
  // The one thing the journal could never say before: whether the press did
  // anything. It is written after the fact, once the next look at the window
  // revealed it — see `JournalStore.amend`.
  say('effect', detail?.evidence)
  if (detail?.scan) {
    say(
      'chose from',
      `${detail.scan.targets} targets (${detail.scan.press} press, ${detail.scan.type} type) · ${detail.scan.stoppedBy}`
    )
  }
  say('group', entry.groupId)

  if (facts.length === 0) return null
  return (
    <div className="everything">
      <div className="everything-head">Everything recorded</div>
      <dl>
        {facts.map(([label, value]) => (
          <div className="fact" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function Row({
  entry,
  expanded,
  steps,
  ordinal,
  onToggle,
  onUndo
}: {
  entry: JournalEntryView
  expanded: boolean
  /** How many steps hang off this row, when it heads an expedition. */
  steps?: number
  /** Its position within one, when it is a step. */
  ordinal?: number
  onToggle: () => void
  onUndo: () => void
}): JSX.Element {
  const kind = rowKind(entry)
  const measure =
    steps !== undefined && steps > 0 ? planMeasure(entry, steps) : rowMeasure(entry)
  const affordance = undoAffordance(entry)
  const elapsed = ordinal !== undefined ? rowElapsed(entry.ms) : null

  return (
    <div className="journal-entry">
      <div className="journal-row">
        {ordinal !== undefined ? <span className="ordinal">{ordinal}</span> : null}
        <span className={`kind ${kind}`}>{KIND_LABEL[kind]}</span>
        <span className="app">{entry.app?.name ?? 'Unknown app'}</span>
        <span className="time">{elapsed ?? rowTime(entry.at)}</span>
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

/**
 * An expedition and the steps it took, or a lone entry.
 *
 * The steps sit under the plan rather than beside it because they were one
 * request, and the list used to show them as five unrelated rows. They are
 * collapsed by default — but the plan's row says *how many* there are, so a
 * closed group never looks like nothing happened. The journal's promise is
 * that everything Mull did is visible; a disclosure is allowed to fold it, not
 * to hide that it exists.
 */
function Group({
  group,
  expandedId,
  onToggle,
  onUndo
}: {
  group: JournalGroup
  expandedId: string | null
  onToggle: (id: string) => void
  onUndo: (id: string) => void
}): JSX.Element {
  const { open, headOpen } = groupView(group, expandedId)
  return (
    <div className={group.steps.length > 0 ? 'journal-group' : undefined}>
      <Row
        entry={group.head}
        steps={group.steps.length}
        expanded={headOpen}
        onToggle={() => onToggle(group.head.id)}
        onUndo={() => onUndo(group.head.id)}
      />
      {open && group.steps.length > 0 ? (
        <div className="journal-steps">
          {group.steps.map((step, index) => (
            <Row
              key={step.id}
              entry={step}
              ordinal={step.detail?.step ?? index + 1}
              expanded={expandedId === step.id}
              onToggle={() => onToggle(stepToggleTarget(group, step.id, expandedId))}
              onUndo={() => onUndo(step.id)}
            />
          ))}
        </div>
      ) : null}
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
            {groupEntries(entries).map((group) => (
              <Group
                key={group.head.id}
                group={group}
                expandedId={expanded}
                onToggle={toggle}
                onUndo={(id) => void undo(id)}
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
