import { randomUUID } from 'node:crypto'
import type { ContextMode, ScreenContext } from '@shared/context'
import type { HudChip } from '@shared/hud'
import {
  IDLE_HUD_STATE,
  MAX_UTTERANCE_MS,
  MIN_UTTERANCE_MS,
  type HudState
} from '@shared/ipc'
import type { SidecarApi } from '@shared/sidecar-api'
import type { AsrProvider } from '../asr/types'
import type { Bench } from '../bench'
import { concatFloat32, peakAmplitude } from '../audio/wav'
import { cleanTranscript, summarise } from './cleanup'
import { describeInsertionReason, type InsertionService } from '../services/insertion'
import {
  captureFocus,
  classifierContext,
  countWords,
  editTarget,
  hasEditableText,
  probeSelectionByCopy,
  type EditTarget,
  type FocusSnapshot
} from './selection'
import type { IntentRouter } from './intent'
import { wantsSend } from './router'
import type { HotkeyIntent } from '../services/hotkey'
import type { JournalStore } from '../store/journal'
import type { CaptureStore } from '../store/captures'
import type { JournalDraft, JournalEntry } from '@shared/types'

/**
 * The loop: hold key -> capture -> transcribe -> clean -> route -> insert.
 *
 * Two invariants from docs/PLAN.md are enforced here, not by convention:
 *
 *  1. Dictation never waits when there is nothing to edit. M4 promised this
 *     absolutely and M4.1 narrowed it on purpose: a rules table cannot tell
 *     "make my last message less apologetic" from prose, so the model decides
 *     (`intent.ts`). It is only ever asked when the focused field holds text or
 *     something is selected — an empty box still inserts with no engine in the
 *     loop, and that is most dictation. The snapshot that answers "is there
 *     anything to edit?" is read during the hold, so the question itself is free.
 *  2. Insertion is hard-blocked while macOS secure input is active. It is
 *     checked twice — when capture starts (so we can tell the user early) and
 *     again immediately before inserting, because focus can move to a password
 *     field mid-utterance.
 *
 * Everything is injected, so the whole loop runs in tests against fakes.
 */

/**
 * The edit lane, as this file sees it (implementation: `sculpt.ts`).
 *
 * Narrowed to one method and declared here rather than imported so the
 * dictation path cannot accidentally reach into the engine: the type system
 * enforces invariant 1 as well as the code does.
 */
export interface SculptLaneLike {
  run(request: {
    instruction: string
    transcript: string
    target: EditTarget
    app: { bundleId: string; name: string } | null
    context?: ScreenContext | null
    send?: boolean
    routedBy?: string
    classifyMs?: number | null
  }): Promise<void>
  /** "Send the message" — a card over text that is already written. */
  sendOnly(request: {
    app: { bundleId: string; name: string } | null
    text: string
    transcript: string
    routedBy?: string
  }): Promise<void>
}

/**
 * The navigation lane, as this file sees it (implementation: `navigate.ts`).
 *
 * Narrowed to one method for the same reason `SculptLaneLike` is: dictation
 * must not be able to reach anything that presses a key. All this can do is put
 * a proposal on screen; the loop starts when the user presses Run, inside the
 * lane, where this file cannot see it.
 */
export interface NavigateLaneLike {
  propose(request: {
    goal: string
    transcript: string
    app: { bundleId: string; name: string } | null
    context?: ScreenContext | null
    routedBy?: string
  }): Promise<void>
}

export interface DictationDeps {
  sidecar: SidecarApi
  asr: AsrProvider
  capture: { start(): void; stop(): void }
  bench: Bench
  /** Walks the per-app strategy chain (M2). */
  insertion: InsertionService
  /** Where instructions go. Absent = every utterance is dictation. */
  sculpt?: SculptLaneLike
  /** Where "go and look somewhere else" goes. Absent = never offered. */
  navigate?: NavigateLaneLike
  /** Decides dictate-vs-edit. Absent = every utterance is dictation. */
  intent?: IntentRouter
  /**
   * How much of the screen Mull may read, asked fresh each utterance so a
   * change in Settings takes effect on the next thing you say. Absent means
   * nothing is read, which is what every pre-M5a test runs against.
   */
  screenContext?: () => { mode: ContextMode; excluded?: readonly string[] }
  /** Where applied and failed actions are written down. Optional in tests. */
  journal?: JournalStore
  /**
   * Where the evidence is kept. Paired with `journal`: any hold that reads the
   * window must leave a row that can show what it read, or the capture is
   * unaccountable.
   */
  captures?: CaptureStore
  onState: (state: HudState) => void
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  now?: () => number
  /** How long 'applied' stays on screen before returning to idle. */
  appliedLingerMs?: number
}

