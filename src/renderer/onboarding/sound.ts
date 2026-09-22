/**
 * Onboarding sound — a small synthesised instrument.
 *
 * There are no audio files here. Every cue is built at play time from
 * oscillators and a short filtered-noise transient, which keeps binaries out of
 * the repo, keeps the whole thing working offline, and keeps faith with what
 * page 1 promises: nothing in this app reaches the network, not even a sound.
 *
 * The palette is wooden rather than electronic — sine and triangle voices, a
 * low-passed tick for the attack, short decays, and a D-pentatonic set so that
 * any two cues landing together still agree with each other. A pencil on paper,
 * not a notification.
 *
 * One rule here is functional rather than aesthetic. Page 5 asks the user to
 * hold ⌥Space and speak; anything playing at that moment goes into the
 * microphone and out again in the transcript. The instrument therefore
 * suppresses itself whenever the HUD is listening — see `setSuppressed`.
 */

export type Cue =
  | 'tap'
  | 'hover'
  | 'advance'
  | 'back'
  | 'grant'
  | 'ready'
  | 'apply'
  | 'cancel'
  | 'finish'

/** Preference key. Sound is on by default; the footer toggle writes here. */
const STORAGE_KEY = 'mull.onboarding.sound'

/* D pentatonic. Every cue draws from this set, so overlaps stay consonant. */
const D4 = 293.66
const E4 = 329.63
const FS4 = 369.99
const A4 = 440.0
const B4 = 493.88
const D5 = 587.33
const FS5 = 739.99
const A5 = 880.0

interface Voice {
  /** Hz. */
  freq: number
  /** Seconds from the cue's start. */
  at: number
  /** Seconds. */
  dur: number
  /** Linear peak gain, pre-master. */
  gain: number
  type?: OscillatorType
}

/**
 * Each cue is a tiny score. Times are relative to the moment `play` is called,
 * so a cue can be an arpeggio without any scheduling logic at the call site.
 */
const SCORES: Record<Cue, Voice[]> = {
  /* A fingertip on a key. One note, almost no tail. */
  tap: [{ freq: D5, at: 0, dur: 0.075, gain: 0.16, type: 'triangle' }],

  /* Barely there: the sound of a control noticing the cursor. */
  hover: [{ freq: A5, at: 0, dur: 0.045, gain: 0.05, type: 'sine' }],

  /* Forward: a rising fourth. The page turns. */
  advance: [
    { freq: A4, at: 0, dur: 0.16, gain: 0.17, type: 'triangle' },
    { freq: D5, at: 0.055, dur: 0.26, gain: 0.15, type: 'sine' }
  ],

  /* Back: the same interval inverted, quieter — a step retraced. */
  back: [
    { freq: D5, at: 0, dur: 0.14, gain: 0.13, type: 'triangle' },
    { freq: A4, at: 0.055, dur: 0.24, gain: 0.12, type: 'sine' }
  ],

  /* A permission lands: warm major third, the most agreeable thing here. */
  grant: [
    { freq: D5, at: 0, dur: 0.2, gain: 0.15, type: 'sine' },
    { freq: FS5, at: 0.06, dur: 0.34, gain: 0.13, type: 'sine' }
  ],

  /* The model is on disk: a full triad, unhurried. */
  ready: [
    { freq: D5, at: 0, dur: 0.22, gain: 0.14, type: 'sine' },
    { freq: FS5, at: 0.075, dur: 0.26, gain: 0.12, type: 'sine' },
    { freq: A5, at: 0.15, dur: 0.42, gain: 0.11, type: 'sine' }
  ],

  /* Apply: a soft thunk with a fifth over it. Something was committed. */
  apply: [
    { freq: D4, at: 0, dur: 0.11, gain: 0.2, type: 'triangle' },
    { freq: A4, at: 0.045, dur: 0.3, gain: 0.13, type: 'sine' }
  ],

  /* Cancel: one low note that stops. Nothing changed, and it does not linger. */
  cancel: [{ freq: D4, at: 0, dur: 0.16, gain: 0.13, type: 'sine' }],

  /* Finish: the pentatonic walked up. The only cue allowed to feel like an event. */
  finish: [
    { freq: D4, at: 0, dur: 0.3, gain: 0.15, type: 'sine' },
    { freq: FS4, at: 0.08, dur: 0.3, gain: 0.13, type: 'sine' },
    { freq: A4, at: 0.16, dur: 0.34, gain: 0.13, type: 'sine' },
    { freq: B4, at: 0.24, dur: 0.38, gain: 0.12, type: 'sine' },
    { freq: D5, at: 0.32, dur: 0.5, gain: 0.12, type: 'sine' },
    { freq: FS5, at: 0.4, dur: 0.72, gain: 0.1, type: 'sine' }
  ]
}

