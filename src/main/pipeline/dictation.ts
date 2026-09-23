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
import { MAX_PROMPT_CHARS } from '../asr/whisper-cli'
import { buildAsrPrompt } from './asr-prompt'
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
import { wantsSend, type Route } from './router'
import type { HotkeyIntent } from '../services/hotkey'
import type { RecentTurn, TurnOutcome } from '../services/turns'
import type { JournalStore } from '../store/journal'
import type { CaptureStore } from '../store/captures'
import type { JournalDraft, JournalEntry } from '@shared/types'
import { kb, Trace } from '../trace'

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
 * a proposal on screen; the loop starts inside the lane — on the user's press,
 * or on `settings.autoRun` — where this file cannot see it either way.
 */
export interface NavigateLaneLike {
  propose(request: {
    goal: string
    transcript: string
    app: { bundleId: string; name: string } | null
    context?: ScreenContext | null
    routedBy?: string
    /** Whisper was not sure it heard this; the lane will not auto-run it. */
    unsure?: boolean
    /** What was tried just before this, so a second attempt can vary. */
    recent?: RecentTurn[] | null
  }): Promise<void>
}

/** Answering a question about the window in front of you. Writes nothing. */
export interface AskLaneLike {
  run(request: {
    question: string
    transcript: string
    app: { bundleId: string; name: string } | null
    context?: ScreenContext | null
    routedBy?: string
    /** What was asked just before this, so a follow-up has its subject. */
    recent?: RecentTurn[] | null
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
  /**
   * Where questions go. Absent = they fall through to the insertion path.
   *
   * Narrowed to one method for the same reason the other two are, though here
   * the narrowing is almost redundant: the lane has no target and nothing that
   * writes. That is the point of it.
   */
  ask?: AskLaneLike
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
  /**
   * The last few things the user said. Opened when an utterance is routed and
   * closed when it ends, so the classifier can read the next one as a follow-up
   * — see `services/turns.ts`.
   */
  turns?: {
    open(turn: { said: string; route: string; app: string | null; goal?: string | null }): void
    close(outcome: string | null, extra?: TurnOutcome): void
    /** Read once per utterance, *before* this one is opened. See `handle`. */
    recent(): RecentTurn[]
  }
}

/** Below this peak the recording is room tone; don't pay for ASR. */
const SILENCE_PEAK = 0.006

/**
 * Below this mean per-token probability, say so rather than act as if sure.
 *
 * Whisper is not calibrated, so this is a relative signal: it separates "heard
 * it" from "guessed", which is the distinction that matters when a transcript
 * is about to become a goal string for an agent rather than text on screen.
 * 0.6 is a starting point, not a measurement — every utterance now writes its
 * confidence to bench.jsonl precisely so this number can be replaced by one
 * derived from real holds.
 *
 * What crossing it does is deliberately small. Every Fn route already ends on
 * a card the user has to press — navigate and the agent loop on Run, an edit
 * on Apply, a send on its own commit — so the approval step this would
 * otherwise add already exists. What was missing was any reason to look
 * closely at the card, and that is what the notice supplies. ⌥Space types it
 * either way: that lane never waits and never asks.
 */
const LOW_CONFIDENCE = 0.6

/**
 * One utterance, as the half of the loop that deals in words sees it.
 *
 * `text` is the only field a correction changes. The rest describes the
 * recording — how long the key was held, how long transcription took, which
 * model answered — and is carried unchanged into a re-run, because a corrected
 * name does not make it a different utterance. Filing the second pass under a
 * fresh set of zeroes would put a lie in the bench.
 */
interface Utterance {
  text: string
  captureMs: number
  audioSeconds: number
  asrMs: number
  cleanupMs: number
  removedFillers: string[]
  model: string
  /**
   * Mean per-token probability, or null when the provider cannot say. Carried
   * here rather than read at the bench-record site because the two are on
   * opposite sides of `route`, and a re-run after a corrected name is the same
   * hold — it reports the confidence of the audio, not of the fixed words.
   */
  confidence: number | null
  keyUpAt: number
}

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
  /**
   * The harvest, once it has landed — read, never awaited, by the ASR path.
   *
   * `focusPromise` cannot be awaited before transcribing: that would put the
   * accessibility read on the critical path of ⌥Space, which is the one thing
   * this file promises never to do. Reading whatever has arrived by then costs
   * nothing and is almost always everything, because the harvest starts on
   * key-down and ASR starts on key-up.
   */
  private lastFocus: FocusSnapshot | null = null
  /** Which key started this utterance. See `begin`. */
  private intent: HotkeyIntent = 'dictate'
  /** One per utterance, from key-down. Every step of this loop reports to it. */
  private trace: Trace = new Trace()
  /**
   * The last utterance to get as far as having words.
   *
   * Kept past the end of the run because the panel can still be showing a card
   * built from it, and the user can still tell Mull it misheard — see `rerun`.
   */
  private said: Utterance | null = null
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

  /**
   * The trace for the utterance in flight.
   *
   * Handed out so collaborators that run *inside* one — the classifier, the
   * lanes — file their steps under the same id and the same clock. Otherwise
   * the slowest part of the pipeline reports its timing somewhere the rest of
   * the story cannot be read beside it.
   */
  currentTrace(): Trace {
    return this.trace
  }

  /**
   * Update the panel — and never let a working phase arrive without a line.
   *
   * The working line is set explicitly at each step, which means any path that
   * forgets one puts the HUD back where it started: the word THINKING, alone,
   * unchanging, for as long as the work takes. That is indistinguishable from a
   * hang, and it is the exact complaint this was built to answer — so "did
   * somebody remember" is the wrong thing for it to depend on.
   *
   * Entering a working phase therefore stamps a default line and a clock unless
   * the same patch supplies one. The lines every real step sets are better than
   * "working"; this only guarantees there is always *something*, and always a
   * second count once the wait is long enough to notice.
   */
  private setState(patch: Partial<HudState>): void {
    const entering = patch.phase !== undefined && patch.phase !== this.state.phase
    const working = patch.phase === 'thinking' || patch.phase === 'inserting'
    const next = { ...this.state, ...patch }
    if (entering && working && patch.stage === undefined && next.stage === null) {
      next.stage = 'working'
      next.stageAt = this.now()
    }
    // Leaving one clears it, so a stale line cannot outlive the work.
    if (entering && !working && patch.stage === undefined) {
      next.stage = null
      next.stageAt = null
    }
    next.chips = withAppChip(next.chips, next.app)
    this.state = next
    this.deps.onState(this.state)
  }

  private toIdle(notice: string | null = null): void {
    this.setState({
      phase: 'idle',
      transcript: '',
      partial: false,
      app: null,
      notice,
      chips: [],
      stage: null,
      stageAt: null
    })
  }

  /**
   * Say what is happening, in three or four words, and start its clock.
   *
   * Paired with the trace deliberately: the log line and the panel line are the
   * same fact told to two audiences, so they cannot drift into disagreeing
   * about what Mull is doing.
   */
  private stage(text: string | null): void {
    this.setState({ stage: text, stageAt: text ? this.now() : null })
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
    // Cleared, not left to be overwritten: this utterance's harvest may not
    // land before ASR reads it, and biasing whisper toward the *previous*
    // window's channel names is worse than biasing it toward nothing.
    this.lastFocus = null
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer)
      this.lingerTimer = null
    }