/** Below this peak the recording is room tone; don't pay for ASR. */
const SILENCE_PEAK = 0.006

type Phase = 'idle' | 'capturing' | 'processing'

export class DictationPipeline {
  private phase: Phase = 'idle'
  private chunks: Float32Array[] = []
  private startedAt = 0
  private sampleRate: number
  private state: HudState = { ...IDLE_HUD_STATE }
  private maxTimer: NodeJS.Timeout | null = null
  private lingerTimer: NodeJS.Timeout | null = null
  /** Read during the hold; resolved by the time a normal utterance ends. */
  private focusPromise: Promise<FocusSnapshot> | null = null
  /** Which key started this utterance. See `begin`. */
  private intent: HotkeyIntent = 'dictate'
  private readonly now: () => number
  private readonly log: NonNullable<DictationDeps['log']>

  constructor(
    private readonly deps: DictationDeps,
    sampleRate: number
  ) {
    this.sampleRate = sampleRate
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? (() => {})
  }

  getState(): HudState {
    return this.state
  }

  private setState(patch: Partial<HudState>): void {
    this.state = { ...this.state, ...patch }
    this.deps.onState(this.state)
  }

  private toIdle(notice: string | null = null): void {
    this.setState({
      phase: 'idle',
      transcript: '',
      partial: false,
      app: null,
      notice,
      chips: []
    })
  }

  /**
   * Let the edit lane write the panel while it works.
   *
   * There is still exactly one object writing HUD base state — this one. The
   * lane borrows it, and the borrow is refused mid-utterance for the same
   * reason `announce()` is: whatever the user is saying right now outranks a
   * card they were looking at a moment ago.
   */
  patchState(patch: Partial<HudState>): boolean {
    if (this.phase === 'capturing') return false
    this.setState(patch)
    return true
  }

  /** Called for every PCM chunk the capture renderer produces. */
  pushChunk(pcm: Float32Array): void {
    if (this.phase !== 'capturing') return
    this.chunks.push(pcm)
  }

  /** The capture renderer reports the real context rate once the graph is live. */
  setSampleRate(rate: number): void {
    if (rate > 0) this.sampleRate = rate
  }

