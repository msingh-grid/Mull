import { describe, expect, it } from 'vitest'
import { MAX_PROMPT_CHARS, parseWhisperJson, parseWhisperStdout, WhisperCliProvider } from './whisper-cli'

/** Shaped like a real `--output-json-full` document, trimmed to what we read. */
function doc(segments: unknown[]): string {
  return JSON.stringify({ systeminfo: '', model: {}, params: {}, result: {}, transcription: segments })
}

describe('parseWhisperJson', () => {
  it('joins segment text and averages token probabilities', () => {
    const raw = doc([
      { text: ' Open any Slack channel.', tokens: [{ text: ' Open', p: 0.5 }, { text: ' any', p: 0.9 }] }
    ])
    const { text, confidence } = parseWhisperJson(raw)
    expect(text).toBe('Open any Slack channel.')
    expect(confidence).toBeCloseTo(0.7, 5)
  })

  it('ignores whisper special tokens when scoring', () => {
    const raw = doc([
      { text: ' Hello', tokens: [{ text: '[_BEG_]', p: 0.01 }, { text: ' Hello', p: 0.9 }] }
    ])
    // 0.01 would drag a two-token utterance to 0.455 and read as a guess.
    expect(parseWhisperJson(raw).confidence).toBeCloseTo(0.9, 5)
  })

  it('reports no confidence rather than a fake one when probabilities are absent', () => {
    expect(parseWhisperJson(doc([{ text: ' Hello' }])).confidence).toBeNull()
  })

  it('returns empty text for an empty transcription', () => {
    expect(parseWhisperJson(doc([])).text).toBe('')
  })

  it('collapses whitespace across segments', () => {
    const raw = doc([{ text: '  Open  any ' }, { text: ' Slack   channel ' }])
    expect(parseWhisperJson(raw).text).toBe('Open any Slack channel')
  })
})

describe('parseWhisperStdout', () => {
  it('strips timestamp prefixes and log lines', () => {
    const stdout = [
      'whisper_init_from_file: loading model',
      'main: processing utterance.wav',
      '[00:00:00.000 --> 00:00:02.000]   Open any Slack channel.',
      ''
    ].join('\n')
    expect(parseWhisperStdout(stdout)).toBe('Open any Slack channel.')
  })
})

describe('WhisperCliProvider', () => {
  it('reports a missing binary as a reason a human can act on', async () => {
    const provider = new WhisperCliProvider({
      binaryPath: '/nonexistent/whisper-cli',
      modelPath: '/nonexistent/model.bin'
    })
    expect(await provider.ready()).toBe(false)
    expect(provider.unavailableReason).toContain('brew install whisper-cpp')
  })

  it('reports a missing model separately from a missing binary', async () => {
    const provider = new WhisperCliProvider({
      binaryPath: process.execPath, // exists, whatever it is
      modelPath: '/nonexistent/model.bin'
    })
    expect(await provider.ready()).toBe(false)
    expect(provider.unavailableReason).toContain('fetch:model')
  })

  it('outlives the longest utterance the pipeline can hand it', async () => {
    // MAX_UTTERANCE_MS is 120 s; a timeout at or under that kills the decode
    // of the one utterance most expensive to repeat.
    const provider = new WhisperCliProvider({ binaryPath: 'x', modelPath: 'y' })
    expect(provider['timeoutMs']).toBeGreaterThan(120_000)
  })
})

describe('MAX_PROMPT_CHARS', () => {
  it('stays well inside whisper’s own n_text_ctx/2 ceiling', () => {
    expect(MAX_PROMPT_CHARS).toBeLessThanOrEqual(256)
  })
})
