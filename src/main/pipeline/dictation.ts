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

/**
 * The M1 loop: hold key -> capture -> transcribe -> clean -> insert.
 *
 * Two invariants from docs/PLAN.md are enforced here, not by convention:
 *
 *  1. Dictation never waits on an engine. Nothing in this path makes a network
 *     call or consults an LLM; the only slow step is local ASR.
 *  2. Insertion is hard-blocked while macOS secure input is active. It is
 *     checked twice — when capture starts (so we can tell the user early) and
 *     again immediately before inserting, because focus can move to a password
 *     field mid-utterance.
 *
 * Everything is injected, so the whole loop runs in tests against fakes.
 */

export interface DictationDeps {
  sidecar: SidecarApi
  asr: AsrProvider
  capture: { start(): void; stop(): void }
  bench: Bench
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
    this.setState({ phase: 'idle', transcript: '', partial: false, app: null, notice })
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

  begin(): void {
    if (this.phase !== 'idle') return
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer)
      this.lingerTimer = null
    }

    this.phase = 'capturing'
    this.chunks = []
    this.startedAt = this.now()
    this.deps.capture.start()
    this.setState({ phase: 'listening', transcript: '', partial: true, notice: null })

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
        this.setState({
          phase: 'blocked',
          notice: 'Secure input turned on while Mull was listening — nothing was inserted.'
        })
        return
      }

      this.setState({ phase: 'inserting' })
      const insertStart = this.now()
      const inserted = await this.deps.sidecar.insertText({ text, strategy: 'paste' })
      const insertMs = this.now() - insertStart

      this.phase = 'idle'

      if (!inserted.inserted) {
        const notice = describeInsertFailure(inserted.reason)
        this.setState({ phase: 'error', notice, partial: false })
        this.deps.bench.record({
          kind: 'dictation',
          provider: this.deps.asr.name,
          model: result.model,
          chars: text.length,
          app: this.state.app?.bundleId ?? null,
          outcome: 'failed',
          reason: inserted.reason ?? 'unknown',
          captureMs,
          audioSeconds,
          asrMs,
          cleanupMs,
          insertMs,
          totalMs: this.now() - keyUpAt
        })
        return
      }

      const appName = this.state.app?.name ?? 'this app'
      this.setState({
        phase: 'applied',
        partial: false,
        notice: null,
        lastAction: {
          summary: `Dictation · ${appName} · “${summarise(text)}”`,
          at: this.now(),
          chars: text.length
        }
      })
      this.log('info', 'dictation applied', {
        chars: text.length,
        removedFillers,
        asrMs,
        insertMs
      })

      this.deps.bench.record({
        kind: 'dictation',
        provider: this.deps.asr.name,
        model: result.model,
        chars: text.length,
        app: this.state.app?.bundleId ?? null,
        outcome: 'applied',
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

  dispose(): void {
    this.clearTimers()
    if (this.lingerTimer) clearTimeout(this.lingerTimer)
  }
}

/** Turn a sidecar reason code into something a human can act on. */
export function describeInsertFailure(reason: string | null): string {
  switch (reason) {
    case 'secure-input':
      return 'Secure input is on — Mull paused. Leave the password field and try again.'
    case 'no-accessibility':
      return 'Mull needs Accessibility access to place text. Grant it in System Settings → Privacy & Security → Accessibility, then restart Mull.'
    case 'no-focused-element':
      return 'No text field is focused — click where the text should go, then try again.'
    default:
      return `Couldn’t insert the text${reason ? ` (${reason})` : ''}.`
  }
}
