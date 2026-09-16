/**
 * PCM tap for the hidden capture window.
 *
 * The AudioContext is opened at 16 kHz so Chromium's resampler does the rate
 * conversion for us; this processor only batches the 128-frame render quanta
 * into ~80 ms chunks so we cross the worklet->main-thread boundary 12x/s
 * instead of 125x/s. It never allocates inside the hot path except for the
 * chunk it hands off.
 */
const CHUNK_FRAMES = 1280 // 80 ms at 16 kHz

class PcmTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(CHUNK_FRAMES)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    let read = 0
    while (read < channel.length) {
      const room = CHUNK_FRAMES - this.filled
      const take = Math.min(room, channel.length - read)
      this.buffer.set(channel.subarray(read, read + take), this.filled)
      this.filled += take
      read += take

      if (this.filled === CHUNK_FRAMES) {
        const chunk = this.buffer.slice(0)
        this.port.postMessage(chunk, [chunk.buffer])
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-tap', PcmTapProcessor)
