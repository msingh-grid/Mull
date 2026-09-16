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

async function ensureGraph(): Promise<void> {
  if (context && node && stream) return

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

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
    stream?.getAudioTracks().forEach((t) => {
      t.enabled = true
    })
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
  stream?.getAudioTracks().forEach((t) => {
    t.enabled = false
  })
}

api.onStart(() => {
  void start()
})
api.onStop(() => {
  stop()
})
