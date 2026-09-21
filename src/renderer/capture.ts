import { CAPTURE_SAMPLE_RATE } from '@shared/ipc'

/**
 * Hidden microphone capture window.
 *
 * Electron's main process has no getUserMedia and no AudioWorklet, so the mic
 * lives in an invisible renderer that streams Float32 PCM back over IPC. The
 * stream is opened once on first use and kept warm: re-acquiring a device on
 * every key-press costs 150-400 ms, which is most of the key-up -> transcript
 * budget. Tracks are disabled (not stopped) between utterances so macOS drops
 * the orange mic indicator while the device stays open.
 */

/**
 * Why the WebRTC processing chain is mostly off.
 *
 * Chromium's `noiseSuppression` and `autoGainControl` are tuned to make speech
 * intelligible to a human over a phone line, which is not the same objective as
 * feeding an acoustic model. Noise suppression is spectral and attacks the
 * low-energy onset of a word — exactly the part whisper's autoregressive
 * decoder conditions the rest of the sentence on. AGC makes it worse here in a
 * way that is specific to push-to-talk: between utterances the tracks are left
 * `enabled = false`, so the gain controller spends that time adapting to
 * digital silence and comes back with its gain wound up, and the first moments
 * after the key goes down arrive pumped.
 *
 * `echoCancellation` stays on: it costs the onset nothing and it is what stops
 * Mull transcribing whatever is playing through the speakers.
 *
 * This is the one change in this area that has not been measured against real
 * room audio — `say`-synthesised speech cannot exercise a noise suppressor. If
 * a noisy room turns out to want suppression back, flip these two and re-run
 * `scripts/probe-asr.ts` over a corpus captured with MULL_ASR_KEEP_AUDIO; the
 * probe exists to settle exactly this.
 */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false
}

const bridge = window.mull as typeof window.mull | undefined
if (!bridge) {
  throw new Error('capture: preload bridge missing — this page only works inside Mull')
}
const api = bridge.capture

let context: AudioContext | null = null
let source: MediaStreamAudioSourceNode | null = null
let node: AudioWorkletNode | null = null
let stream: MediaStream | null = null
let recording = false

function setTracksEnabled(enabled: boolean): void {
  stream?.getAudioTracks().forEach((t) => {
    t.enabled = enabled
  })
}

async function ensureGraph(): Promise<void> {
  if (context && node && stream) return

  stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS })
  // Built idle. `start()` is the only thing that opens the mic, so warming the
  // graph ahead of time cannot leave the recording indicator lit.
  setTracksEnabled(false)

  context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE })
  await context.audioWorklet.addModule('./pcm-worklet.js')

  source = context.createMediaStreamSource(stream)
  node = new AudioWorkletNode(context, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 0 })
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (!recording) return
    api.chunk(event.data)
  }
  source.connect(node)
}

async function start(): Promise<void> {
  try {
    await ensureGraph()
    if (context?.state === 'suspended') await context.resume()
    setTracksEnabled(true)
    recording = true
    api.ready({ ok: true, sampleRate: context?.sampleRate ?? 0 })
  } catch (err) {
    recording = false
    const message = err instanceof Error ? err.message : String(err)
    api.ready({ ok: false, sampleRate: 0, error: message })
    api.error(message)
  }
}

function stop(): void {
  recording = false
  // Disable rather than stop: keeps the device warm for the next utterance
  // while releasing the recording indicator.
  setTracksEnabled(false)
}

api.onStart(() => {
  void start()
})
api.onStop(() => {
  stop()
})

/**
 * Build the graph before the first key-press, not during it.
 *
 * `start()` awaits `ensureGraph()` and only then sets `recording = true`, and
 * every chunk arriving before that flag is dropped — so on the first utterance
 * after launch the whole getUserMedia round trip came out of the front of the
 * user's sentence. bench.jsonl caught it: one row holds `captureMs: 4080`
 * against `audioSeconds: 3.76`, i.e. 320 ms of speech that was spoken and
 * never reached whisper, while neighbouring rows match to within a chunk. A
 * missing onset is not a missing word — whisper conditions the rest of the
 * sentence on it.
 *
 * Gated on permission already being granted so that warming never raises the
 * macOS microphone prompt out of nowhere at launch. On first run the prompt
 * belongs to onboarding, and this simply does nothing until then.
 */
async function warm(): Promise<void> {
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName
    })
    if (status.state !== 'granted') return
    await ensureGraph()
  } catch {
    /* warming is an optimisation; start() still builds the graph on demand */
  }
}

void warm()
