import React, { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { DiffCard } from '@shared/hud'
import type { ModelStatus } from '@shared/model'
import type { PermissionsSnapshot } from '@shared/permissions'
import { IDLE_HUD_STATE, type HudState } from '@shared/ipc'
import { CardView } from './components/Cards'
import { Hud } from './components/Hud'
import { PermissionRows } from './components/PermissionRows'
import { applyTheme } from './theme'
import './tokens.css'
import './hud.css'
import './windows.css'

/**
 * Onboarding — five pages (docs/DESIGN.md §6.8, prototype: design/onboarding.html).
 *
 * The prototype simulated everything. This does not, and that is the point of
 * porting it: page 1 mounts the real HUD component, page 2 runs the real engine
 * through the real differ, page 3's ✓ comes from polling macOS, page 4 detects
 * or downloads the actual model, and page 5 uses the actual hotkey to put text
 * at a real caret. Someone who finishes has done the loop once, for real.
 *
 * Nothing blocks Continue. A permission the user will not grant, a model they
 * do not want yet — the page stays at `·` and the app degrades, because an
 * onboarding that traps you is worse than one you skipped.
 */

const TOTAL_PAGES = 5
const POLL_MS = 1500

function Plate({
  step,
  title,
  children
}: {
  step: number
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="plate">
      <div className="step-no">{step}.</div>
      <h2>{title}</h2>
      <p className="lede">{children}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 1 · What Mull is
// ---------------------------------------------------------------------------

function PageWhat(): JSX.Element {
  const idle: HudState = { ...IDLE_HUD_STATE }
  return (
    <>
      <Plate step={1} title="A thinking layer for your Mac">
        Two keys, and which one you hold is the whole instruction. Hold{' '}
        <kbd>⌥&nbsp;Space</kbd> in any app — Mail, Notes, your editor — and speak: Mull turns your
        words into clean text, placed exactly where your cursor is, instantly and with nothing sent
        anywhere. Hold <kbd>Fn</kbd> instead and the words are a request — “summarise this thread”,
        “make this less apologetic”, “reply saying I’ll have it by five” — answered on a card you
        approve before anything lands.
      </Plate>

      <div className="tenets">
        <div className="tenet">
          <span className="t-mark mem" aria-hidden="true">
            ✓
          </span>
          <span>
            <strong>Your voice stays here.</strong> Audio is transcribed on this Mac and discarded —
            it never leaves. Only text you ask Mull to change is sent anywhere.
          </span>
        </div>
        <div className="tenet">
          <span className="t-mark ins" aria-hidden="true">
            ✎
          </span>
          <span>
            <strong>Nothing changes without a preview.</strong> Edits appear as editor’s marks you
            approve — or don’t.
          </span>
        </div>
        <div className="tenet">
          <span className="t-mark warn" aria-hidden="true">
            ↺
          </span>
          <span>
            <strong>Everything is undoable.</strong> Every action lands in a journal, and{' '}
            <kbd>⌥&nbsp;Z</kbd> takes it back.
          </span>
        </div>
      </div>

      <div className="stage-label">This is Mull, waiting</div>
      {/* The real panel, not a screenshot: the instrument at rest. */}
      <Hud state={idle} now={0} />
    </>
  )
}

// ---------------------------------------------------------------------------
// 2 · The marks
// ---------------------------------------------------------------------------

function PageMarks(): JSX.Element {
  const [card, setCard] = useState<DiffCard | null>(null)
  const [outcome, setOutcome] = useState<'applied' | 'cancelled' | null>(null)

  const load = useCallback(() => {
    setOutcome(null)
    void window.mull?.onboarding.sample().then(setCard)
  }, [])

  useEffect(load, [load])

  return (
    <>
      <Plate step={2} title="Every change shows its marks">
        Select text anywhere and say what you want. Mull marks it up the way an editor would —{' '}
        <em className="ink-del">red pencil</em> for what goes, <em className="ink-ins">ink</em> for
        what replaces it. Nothing changes until you press Apply. Try it:
      </Plate>

      <div className="hud is-preview demo-hud">
        <div className="hud-top">
          <span className="orb" aria-hidden="true" />
          <div className="transcript">“tighten this up and make it sound less apologetic”</div>
          <div className="state-label">{outcome ? 'Idle' : 'Preview'}</div>
        </div>
        <div className="chips">
          <span className="chip intent">
            <span className="g" aria-hidden="true">
              ✎
            </span>
            <span>Edit</span>
          </span>
          <span className="chip dict">Mail — selection</span>
        </div>
        {outcome === null && card ? (
          <CardView card={card} onAction={(action) => setOutcome(action === 'apply' ? 'applied' : 'cancelled')} />
        ) : (
          <div className="last-action">
            <span>
              {outcome === 'applied'
                ? 'Applied · “tighten + de-apologize”'
                : outcome === 'cancelled'
                  ? 'Cancelled — nothing changed'
                  : 'Preparing the preview…'}
            </span>
            {outcome === 'applied' ? (
              <span className="undo">
                <kbd>⌥Z</kbd> undo
              </span>
            ) : null}
          </div>
        )}
      </div>
      <p className="page-note">
        <button type="button" className="btn ghost" onClick={load}>
          Reset demo
        </button>
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------
// 3 · Permissions
// ---------------------------------------------------------------------------

function PagePermissions(): JSX.Element {
  const [snapshot, setSnapshot] = useState<PermissionsSnapshot | null>(null)

  useEffect(() => {
    const poll = (): void => {
      void window.mull?.permissions.get().then(setSnapshot)
    }
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      <Plate step={3} title="Three permissions, each with a reason">
        macOS will ask you to grant these. Mull asks for nothing it can’t explain — and works with
        whatever you grant.
      </Plate>

      {snapshot ? (
        <PermissionRows
          permissions={snapshot.permissions}
          onGrant={(key) => void window.mull?.permissions.open(key)}
        />
      ) : (
        <p className="page-note">Checking…</p>
      )}

      <div className="foot-note">
        <span className="chip warn">secure input — paused</span>
        <span>
          In password fields, macOS blocks listening tools — Mull pauses itself and says so, right
          in the HUD.
        </span>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 4 · The model
// ---------------------------------------------------------------------------

function PageModel(): JSX.Element {
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void window.mull?.model.status().then(setStatus)
    return window.mull?.model.onProgress(setProgress)
  }, [])

  const download = async (): Promise<void> => {
    setMessage(null)
    setProgress({ received: 0, total: 0 })
    const result = await window.mull?.model.download()
    setMessage(result?.message ?? null)
    setProgress(null)
    void window.mull?.model.status().then(setStatus)
  }

  const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`
  const pct =
    progress && progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : null

  return (
    <>
      <Plate step={4} title="Your ears, kept local">
        Mull listens with a speech model that runs entirely on this Mac. One download, then it works
        everywhere — on planes, on VPNs, offline.
      </Plate>

      <div className="perm-rows">
        <div className={`perm-row ${status?.installed ? 'is-done' : ''}`}>
          <span className="st" aria-hidden="true">
            {status?.installed ? '✓' : progress ? '…' : '·'}
          </span>
          <div className="perm-text">
            <div className="perm-name">Whisper — English</div>
            <p className="perm-reason">
              {status?.installed
                ? `${status.file} · ${mb(status.bytes)} · already here`
                : '≈148 MB · saved to Application Support, removable anytime'}
            </p>
            {progress ? (
              <p className="dl-progress mono">
                {pct !== null ? `${pct}% · ` : ''}
                {mb(progress.received)}
              </p>
            ) : null}
            {message ? <p className="perm-reason">{message}</p> : null}
          </div>
          {status?.installed ? (
            <span className="perm-granted">Ready</span>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={progress !== null}
              onClick={() => void download()}
            >
              {progress ? 'Downloading…' : 'Download'}
            </button>
          )}
        </div>
      </div>

      {status && !status.whisperInstalled ? (
        <p className="warn-line">
          The speech engine itself isn’t installed yet. Run <code>brew install whisper-cpp</code> in
          a terminal, then reopen Mull.
        </p>
      ) : null}

      <div className="foot-note">
        <span>
          Because speech recognition is local, your audio never crosses the network — that part is
          architecture, not policy. Text is different: when you ask Mull to change something, the
          passage goes to a model. Settings → Engine has a switch that keeps even that on this Mac.
        </span>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 5 · Rehearsal
// ---------------------------------------------------------------------------

function PageTryIt(): JSX.Element {
  const [state, setState] = useState<HudState>(IDLE_HUD_STATE)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void window.mull?.hud.getState().then((current) => {
      if (current) setState(current)
    })
    const off = window.mull?.hud.onState(setState)
    // The caret has to be somewhere for insertion to have a target.
    noteRef.current?.focus()
    return off
  }, [])

  return (
    <>
      <Plate step={5} title="Try it here">
        A practice page. Click into the note, hold <kbd>⌥&nbsp;Space</kbd>, and say something. This
        is the real hotkey and the real HUD — the text below is placed the same way Mull places it
        in Mail.
      </Plate>

      <textarea
        ref={noteRef}
        className="practice-note"
        rows={4}
        defaultValue="Follow-ups from Tuesday: "
        aria-label="Practice note"
      />

      <div className="stage-label">The HUD, live</div>
      <Hud state={state} />

      <div className="foot-note">
        <span>
          Whatever lands here is in the journal, and <kbd>⌥&nbsp;Z</kbd> takes it back — try that
          too.
        </span>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------

const PAGES = [PageWhat, PageMarks, PagePermissions, PageModel, PageTryIt]

function Onboarding(): JSX.Element {
  const [page, setPage] = useState(0)

  useEffect(() => {
    void window.mull?.settings.get().then(applyTheme)
    return window.mull?.settings.onChanged(applyTheme)
  }, [])

  const Page = PAGES[page] ?? PageWhat
  const last = page === TOTAL_PAGES - 1

  const next = (): void => {
    if (!last) {
      setPage(page + 1)
      return
    }
    void window.mull?.onboarding.done().then(() => window.close())
  }

  return (
    <div className="win onboarding">
      <div className="win-body">
        <Page />
      </div>

      <div className="win-foot">
        <div className="ticks" aria-hidden="true">
          {Array.from({ length: TOTAL_PAGES }, (_, index) => (
            <i key={index} className={index <= page ? 'done' : ''} />
          ))}
        </div>
        <span className="step-count">
          Step {page + 1} of {TOTAL_PAGES}
        </span>
        <div className="grow" />
        <button type="button" className="btn ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
          Back
        </button>
        <button type="button" className="btn primary" onClick={next}>
          <span>{last ? 'Finish' : 'Continue'}</span>
          <span className="k">⏎</span>
        </button>
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('onboarding: #root element missing')
createRoot(container).render(
  <React.StrictMode>
    <Onboarding />
  </React.StrictMode>
)