/** Cues with a noise transient — the ones meant to feel struck rather than sung. */
const PERCUSSIVE: ReadonlySet<Cue> = new Set<Cue>(['tap', 'advance', 'back', 'apply'])

let ctx: AudioContext | null = null
let master: GainNode | null = null
let air: DelayNode | null = null
let noiseBuffer: AudioBuffer | null = null
let suppressed = false
let muted = !readStoredPreference()

function readStoredPreference(): boolean {
  try {
    /* Absent key means on: sound is the default, silence is the choice. */
    return window.localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

/**
 * Build the graph on first use. Browsers (and Electron's renderer) refuse to
 * start an AudioContext outside a user gesture, so this is called from the
 * first real interaction as well as from mount — whichever arrives first wins,
 * and the rest are no-ops.
 */
function ensure(): AudioContext | null {
  if (ctx) {
    /* Suspended contexts come back after a gesture; ask every time, it is cheap. */
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }

  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null

  try {
    ctx = new Ctor()
  } catch {
    return null
  }

  master = ctx.createGain()
  master.gain.value = 0.9
  master.connect(ctx.destination)

  /* A single short delay tap. Not a reverb — just enough room that the cues
     sound like they happen on a desk rather than inside the speaker. */
  air = ctx.createDelay(0.5)
  air.delayTime.value = 0.085
  const airGain = ctx.createGain()
  airGain.gain.value = 0.14
  const airTone = ctx.createBiquadFilter()
  airTone.type = 'lowpass'
  airTone.frequency.value = 2200
  air.connect(airTone)
  airTone.connect(airGain)
  airGain.connect(master)

  /* 200ms of noise, reused by every percussive transient. */
  const frames = Math.floor(ctx.sampleRate * 0.2)
  noiseBuffer = ctx.createBuffer(1, frames, ctx.sampleRate)
  const data = noiseBuffer.getChannelData(0)
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1

  return ctx
}

function playVoice(context: AudioContext, voice: Voice, startAt: number): void {
  const osc = context.createOscillator()
  const gain = context.createGain()
  const tone = context.createBiquadFilter()

  osc.type = voice.type ?? 'sine'
  osc.frequency.value = voice.freq

  /* Rolling the top off is most of what separates "wooden" from "beep". */
  tone.type = 'lowpass'
  tone.frequency.value = Math.min(voice.freq * 6, 7000)
  tone.Q.value = 0.6

  const t0 = startAt + voice.at
  const end = t0 + voice.dur

  /* Short attack, exponential decay. Never ramp to exactly 0 — the Web Audio
     spec rejects it and the node silently stops scheduling. */
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(voice.gain, t0 + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, end)

  osc.connect(tone)
  tone.connect(gain)
  if (master) gain.connect(master)
  if (air) gain.connect(air)

  osc.start(t0)
  osc.stop(end + 0.02)
}

function playTransient(context: AudioContext, startAt: number, level: number): void {
  if (!noiseBuffer) return
  const src = context.createBufferSource()
  const gain = context.createGain()
  const tone = context.createBiquadFilter()

  src.buffer = noiseBuffer
  tone.type = 'bandpass'
  tone.frequency.value = 1900
  tone.Q.value = 0.9

  gain.gain.setValueAtTime(level, startAt)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.035)

  src.connect(tone)
  tone.connect(gain)
  if (master) gain.connect(master)

  src.start(startAt)
  src.stop(startAt + 0.05)
}

/** Play a cue. Silent when muted, suppressed, or when audio is unavailable. */
export function play(cue: Cue): void {
  if (muted || suppressed) return
  const context = ensure()
  if (!context || context.state !== 'running') return

  const score = SCORES[cue]
  if (!score) return

  const now = context.currentTime + 0.001
  if (PERCUSSIVE.has(cue)) playTransient(context, now, cue === 'apply' ? 0.06 : 0.04)
  for (const voice of score) playVoice(context, voice, now)
}

/**
 * Hold the instrument quiet while the microphone is open. Page 5 turns this on
 * for the whole time the HUD is listening, so a UI cue can never end up inside
 * the user's own transcript.
 */
export function setSuppressed(next: boolean): void {
  suppressed = next
}

export function isMuted(): boolean {
  return muted
}

export function setMuted(next: boolean): void {
  muted = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? 'off' : 'on')
  } catch {
    /* A locked-down storage is not a reason to fail; the session still works. */
  }
  if (!next) ensure()
}

/** Called from the first user gesture so the context can legally start. */
export function unlock(): void {
  ensure()
}
