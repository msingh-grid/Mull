/**
 * Minimal 16-bit PCM WAV writer.
 *
 * whisper.cpp's CLI wants a real RIFF file on disk; this is the only place we
 * leave the Float32 domain. Mono only — capture is mono by construction.
 */

export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** Clamp + scale Float32 [-1,1] to signed 16-bit. */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** Peak amplitude — used to tell "silence" from "speech" before paying for ASR. */
export function peakAmplitude(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i] ?? 0)
    if (v > peak) peak = v
  }
  return peak
}

export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const pcm = floatToInt16(samples)
  const dataBytes = pcm.length * 2
  const buf = Buffer.alloc(44 + dataBytes)

  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')

  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // PCM chunk size
  buf.writeUInt16LE(1, 20) // format: PCM
  buf.writeUInt16LE(1, 22) // channels: mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate (mono, 2 bytes/sample)
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample

  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < pcm.length; i += 1) {
    buf.writeInt16LE(pcm[i] ?? 0, 44 + i * 2)
  }
  return buf
}