    this.phase = 'capturing'
    this.chunks = []
    this.startedAt = this.now()
    this.trace = new Trace({ log: this.log, now: this.now })
    this.trace.step('hold.begin', { key: intent === 'instruct' ? 'Fn' : '⌥Space' })
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
      this.lastFocus = snapshot
      this.trace.step('focus.read', {
        app: snapshot.app?.name,
        field: snapshot.field?.text.length ?? 0,
        selection: snapshot.selection?.text.length ?? 0,
        editable: snapshot.field?.editable
      })
      if (snapshot.context) {
        this.trace.step('context.read', {
          blocks: snapshot.context.blocks.length,
          chars: snapshot.context.chars,
          truncated: snapshot.context.truncated || undefined,
          image: kb(snapshot.context.image?.bytes) ?? snapshot.context.imageReason,
          harvestMs: snapshot.context.harvestMs
        })
      }
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
    this.trace.step('hold.end', { heldMs: captureMs })
    this.stage('transcribing')
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
    this.trace.step('asr.start', { seconds: audioSeconds, provider: this.deps.asr.name })

    this.setState({ phase: 'thinking', partial: false })
    this.stage('transcribing')

    try {
      const asrStart = this.now()
      // Whatever the parallel harvest has produced by now — the app being
      // spoken into, the channel names in the window. Never awaited; see
      // `lastFocus`.
      const prompt = buildAsrPrompt(this.lastFocus, MAX_PROMPT_CHARS)
      const result = await this.deps.asr.transcribe(pcm, this.sampleRate, {
        prompt: prompt || undefined
      })
      const asrMs = this.now() - asrStart
      const unsure = result.confidence !== null && result.confidence < LOW_CONFIDENCE

      const cleanStart = this.now()
      const { text, removedFillers } = cleanTranscript(result.text)
      const cleanupMs = this.now() - cleanStart

      if (!text) return discard('empty-transcript', null)
      // The user's own words, which are theirs — and the only way to make sense
      // of the routing line that follows. Nothing else quoted here is.
      this.trace.step('asr.done', {
        ms: asrMs,
        chars: text.length,
        fillers: removedFillers || undefined,
        confidence: result.confidence ?? undefined,
        unsure: unsure || undefined,
        promptChars: prompt.length || undefined,
        said: text
      })
      this.setState({ transcript: text })
      if (unsure) {
        this.log('warn', `dictation: low confidence transcript (${result.confidence?.toFixed(2)})`)
        // Said plainly rather than hedged, and shown on the same HUD the
        // approval card is about to occupy, so the doubt is in front of the
        // user at the moment they decide whether to press Run.
        this.setState({ notice: 'Not sure Mull heard that right — check before running.' })
      }
      // Only the instruct key waits on anything past this point; ⌥Space is
      // already on its way to the caret, and naming a stage it will leave in
      // forty milliseconds is a flicker, not information.
      if (this.intent === 'instruct') this.stage('working out what you meant')

      // Everything past this point is decided by the *words*, not by the audio
      // — which is what makes it re-enterable when the user corrects a name
      // whisper heard wrong. See `rerun`.
      const said: Utterance = {
        text,
        captureMs,
        audioSeconds,
        asrMs,
        cleanupMs,
        removedFillers,
        model: result.model,
        confidence: result.confidence,
        keyUpAt
      }
      this.said = said
      await this.route(text, said)
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
   * The half of an utterance that is about words rather than about audio.
   *
   * Split out so it can be entered twice. Whisper mishears names — a person's,
   * a project's, a channel's — and until now the only remedy was to say the
   * whole thing again, because by the time the panel showed you what it heard,
   * that text had already been routed and the card built from it. Correcting
   * the transcript on the panel re-enters here with the fixed words and the
   * same `meta`, so the second pass is the first pass with one thing changed.
   *
   * It deliberately does *not* re-read the window. The focus snapshot, the
   * selection and the screen context were taken while the user was speaking,
   * and an edit is a promise about the text they were looking at then — not
   * about whatever is in front of them once they have finished typing into
   * Mull's own panel.
   */
  private async route(text: string, meta: Utterance): Promise<void> {
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
    if (routed) {
      this.trace.step('route', {
        kind: routed.route.kind,
        by: routed.by,
        classifyMs: routed.classifyMs ?? undefined,
        fellBackTo: routed.fallbackReason ?? undefined
      })
    } else {
      // ⌥Space, or no router at all. Neither asks anything; both type.
      this.trace.step('route', { kind: 'dictate', by: 'key' })
    }
    /**
     * Remember what this was, before it has happened.
     *
     * Opened here rather than on completion because a run can take half a
     * minute, and the user may well say the next thing before it lands — a
     * memory that only recorded finished work would be missing precisely the
     * turn they are following up on. `close` fills in the outcome when it
     * arrives; see `announce` and the applied branch below.
     */
    /**
     * The conversation as it stood *before* this sentence joined it.
     *
     * Read here rather than inside each lane, and deliberately one line above
     * `open`: a lane shown the turn it is currently serving would read "said
     * this → navigate → still going" about itself, which is a fact it already
     * has and a line it would have to be told to ignore.
     */
    const before = this.deps.turns?.recent() ?? null

    this.deps.turns?.open({
      said: text,
      route: routed?.route.kind ?? 'dictate',
      app: this.state.app?.name ?? null,
      // The sentence that was actually acted on, which is rarely the sentence
      // that was spoken: "and what about Priya" leaves the classifier as "open
      // the conversation with Priya and find what she said about the terms
      // doc". The *next* follow-up needs the subject, and this is the only
      // place it is ever written down.
      goal: goalOf(routed?.route)
    })
    let hint: string | null = null

    // A bare send writes nothing at all, so it never reaches the insertion
    // path below — the words were a command, not a message.
    if (routed?.route.kind === 'send' && this.deps.sculpt) {
      this.phase = 'idle'
      this.trace.step('lane.send', { chars: routed.snapshot.field?.text.length ?? 0 })
      this.stage('reading the box')
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
      this.trace.step('lane.navigate', { goal: routed.route.goal })
      this.stage('planning')
      await this.deps.navigate.propose({
        goal: routed.route.goal,
        transcript: text,
        app: this.state.app ?? routed.snapshot.app,
        context: routed.snapshot.context,
        routedBy: routed.by,
        // Carried rather than re-derived: the doubt belongs to the recording,
        // and this is the one lane where it changes what happens rather than
        // only what the HUD says. See `LOW_CONFIDENCE`.
        unsure: meta.confidence !== null && meta.confidence < LOW_CONFIDENCE,
        recent: before
      })
      return
    }

    // A question about the window in front of them. Nothing is written and
    // nothing can be: the lane's card has no Apply, because "summarize my
    // tasks" is a request to know something, not a request for text. See
    // `pipeline/ask.ts` for what this route cost before it existed.
    if (routed?.route.kind === 'ask' && this.deps.ask) {
      this.phase = 'idle'
      this.trace.step('lane.ask', {
        question: routed.route.question,
        screen: routed.snapshot.context?.chars ?? 0
      })
      this.stage('reading what it saw')
      await this.deps.ask.run({
        question: routed.route.question,
        transcript: text,
        app: this.state.app ?? routed.snapshot.app,
        context: routed.snapshot.context,
        routedBy: routed.by,
        recent: before
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
        this.stage(routed.route.kind === 'compose' ? 'writing a draft' : 'editing')
        this.trace.step(`lane.${routed.route.kind}`, {
          target: target.target.kind,
          before: target.target.text.length,
          send: wish.send || undefined
        })
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
      // Every strategy the chain tried and why each refused — the one case
      // where the interesting information is the list of failures, not the
      // outcome.
      this.trace.fail('insert.failed', {
        app: target?.name,
        reason: inserted.reason,
        tried: inserted.attempts.map((a) => `${a.strategy}:${a.reason ?? 'ok'}`).join(',')
      })
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
        model: meta.model,
        chars: text.length,
        app: this.state.app?.bundleId ?? null,
        outcome: 'failed',
        reason: inserted.reason ?? 'unknown',
        strategy: null,
        attempts: inserted.attempts.map((a) => `${a.strategy}:${a.reason ?? 'ok'}`).join(','),
        captureMs: meta.captureMs,
        audioSeconds: meta.audioSeconds,
        asrMs: meta.asrMs,
        cleanupMs: meta.cleanupMs,
        insertMs,
        totalMs: this.now() - meta.keyUpAt
      })
      return
    }

    // Not cleared here: the phase is still `inserting` at this point, and
    // blanking the line before the phase leaves would emit exactly the state
    // this whole mechanism exists to prevent — a working phase with nothing
    // to say. Leaving `inserting` clears it (see `setState`).
    this.trace.step('insert.done', {
      strategy: inserted.strategyUsed,
      verified: inserted.verified,
      chars: text.length,
      ms: insertMs
    })

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

    // Dictation does not go through `announce`, so it closes its own turn.
    // The words themselves are the outcome — there is nothing else to say
    // about typing, and "I said this and it was typed" is what a follow-up
    // needs to know.
    this.deps.turns?.close(`typed: ${text}`)
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
      removedFillers: meta.removedFillers,
      asrMs: meta.asrMs,
      insertMs,
      strategy: inserted.strategyUsed,
      verified: inserted.verified
    })

