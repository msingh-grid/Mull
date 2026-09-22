import { describe, expect, it } from 'vitest'
import { SwitchableAsrProvider } from './index'
import type { AsrProvider, AsrResult } from './types'

function provider(name: string): AsrProvider & { disposed: number; calls: number } {
  return {
    name,
    unavailableReason: null,
    disposed: 0,
    calls: 0,
    async ready() {
      return true
    },
    async transcribe(): Promise<AsrResult> {
      this.calls += 1
      return { text: name, durationMs: 1, model: name, confidence: null }
    },
    async dispose() {
      this.disposed += 1
    }
  }
}

const audio = new Float32Array(8)

describe('SwitchableAsrProvider', () => {
  it('delegates to whatever it currently holds', async () => {
    const base = provider('base')
    const holder = new SwitchableAsrProvider(base)

    expect(holder.name).toBe('base')
    await expect(holder.transcribe(audio, 16_000)).resolves.toMatchObject({ model: 'base' })

    await holder.swap(provider('small'))

    expect(holder.name).toBe('small')
    await expect(holder.transcribe(audio, 16_000)).resolves.toMatchObject({ model: 'small' })
    expect(base.calls).toBe(1)
  })

  it('disposes the provider it retires, exactly once', async () => {
    const base = provider('base')
    const holder = new SwitchableAsrProvider(base)

    await holder.swap(provider('small'))
    expect(base.disposed).toBe(1)
  })

  it('swapping in the same provider is not a dispose', async () => {
    const base = provider('base')
    const holder = new SwitchableAsrProvider(base)

    await holder.swap(base)
    expect(base.disposed).toBe(0)
    expect(holder.name).toBe('base')
  })

  // An utterance already in flight holds the provider it started with, so a
  // switch mid-sentence finishes on the old model rather than failing.
  it('leaves a transcription already running on the old provider', async () => {
    const base = provider('base')
    const holder = new SwitchableAsrProvider(base)

    const inFlight = holder.transcribe(audio, 16_000)
    await holder.swap(provider('small'))

    await expect(inFlight).resolves.toMatchObject({ model: 'base' })
  })
})