  /**
   * @param intent Which key was held. `dictate` never touches an engine —
   *        that is the whole point of there being two keys.
   */
  begin(intent: HotkeyIntent = 'dictate'): void {
    if (this.phase !== 'idle') return
    this.intent = intent
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer)
      this.lingerTimer = null
    }

    this.phase = 'capturing'
    this.chunks = []
    this.startedAt = this.now()
    this.deps.capture.start()
    this.setState({ phase: 'listening', transcript: '', partial: true, notice: null, chips: [] })

    // What is in front of the caret, read while the user is still speaking.
    // Taking it here is what lets the routing decision cost nothing extra, and
    // what lets the fast path know there is nothing to edit without asking.
    // The window is read only when the user pressed the key that asks. ⌥Space
    // types what it hears and never reaches an engine, so reading the screen
    // during one of those holds — let alone photographing it — would be a
    // capture with no consumer and no journal row to account for it.
    this.focusPromise = captureFocus(
      this.deps.sidecar,
      this.log,
      intent === 'instruct' ? this.deps.screenContext?.() : undefined
    )
    void this.focusPromise.then((snapshot) => {
      // Kept whether or not the utterance is still live: if the window was read
      // it has to be accountable, and an utterance abandoned halfway is exactly
      // the case where nobody would otherwise look.
      this.seeing = snapshot.context
      if (this.phase !== 'capturing') return
      // Announced before the user finishes speaking, so they can see what Mull
      // is looking at in time to change their mind (docs/DESIGN.md §7.5).
      const chips = [askChip(this.intent), focusChip(snapshot), readingChip(snapshot)].filter(
        (chip): chip is HudChip => chip !== null
      )
      if (chips.length > 0) this.setState({ chips })
    })

    this.maxTimer = setTimeout(() => {
      this.log('warn', 'dictation: max utterance length reached; stopping')
      this.end()
    }, MAX_UTTERANCE_MS)

    // Context, in parallel and off the critical path.
    void this.deps.sidecar
      .frontmostApp({})
      .then(({ app }) => {
        if (this.phase === 'capturing' && app) {
          this.setState({ app: { bundleId: app.bundleId, name: app.name } })
        }
      })
      .catch((err: unknown) => this.log('warn', 'dictation: frontmostApp failed', err))

    void this.deps.sidecar
      .secureInputState({})
      .then(({ active }) => {
        if (active && this.phase === 'capturing') {
          this.abort('Secure input is on — Mull paused. Leave the password field and try again.')
        }
      })
      .catch((err: unknown) => this.log('warn', 'dictation: secureInputState failed', err))
  }

  private abort(notice: string): void {
    this.clearTimers()
    this.deps.capture.stop()
    this.phase = 'idle'
    this.chunks = []
    this.setState({ phase: 'blocked', transcript: '', partial: false, notice })
    this.deps.bench.record({
      kind: 'dictation',
      provider: this.deps.asr.name,
      model: 'n/a',
      chars: 0,
      app: this.state.app?.bundleId ?? null,
      outcome: 'blocked',
      reason: notice,
      captureMs: this.now() - this.startedAt,
      audioSeconds: 0,
      asrMs: 0,
      cleanupMs: 0,
      insertMs: 0,
      totalMs: 0
    })
  }

  private clearTimers(): void {
    if (this.maxTimer) {
      clearTimeout(this.maxTimer)
      this.maxTimer = null
    }
  }

  end(): void {
    if (this.phase !== 'capturing') return
    this.clearTimers()
    this.deps.capture.stop()
    this.phase = 'processing'
    const captureMs = this.now() - this.startedAt
    void this.process(captureMs)
  }

  private async process(captureMs: number): Promise<void> {
    const keyUpAt = this.now()
    const pcm = concatFloat32(this.chunks)
    this.chunks = []
    const audioSeconds = pcm.length / this.sampleRate

    const discard = (reason: string, notice: string | null): void => {
      this.phase = 'idle'
      this.toIdle(notice)
      this.deps.bench.record({
        kind: 'dictation',
        provider: this.deps.asr.name,
        model: 'n/a',
        chars: 0,
        app: this.state.app?.bundleId ?? null,
        outcome: 'discarded',
        reason,
        captureMs,
        audioSeconds,
        asrMs: 0,
        cleanupMs: 0,
        insertMs: 0,
        totalMs: this.now() - keyUpAt
      })
    }

    if (captureMs < MIN_UTTERANCE_MS) return discard('too-short', null)
    if (pcm.length === 0) return discard('no-audio', 'No audio captured — is the microphone allowed?')
    if (peakAmplitude(pcm) < SILENCE_PEAK) return discard('silence', null)

    this.setState({ phase: 'thinking', partial: false })

    try {
      const asrStart = this.now()
      const result = await this.deps.asr.transcribe(pcm, this.sampleRate)
      const asrMs = this.now() - asrStart

      const cleanStart = this.now()
      const { text, removedFillers } = cleanTranscript(result.text)
      const cleanupMs = this.now() - cleanStart

      if (!text) return discard('empty-transcript', null)
      this.setState({ transcript: text })

      // Second secure-input check: focus can move while we were transcribing.
      const secure = await this.deps.sidecar.secureInputState({})
      if (secure.active) {
        this.phase = 'idle'
        // The user said something and nothing happened: that is exactly the
        // case the journal exists to explain.
        this.journal({
          intent: { kind: 'dictate', text },
          app: this.state.app,
          before: null,
          after: null,
          strategyUsed: null,
          status: 'cancelled',
          summary: `Dictation withheld · secure input · “${summarise(text)}”`,
          verified: null,
          caret: null,
          undoable: false
        })
        this.setState({
          phase: 'blocked',
          notice: 'Secure input turned on while Mull was listening — nothing was inserted.'
        })
        return
      }

      // ---- Routing ---------------------------------------------------------
      // Read the invariant at the top of this file before changing anything
      // here. `IntentRouter` answers synchronously when there is nothing an
      // edit could act on, which is the case this loop must never slow down;
      // only an utterance with text in front of it can reach the model.
      const routed = await this.decide(text)
      let hint: string | null = null

      // A bare send writes nothing at all, so it never reaches the insertion
      // path below — the words were a command, not a message.
      if (routed?.route.kind === 'send' && this.deps.sculpt) {
        this.phase = 'idle'
        await this.deps.sculpt.sendOnly({
          app: this.state.app ?? routed.snapshot.app,
          text: routed.snapshot.field?.text ?? '',
          transcript: text,
          routedBy: routed.by
        })
        return
      }

      // The answer is somewhere else in this app. Nothing is written here and
      // nothing moves yet — the lane puts a proposal on screen and the user
      // presses Run. Only the model can choose this route (see `router.ts`).
      if (routed?.route.kind === 'navigate' && this.deps.navigate) {
        this.phase = 'idle'
        await this.deps.navigate.propose({
          goal: routed.route.goal,
          transcript: text,
          app: this.state.app ?? routed.snapshot.app,
          context: routed.snapshot.context,
          routedBy: routed.by
        })
        return
      }

      if (
        (routed?.route.kind === 'edit' || routed?.route.kind === 'compose') &&
        this.deps.sculpt
      ) {
        const target = editTarget(
          routed.snapshot,
          routed.route.kind === 'compose' ? 'draft' : routed.route.target
        )
        if (target.ok) {
          // Did they ask for it to be sent? Read off their own transcript, here,
          // rather than taken from the classifier's answer — see `wantsSend`.
          // The instruction is cleaned of the same phrase so the draft does not
          // end up with "and send it" written into it.
          const wish = wantsSend(text)
          // Idle before handing off: the lane owns the panel from here, and a
          // new utterance must be able to interrupt it.
          this.phase = 'idle'
          await this.deps.sculpt.run({
            instruction: wish.send
              ? wantsSend(routed.route.instruction).without
              : routed.route.instruction,
            send: wish.send,
            transcript: text,
            target: target.target,
            app: this.state.app ?? routed.snapshot.app,
            // The same window the routing decision was made from — read at
            // key-down, never re-read. An edit is a promise about what the user
            // was looking at when they spoke.
            context: routed.snapshot.context,
            routedBy: routed.by,
            classifyMs: routed.classifyMs
          })
          return
        }
        // Understood, but unable — the field is too long to rewrite whole, or
        // the app will not accept the write. Type the words (so nothing the
        // user said is lost) and say what stopped the edit.
        hint = target.message
      }

      this.setState({ phase: 'inserting' })
      const insertStart = this.now()
      // Normally resolved during the hold, off the critical path. A very short
      // utterance can outrun it — and the strategy, the journal entry and undo
      // all key off the app, so it is worth one round trip to know.
      const target = this.state.app ?? (await this.resolveApp())
      const inserted = await this.deps.insertion.insert(text, target)
      const insertMs = this.now() - insertStart

      this.phase = 'idle'

      const appName = target?.name ?? 'this app'
      const summary = `Dictation · ${appName} · “${summarise(text)}”`

      if (!inserted.inserted) {
        const notice = describeInsertionReason(inserted.reason)
        this.journal({
          intent: { kind: 'dictate', text },
          app: target,
          before: null,
          after: null,
          strategyUsed: null,
          status: 'failed',
          summary: `${summary} — not inserted`,
          verified: null,
          caret: null,
          undoable: false
        })
        this.setState({ phase: 'error', notice, partial: false })
        this.deps.bench.record({
          kind: 'dictation',
          provider: this.deps.asr.name,
          model: result.model,
          chars: text.length,
          app: this.state.app?.bundleId ?? null,
          outcome: 'failed',
          reason: inserted.reason ?? 'unknown',
          strategy: null,
          attempts: inserted.attempts.map((a) => `${a.strategy}:${a.reason ?? 'ok'}`).join(','),
          captureMs,
          audioSeconds,
          asrMs,
          cleanupMs,
          insertMs,
          totalMs: this.now() - keyUpAt
        })
        return
      }

      const entry = this.journal({
        intent: { kind: 'dictate', text },
        app: target,
        before: null,
        after: text,
        strategyUsed: inserted.strategyUsed,
        status: 'applied',
        summary,
        verified: inserted.verified,
        caret: inserted.caret,
        // Undo removes exactly these characters, so it is offered only when the
        // sidecar read them back and can say where they end.
        undoable: inserted.verified === true && inserted.caret !== null
      })

      this.setState({
        phase: 'applied',
        partial: false,
        notice: hint,
        lastAction: {
          summary,
          at: this.now(),
          chars: text.length,
          entryId: entry?.id ?? null,
          undoable: entry?.undoable ?? false
        }
      })
      this.log('info', 'dictation applied', {
        chars: text.length,
        removedFillers,
        asrMs,
        insertMs,
        strategy: inserted.strategyUsed,
        verified: inserted.verified
      })

      this.deps.bench.record({
        kind: 'dictation',
        provider: this.deps.asr.name,
        model: result.model,
        chars: text.length,
        app: this.state.app?.bundleId ?? null,
        outcome: 'applied',
        routedBy: routed?.by,
        classifyMs: routed?.classifyMs ?? null,
        strategy: inserted.strategyUsed,
        attempts: inserted.attempts.map((a) => `${a.strategy}:${a.reason ?? 'ok'}`).join(','),
        captureMs,
        audioSeconds,
        asrMs,
        cleanupMs,
        insertMs,
        totalMs: this.now() - keyUpAt
      })

      this.lingerTimer = setTimeout(() => {
        this.lingerTimer = null
        if (this.phase === 'idle') this.toIdle()
      }, this.deps.appliedLingerMs ?? 1_400)
    } catch (err) {
      this.phase = 'idle'
      const message = err instanceof Error ? err.message : String(err)
      this.log('error', 'dictation failed', message)
      this.setState({ phase: 'error', partial: false, notice: `Couldn’t finish: ${message}` })
      this.deps.bench.record({
        kind: 'dictation',
        provider: this.deps.asr.name,
        model: 'n/a',
        chars: 0,
        app: this.state.app?.bundleId ?? null,
        outcome: 'failed',
        reason: message,
        captureMs,
        audioSeconds,
        asrMs: 0,
        cleanupMs: 0,
        insertMs: 0,
        totalMs: this.now() - keyUpAt
      })
    }
  }

  /**
   * Ask what the user meant.
   *
   * The snapshot is the one taken at key-down, awaited but never re-read: an
   * edit is a promise about the text the user was looking at when they spoke,
   * not about whatever happens to be on screen once transcription finishes.
   *
   * Returns null when there is no edit lane at all, which is the pre-M4
   * behaviour and what every test of the plain loop runs against.
   */
  private async decide(text: string): Promise<
    | (Awaited<ReturnType<IntentRouter['decide']>> & { snapshot: FocusSnapshot })
    | null
  > {
    if (!this.deps.sculpt || !this.deps.intent || !this.focusPromise) return null
    // ⌥Space is dictation and nothing else. No engine, no screen read sent
    // anywhere, no pause — the invariant at the top of this file, back in its
    // unqualified form now that a second key carries the other meaning.
    if (this.intent !== 'instruct') return null

    let snapshot = await this.focusPromise

    // Nothing highlighted that AX could see. Ask the app the way every other
    // Mac tool does — ⌘C — before concluding there is nothing to edit. Only on
    // the instruct key, because it presses a key in someone else's app.
    if (!snapshot.selection) {
      snapshot = await probeSelectionByCopy(this.deps.sidecar, snapshot, this.log)
    }
    const decision = await this.deps.intent.decide({
      transcript: text,
      app: this.state.app ?? snapshot.app,
      ...classifierContext(snapshot)
    })
    if (decision.by !== 'fast-path') {
      this.log('info', 'intent routed', {
        by: decision.by,
        kind: decision.route.kind,
        classifyMs: decision.classifyMs,
        fallbackReason: decision.fallbackReason
      })
    }
    // A fallback is shown, not swallowed: a misroute while the engine is down
    // should be explainable rather than mysterious.
    if (decision.fallbackReason && decision.fallbackReason !== 'rules-only') {
      this.setState({
        chips: [{ kind: 'warn', id: 'routing', label: 'routing offline' }]
      })
    }
    return { ...decision, snapshot }
  }

  private async resolveApp(): Promise<HudState['app']> {
    try {
      const { app } = await this.deps.sidecar.frontmostApp({})
      if (!app) return null
      const resolved = { bundleId: app.bundleId, name: app.name }
      this.setState({ app: resolved })
      return resolved
    } catch (err) {
      this.log('warn', 'dictation: frontmostApp failed', err)
      return null
    }
  }

  /**
   * Show a message that didn't come from an utterance — an undo result, a
   * permission warning. Ignored mid-utterance: the HUD belongs to whatever the
   * user is saying right now, and nothing may interrupt that.
   */
  announce(
    phase: Extract<HudState['phase'], 'applied' | 'error' | 'blocked'>,
    notice: string,
    lastAction?: HudState['lastAction']
  ): boolean {
    if (this.phase !== 'idle') return false
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer)
      this.lingerTimer = null
    }
    this.setState({
      phase,
      notice,
      partial: false,
      transcript: '',
      ...(lastAction !== undefined ? { lastAction } : {})
    })
    // A success can go as soon as it has registered; a refusal is the only
    // explanation the user will get and has to survive being read. Losing that
    // sentence after 1.4s is why an apply that declined looked like an apply
    // that did nothing.
    const linger = this.deps.appliedLingerMs ?? (phase === 'applied' ? 1_400 : 6_000)
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null
      if (this.phase === 'idle') this.toIdle()
    }, linger)
    return true
  }

  /**
   * Write one row. Journalling must never be the reason an utterance fails, so
   * a broken store is logged and swallowed — the text is already on screen.
   */
  /**
   * Write the row — with the receipt, if this utterance read anything.
   *
   * Fn can end in plain dictation: the classifier answers `dictate`, or it is
   * unreachable and the fallback types the words. Those holds still read the
   * window, so they still owe the user a row that says what was read. Without
   * this, the only way to capture a screen with no journal entry to account for
   * it would be to ask a question the model then declined to act on — which is
   * exactly the case someone checking up on Mull would try first.
   */
  private journal(draft: JournalDraft): JournalEntry | null {
    if (!this.deps.journal) return null
    try {
      const id = draft.id ?? randomUUID()
      return this.deps.journal.append({
        ...draft,
        id,
        capture: draft.capture ?? this.deps.captures?.save(id, this.seeing) ?? null
      })
    } catch (err) {
      this.log('error', 'journal write failed', err)
      return null
    }
  }

  /** The window this utterance read, if it read one. See `journal`. */
  private seeing: ScreenContext | null = null

  dispose(): void {
    this.clearTimers()
    if (this.lingerTimer) clearTimeout(this.lingerTimer)
  }
}