    this.deps.bench.record({
      kind: 'dictation',
      provider: this.deps.asr.name,
      model: meta.model,
      chars: text.length,
      app: this.state.app?.bundleId ?? null,
      outcome: 'applied',
      confidence: meta.confidence,
      routedBy: routed?.by,
      classifyMs: routed?.classifyMs ?? null,
      strategy: inserted.strategyUsed,
      attempts: inserted.attempts.map((a) => `${a.strategy}:${a.reason ?? 'ok'}`).join(','),
      captureMs: meta.captureMs,
      audioSeconds: meta.audioSeconds,
      asrMs: meta.asrMs,
      cleanupMs: meta.cleanupMs,
      insertMs,
      totalMs: this.now() - meta.keyUpAt
    })

    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null
      if (this.phase === 'idle') this.toIdle()
    }, this.deps.appliedLingerMs ?? 1_400)
  }

  /**
   * Run it again, from words the user corrected on the panel.
   *
   * The audio is not touched and ASR is not asked twice: the recording said
   * what it said, and the user is overruling it. Everything the bench and the
   * journal need about the utterance — how long it ran, how long transcription
   * took, which model — is the original utterance's, because it is the same
   * utterance; only the reading of it has changed.
   *
   * Refused unless the loop is at rest. A correction arrives from a click on a
   * card, and a card only exists between utterances — but the panel is not the
   * only thing that can start one, and a re-run that raced a live hold would be
   * two pipelines writing the same HUD.
   */
  async rerun(text: string): Promise<void> {
    const said = this.said
    const words = text.trim()
    if (!said || !words || this.phase !== 'idle') return
    if (words === said.text) return

    this.phase = 'processing'
    // A new trace, forked from the original so the two readings of one
    // utterance can be read beside each other rather than hunted for
    // separately.
    this.trace = this.trace.fork()
    this.trace.step('asr.corrected', { was: said.text, said: words })
    this.said = { ...said, text: words }
    this.setState({
      phase: 'thinking',
      transcript: words,
      partial: false,
      notice: null,
      card: null
    })
    this.stage(this.intent === 'instruct' ? 'working out what you meant' : 'writing')

    try {
      await this.route(words, this.said)
    } catch (err) {
      this.phase = 'idle'
      const message = err instanceof Error ? err.message : String(err)
      this.log('error', 'dictation failed after correction', message)
      this.setState({ phase: 'error', partial: false, notice: `Couldn’t finish: ${message}` })
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

    // The hold's own `frontmostApp` write is guarded on still capturing, so a
    // short utterance outruns it and leaves `state.app` null — which is
    // precisely the utterance where the user just switched apps and most wants
    // to see that Mull noticed. The snapshot has been waited for by now and
    // carries the app everything below is about to route on, so the panel may
    // as well say so.
    const app = this.state.app ?? snapshot.app
    if (!this.state.app && app) this.setState({ app })

    const decision = await this.deps.intent.decide({
      transcript: text,
      app,
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
    lastAction?: HudState['lastAction'],
    /**
     * What the lane did on its way here, for the memory rather than the panel.
     *
     * A fourth argument rather than three more fields on `HudLastAction`,
     * because that shape is the renderer's contract and none of this is drawn:
     * the route a run took and the goal it was actually given are evidence for
     * the *next* utterance, and the panel has no business carrying them to a
     * window that will never show them.
     */
    turn?: TurnOutcome
  ): boolean {
    if (this.phase !== 'idle') return false
    // The single funnel every lane's ending passes through, which is what makes
    // it the right place to close the turn: sculpt, ask, navigate and the agent
    // all arrive here, and none of them has to know that a memory exists.
    this.deps.turns?.close(lastAction?.result ?? notice, turn)
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
 * Which app Mull believes it is acting on, on every state that has one.
 *
 * Added centrally rather than at the call sites, and that is the whole design:
 * every chip write in this codebase is a **whole-array replace** — five of them
 * across this file and `sculpt.ts`, none of which merges. A chip appended at
 * any one of them survives until the next lane runs and then vanishes, which
 * for a chip whose job is continuous reassurance is worse than not having it.
 * `setState` is the single writer of base HUD state, so this is the one place
 * it cannot be dropped from.
 *
 * ### Why it earns the space
 *
 * The app was being reported wrongly — `NSWorkspace.frontmostApplication` is
 * stale inside the sidecar, so Mull would read Slack while the user was in
 * Chrome — and nothing on screen would have told you. The strategy, the send
 * chord, the journal row and ⌥Z all key off this value; showing it makes the
 * one input everything else depends on visible before the user commits to
 * anything, instead of afterwards in a journal row.
 *
 * Prepended, because it is the subject of the sentence the other chips finish:
 * *Slack · Reply · reading the window*.
 *
 * `id` is `app`, distinct from the `target` chip `sculpt.ts` puts on cards —
 * they can be on screen together and they are not the same claim. One says
 * where Mull is; the other says where this particular edit will land.
 */
function withAppChip(chips: HudChip[], app: HudState['app']): HudChip[] {
  if (!app?.name) return chips
  if (chips.some((chip) => chip.id === 'app')) return chips
  return [{ kind: 'dict', id: 'app', label: app.name }, ...chips]
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

/**
 * The instruction a route carries, whatever that route calls it.
 *
 * Four lanes name the same thing four ways — `goal`, `question`, `instruction`
 * — and the memory wants one field. `dictate` and `send` have none: the words
 * *are* the message in one case and a key press in the other, so there is
 * nothing an expansion could add.
 */
function goalOf(route: Route | undefined): string | null {
  if (!route) return null
  if (route.kind === 'navigate') return route.goal
  if (route.kind === 'ask') return route.question
  if (route.kind === 'edit' || route.kind === 'compose') return route.instruction
  return null
}
