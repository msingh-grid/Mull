import React, { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'framer-motion'
import type { DiffCard } from '@shared/hud'
import type { ModelStatus } from '@shared/model'
import type { PermissionsSnapshot } from '@shared/permissions'
import { IDLE_HUD_STATE, type HudState } from '@shared/ipc'
import { CardView } from './components/Cards'
import { Hud } from './components/Hud'
import { Pet } from './components/Pet'
import { PermissionRows } from './components/PermissionRows'
import { applyTheme } from './theme'
import * as sound from './onboarding/sound'
import {
  EASE_OUT,
  SPRING,
  SPRING_SOFT,
  pageVariants,
  pageVariantsReduced,
  pressable,
  riseItem,
  riseItemReduced,
  staggerParent,
  staggerParentReduced
} from './onboarding/motion'
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
 *
 * Motion and sound (added M5c) are scoped to this window only. §5 of DESIGN.md
 * still governs the HUD, journal and settings: no bounce, no exit animations.
 * Onboarding is the one surface that introduces rather than assists, so it is
 * allowed to perform. See `onboarding/motion.ts` for the carve-out, and
 * `onboarding/sound.ts` for why the instrument goes quiet on page 5.
 */

const TOTAL_PAGES = 5
const POLL_MS = 1500

/** Long enough for the closing chord to be heard before the window goes. */
const FINISH_TAIL_MS = 620

/**
 * Picks the motion vocabulary for the session. `prefers-reduced-motion` is an
 * accessibility setting, not a style preference, so it outranks the expressive
 * carve-out above: the reduced variants keep every state change legible and
 * drop the travel.
 */
function useKit(): {
  page: typeof pageVariants
  parent: typeof staggerParent
  item: typeof riseItem
  reduced: boolean
} {
  const reduced = useReducedMotion() ?? false
  return useMemo(
    () => ({
      page: reduced ? pageVariantsReduced : pageVariants,
      parent: reduced ? staggerParentReduced : staggerParent,
      item: reduced ? riseItemReduced : riseItem,
      reduced
    }),
    [reduced]
  )
}

/** Thin React skin over the sound module, so the footer toggle can re-render. */
function useSound(): { muted: boolean; toggle: () => void } {
  const [muted, setMuted] = useState(() => sound.isMuted())
  const toggle = useCallback(() => {
    const next = !sound.isMuted()
    sound.setMuted(next)
    setMuted(next)
    /* Confirm the un-mute audibly; muting is confirmed by the silence. */
    if (!next) sound.play('tap')
  }, [])
  return { muted, toggle }
}

function Plate({
  step,
  title,
  children
}: {
  step: number
  title: string
  children: React.ReactNode
}): JSX.Element {
  const kit = useKit()
  return (
    <div className="plate">
      <motion.div
        className="step-no"
        variants={kit.item}
        /* The number is the one element that arrives with weight: it is the
           page's address, and the spring makes the page feel entered. */
        initial={kit.reduced ? undefined : { opacity: 0, scale: 0.7, y: 6 }}
        animate={kit.reduced ? undefined : { opacity: 1, scale: 1, y: 0 }}
        transition={SPRING}
      >
        {step}.
      </motion.div>
      <motion.h2 variants={kit.item}>{title}</motion.h2>
      <motion.p className="lede" variants={kit.item}>
        {children}
      </motion.p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 1 · What Mull is
// ---------------------------------------------------------------------------

function PageWhat(): JSX.Element {
  const idle: HudState = { ...IDLE_HUD_STATE }
  const kit = useKit()
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
        {[
          {
            mark: '✓',
            tone: 'mem',
            lead: 'Your voice stays here.',
            rest: ' Audio is transcribed on this Mac and discarded — it never leaves. Only text you ask Mull to change is sent anywhere.'
          },
          {
            mark: '✎',
            tone: 'ins',
            lead: 'Nothing changes without a preview.',
            rest: ' Edits appear as editor’s marks you approve — or don’t.'
          },
          {
            mark: '↺',
            tone: 'warn',
            lead: 'Everything is undoable.',
            rest: ' Every action lands in a journal, and ⌥Z takes it back.'
          }
        ].map((tenet) => (
          <motion.div className="tenet" key={tenet.lead} variants={kit.item}>
            <span className={`t-mark ${tenet.tone}`} aria-hidden="true">
              {tenet.mark}
            </span>
            <span>
              <strong>{tenet.lead}</strong>
              {tenet.rest}
            </span>
          </motion.div>
        ))}
      </div>

      <motion.div variants={kit.item}>
        <div className="stage-label">This is Mull, waiting</div>
        {/* The real panel, not a screenshot: the instrument at rest. */}
        <Hud state={idle} now={0} />
      </motion.div>

      {/* …and what it folds into. Worth showing here, because the resting form
          is the one a new user will actually spend their day looking at. */}
      <motion.div className="pet-note" variants={kit.item}>
        <Pet mood="rest" label="Mull at rest" expanded={false} decorative />
        <p>
          The rest of the time, this is all of it. The panel comes back by itself whenever Mull is
          listening, working or waiting on you — and a click on the cat opens it any time.
        </p>
      </motion.div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 2 · The marks
// ---------------------------------------------------------------------------

function PageMarks(): JSX.Element {
  const [card, setCard] = useState<DiffCard | null>(null)
  const [outcome, setOutcome] = useState<'applied' | 'cancelled' | null>(null)
  const kit = useKit()

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

      <motion.div className="hud is-preview demo-hud" variants={kit.item}>
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

        {/* The card genuinely leaves here. That is the exit animation §5 forbids
            elsewhere, and the reason onboarding is carved out: the user is being
            shown a decision resolving, not told a state. */}
        <AnimatePresence mode="wait" initial={false}>
          {outcome === null && card ? (
            <motion.div
              key="card"
              initial={kit.reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
              animate={kit.reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={kit.reduced ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
              transition={kit.reduced ? { duration: 0.12 } : SPRING_SOFT}
            >
              <CardView
                card={card}
                onAction={(action) => {
                  sound.play(action === 'apply' ? 'apply' : 'cancel')
                  setOutcome(action === 'apply' ? 'applied' : 'cancelled')
                }}
              />
            </motion.div>
          ) : (
            <motion.div
              key="outcome"
              className="last-action"
              initial={kit.reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={kit.reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={kit.reduced ? { duration: 0.12 } : SPRING_SOFT}
            >
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
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <motion.p className="page-note" variants={kit.item}>
        <motion.button
          type="button"
          className="btn ghost"
          onClick={() => {
            sound.play('tap')
            load()
          }}
          {...(kit.reduced ? {} : pressable)}
        >
          Reset demo
        </motion.button>
      </motion.p>
    </>
  )
}

// ---------------------------------------------------------------------------
// 3 · Permissions
// ---------------------------------------------------------------------------

function PagePermissions(): JSX.Element {
  const [snapshot, setSnapshot] = useState<PermissionsSnapshot | null>(null)
  const kit = useKit()
  /* Keys already granted when the page opened. A ✓ that was always there is not
     an event; only the transition is worth a sound. */
  const known = useRef<Set<string> | null>(null)

  useEffect(() => {
    const poll = (): void => {
      void window.mull?.permissions.get().then((next) => {
        if (!next) return
        const granted = new Set(next.permissions.filter((p) => p.granted).map((p) => p.key))
        if (known.current === null) {
          known.current = granted
        } else {
          for (const key of granted) {
            if (!known.current.has(key)) {
              sound.play('grant')
              break
            }
          }
          known.current = granted
        }
        setSnapshot(next)
      })
    }
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      <Plate step={3} title="Four permissions, each with a reason">
        macOS will ask you to grant these. Mull asks for nothing it can’t explain — and works with
        whatever you grant. The last one is optional: without it Mull reads the text of the window
        you’re in but never sees the picture.
      </Plate>

      {/* PermissionRows is shared with Settings, which is still bound by §5, so
          it stays untouched: the row stagger and the ✓ stamp are CSS on
          `.onboarding .perm-row`, scoped to this window. */}
      <motion.div variants={kit.item} className="perm-stage">
        {snapshot ? (
          <PermissionRows
            permissions={snapshot.permissions}
            onGrant={(key) => {
              sound.play('tap')
              void window.mull?.permissions.open(key)
            }}
          />
        ) : (
          <p className="page-note">Checking…</p>
        )}
      </motion.div>

      <motion.div className="foot-note" variants={kit.item}>
        <span className="chip warn">secure input — paused</span>
        <span>
          In password fields, macOS blocks listening tools — Mull pauses itself and says so, right
          in the HUD.
        </span>
      </motion.div>
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
  const kit = useKit()
  const wasInstalled = useRef<boolean | null>(null)

  useEffect(() => {
    void window.mull?.model.status().then(setStatus)
    return window.mull?.model.onProgress(setProgress)
  }, [])

  /* The chord belongs to the moment the model becomes usable, not to every
     status poll that reports it still is. */
  useEffect(() => {
    if (!status) return
    if (wasInstalled.current === false && status.installed) sound.play('ready')
    wasInstalled.current = status.installed
  }, [status])

  const download = async (): Promise<void> => {
    sound.play('tap')
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

      <motion.div className="perm-rows" variants={kit.item}>
        <div className={`perm-row ${status?.installed ? 'is-done' : ''}`}>
          <span className="st" aria-hidden="true">
            {status?.installed ? '✓' : progress ? '…' : '·'}
          </span>
          <div className="perm-text">
            <div className="perm-name">Whisper — English</div>
            <p className="perm-reason">
              {status?.installed
                ? `${status.file} · ${mb(status.bytes)} · already here`
                : '≈466 MB · saved to Application Support, removable anytime'}
            </p>
            {progress ? (
              <>
                <p className="dl-progress mono">
                  {pct !== null ? `${pct}% · ` : ''}
                  {mb(progress.received)}
                </p>
                {/* scaleX rather than width: the one transform that can carry a
                    progress bar without laying the row out again each frame. */}
                <div className="dl-track" aria-hidden="true">
                  <motion.div
                    className="dl-fill"
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: pct === null ? 0.08 : Math.max(pct / 100, 0.02) }}
                    transition={{ duration: 0.4, ease: EASE_OUT }}
                  />
                </div>
              </>
            ) : null}
            {message ? <p className="perm-reason">{message}</p> : null}
          </div>
          {status?.installed ? (
            <span className="perm-granted">Ready</span>
          ) : (
            <motion.button
              type="button"
              className="btn primary"
              disabled={progress !== null}
              onClick={() => void download()}
              {...(kit.reduced || progress !== null ? {} : pressable)}
            >
              {progress ? 'Downloading…' : 'Download'}
            </motion.button>
          )}
        </div>
      </motion.div>

      {/* Named here rather than hidden in Settings, because the person most
          likely to need the bigger model is the one about to discover their
          name is not a word this one knows. */}
      <motion.p className="perm-reason" variants={kit.item}>
        This is the quick one. If it mishears names or you work somewhere noisy, Settings → Speech
        model keeps a larger one — better ears, a longer wait — and downloads it there.
      </motion.p>

      {status && !status.whisperInstalled ? (
        <motion.p className="warn-line" variants={kit.item}>
          The speech engine itself isn’t installed yet. Run <code>brew install whisper-cpp</code> in
          a terminal, then reopen Mull.
        </motion.p>
      ) : null}

      <motion.div className="foot-note" variants={kit.item}>
        <span>
          Because speech recognition is local, your audio never crosses the network — that part is
          architecture, not policy. Text is different: when you ask Mull to change something, the
          passage goes to a model. Settings → Engine has a switch that keeps even that on this Mac.
        </span>
      </motion.div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 5 · Rehearsal
// ---------------------------------------------------------------------------

function PageTryIt(): JSX.Element {
  const [state, setState] = useState<HudState>(IDLE_HUD_STATE)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const kit = useKit()

  useEffect(() => {
    void window.mull?.hud.getState().then((current) => {
      if (current) setState(current)
    })
    const off = window.mull?.hud.onState(setState)
    // The caret has to be somewhere for insertion to have a target.
    noteRef.current?.focus()
    return off
  }, [])

  /* The whole reason the instrument has a suppress switch. While the mic is
     open, any cue we play is recorded and comes back as words in the user's own
     transcript. Silence here is correctness, not taste — and it is released on
     unmount so the rest of the flow keeps its sound. */
  useEffect(() => {
    const live = state.phase === 'listening'
    sound.setSuppressed(live)
    return () => sound.setSuppressed(false)
  }, [state.phase])

  return (
    <>
      <Plate step={5} title="Try it here">
        A practice page. Click into the note, hold <kbd>⌥&nbsp;Space</kbd>, and say something. This
        is the real hotkey and the real HUD — the text below is placed the same way Mull places it
        in Mail.
      </Plate>

      <motion.textarea
        ref={noteRef}
        className="practice-note"
        rows={4}
        defaultValue="Follow-ups from Tuesday: "
        aria-label="Practice note"
        variants={kit.item}
      />

      <motion.div variants={kit.item}>
        <div className="stage-label">
          The HUD, live
          {/* Says why it went quiet, so the silence reads as deliberate. */}
          <AnimatePresence>
            {state.phase === 'listening' ? (
              <motion.span
                className="mic-quiet"
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: EASE_OUT }}
              >
                sound paused — mic is open
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
        <Hud state={state} />
      </motion.div>

      <motion.div className="foot-note" variants={kit.item}>
        <span>
          Whatever lands here is in the journal, and <kbd>⌥&nbsp;Z</kbd> takes it back — try that
          too.
        </span>
      </motion.div>
    </>
  )
}

// ---------------------------------------------------------------------------

const PAGES = [PageWhat, PageMarks, PagePermissions, PageModel, PageTryIt]

function Onboarding(): JSX.Element {
  const [page, setPage] = useState(0)
  /* +1 forward, -1 back. Drives the page variants so Continue and Back read as
     opposite gestures instead of the same crossfade twice. */
  const [direction, setDirection] = useState(1)
  const kit = useKit()
  const { muted, toggle } = useSound()

  useEffect(() => {
    void window.mull?.settings.get().then(applyTheme)
    return window.mull?.settings.onChanged(applyTheme)
  }, [])

  /* An AudioContext may not start outside a user gesture. The first click or
     key anywhere in the window is enough, and the listener retires itself. */
  useEffect(() => {
    const open = (): void => sound.unlock()
    window.addEventListener('pointerdown', open, { once: true })
    window.addEventListener('keydown', open, { once: true })
    return () => {
      window.removeEventListener('pointerdown', open)
      window.removeEventListener('keydown', open)
    }
  }, [])

  const Page = PAGES[page] ?? PageWhat
  const last = page === TOTAL_PAGES - 1

  const goBack = (): void => {
    if (page === 0) return
    sound.play('back')
    setDirection(-1)
    setPage(page - 1)
  }

  const next = (): void => {
    if (!last) {
      sound.play('advance')
      setDirection(1)
      setPage(page + 1)
      return
    }
    /* Let the closing chord finish before the window goes, then leave — but
       never leave the user waiting on a sound they muted. */
    sound.play('finish')
    const close = (): void => {
      void window.mull?.onboarding.done().then(() => window.close())
    }
    if (muted) close()
    else window.setTimeout(close, FINISH_TAIL_MS)
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="win onboarding">
        <div className="win-body">
          <AnimatePresence mode="wait" custom={direction} initial={false}>
            <motion.div
              key={page}
              custom={direction}
              variants={kit.page}
              initial="enter"
              animate="settled"
              exit="leave"
              className="page-stage"
            >
              {/* The stagger parent and the page transition are the same element
                  on purpose: children inherit `settled`, so each page's blocks
                  arrive in sequence behind the page that carries them. */}
              <motion.div variants={kit.parent} initial="enter" animate="settled">
                <Page />
              </motion.div>
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="win-foot">
          <div className="ticks" aria-hidden="true">
            {Array.from({ length: TOTAL_PAGES }, (_, index) => (
              <i key={index} className={index <= page ? 'done' : ''}>
                {index === page ? (
                  /* One travelling marker rather than five that recolour:
                     layoutId hands the same element from tick to tick. */
                  <motion.span
                    layoutId={kit.reduced ? undefined : 'tick-head'}
                    className="tick-head"
                    transition={SPRING}
                  />
                ) : null}
              </i>
            ))}
          </div>

          <span className="step-count">
            Step {page + 1} of {TOTAL_PAGES}
          </span>

          <div className="grow" />

          <motion.button
            type="button"
            className="btn ghost sound-toggle"
            onClick={toggle}
            aria-pressed={!muted}
            title={muted ? 'Turn sound on' : 'Turn sound off'}
            {...(kit.reduced ? {} : pressable)}
          >
            <span aria-hidden="true">{muted ? '♪̸' : '♪'}</span>
            <span className="sr-only">{muted ? 'Sound off' : 'Sound on'}</span>
          </motion.button>

          <motion.button
            type="button"
            className="btn ghost"
            disabled={page === 0}
            onClick={goBack}
            {...(kit.reduced || page === 0 ? {} : pressable)}
          >
            Back
          </motion.button>

          <motion.button
            type="button"
            className="btn primary"
            onClick={next}
            onHoverStart={() => sound.play('hover')}
            {...(kit.reduced ? {} : pressable)}
          >
            <span>{last ? 'Finish' : 'Continue'}</span>
            <span className="k">⏎</span>
          </motion.button>
        </div>
      </div>
    </MotionConfig>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('onboarding: #root element missing')
createRoot(container).render(
  <React.StrictMode>
    <Onboarding />
  </React.StrictMode>
)