/**
 * The chip that says what Mull is looking at, shown while the user speaks.
 *
 * A selection is named by size because that is the thing you want to check
 * before you commit ("did it get the whole paragraph?"). A field with text in
 * it is named by the app, because what matters there is only that Mull can see
 * something to work on. An empty field gets no chip: there is nothing to say.
 */
function focusChip(snapshot: FocusSnapshot): HudChip | null {
  const { hasSelection, hasFieldText } = hasEditableText(snapshot)
  const app = snapshot.app?.name
  if (hasSelection && snapshot.selection) {
    return {
      kind: 'dict',
      id: 'focus',
      label: `${app ?? 'Selected'} — ${countWords(snapshot.selection.text)} words`
    }
  }
  if (hasFieldText) {
    return { kind: 'dict', id: 'focus', label: app ? `${app} — this field` : 'this field' }
  }
  return null
}

/**
 * What Mull is reading, said out loud before the user stops speaking.
 *
 * This chip is the reason capturing the window by default is acceptable rather
 * than creepy. Mull now reads the conversation around the caret and, when the
 * user allows it, photographs the window — and the person doing the talking
 * finds out while they can still let go of the key, not afterwards in a
 * settings pane. Silence here would be the whole difference between a tool that
 * is transparent and one that merely has a privacy policy.
 *
 * Nothing read, no chip: there is no news in "Mull looked at nothing".
 */
/**
 * Which key is being held, said out loud while the user is still holding it.
 *
 * Only for Fn. ⌥Space is the default and needs no announcement — but Fn means
 * the words are about to be sent somewhere and acted on, and the moment to
 * learn that is *before* letting go, not after. It also makes a mis-press
 * visible: Fn is right next to a lot of other keys.
 */
function askChip(intent: HotkeyIntent): HudChip | null {
  return intent === 'instruct' ? { kind: 'cmd', id: 'ask', label: 'asking Mull', hint: 'Fn' } : null
}

function readingChip(snapshot: FocusSnapshot): HudChip | null {
  const context = snapshot.context
  if (!context) return null
  if (context.chars === 0 && !context.image) return null
  return {
    kind: 'mem',
    id: 'reading',
    label: context.image ? 'reading this window + screenshot' : 'reading this window'
  }
}
