import { describe, expect, it } from 'vitest'
import {
  concatFloat32,
  encodeWav,
  floatToInt16,
  LEAD_PAD_MS,
  padUtterance,
  peakAmplitude,
  TAIL_PAD_MS
} from './wav'

describe('concatFloat32', () => {
  it('joins chunks in order', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3])])
    expect(Array.from(out)).toEqual([1, 2, 3])
  })

  it('handles the empty case', () => {
    expect(concatFloat32([]).length).toBe(0)
  })
})

describe('floatToInt16', () => {
  it('maps the full range and clamps beyond it', () => {
    const out = floatToInt16(new Float32Array([0, 1, -1, 2, -2]))
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(32767)
    expect(out[2]).toBe(-32768)
    expect(out[3]).toBe(32767)
    expect(out[4]).toBe(-32768)
  })
})

describe('peakAmplitude', () => {
  it('finds the loudest absolute sample', () => {
    expect(peakAmplitude(new Float32Array([0.1, -0.7, 0.3]))).toBeCloseTo(0.7)
    expect(peakAmplitude(new Float32Array())).toBe(0)
  })
})

describe('encodeWav', () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -0.5]), 16_000)

  it('writes a RIFF/WAVE container', () => {
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data')
  })

  it('declares 16-bit mono at the given rate', () => {
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt16LE(34)).toBe(16) // bits
  })

  it('sizes the header against the payload', () => {
    expect(wav.length).toBe(44 + 3 * 2)
    expect(wav.readUInt32LE(4)).toBe(36 + 3 * 2)
    expect(wav.readUInt32LE(40)).toBe(3 * 2)
  })
})

describe('padUtterance', () => {
  it('surrounds the utterance with silence so the decoder has a run-up and a stop', () => {
    const sr = 16_000
    const speech = Float32Array.from([0.5, -0.5, 0.25])
    const padded = padUtterance(speech, sr)

    const lead = Math.round((LEAD_PAD_MS / 1000) * sr)
    const tail = Math.round((TAIL_PAD_MS / 1000) * sr)
    expect(padded.length).toBe(lead + speech.length + tail)
    expect(padded[lead]).toBe(0.5)
    expect(padded[lead + 2]).toBe(0.25)
  })

  it('pads with true silence, not with a copy of the signal', () => {
    const padded = padUtterance(Float32Array.from([1, 1, 1]), 16_000)
    expect(padded[0]).toBe(0)
    expect(padded[padded.length - 1]).toBe(0)
  })

  it('leaves the samples alone when asked for no padding', () => {
    const speech = Float32Array.from([0.1, 0.2])
    expect(padUtterance(speech, 16_000, 0, 0)).toBe(speech)
  })

  it('does not change the peak, so the silence gate still sees the same audio', () => {
    const speech = Float32Array.from([0.4, -0.7, 0.2])
    expect(peakAmplitude(padUtterance(speech, 16_000))).toBeCloseTo(peakAmplitude(speech), 6)
  })
})
