import { describe, expect, it } from 'vitest'
import { SPEECH_MODELS } from '@shared/model'
import { KNOWN_MODELS, modelFileFor, modelPathFor } from './model'
import { DEFAULT_MODEL_FILE, modelsDir } from '../locations'

describe('model catalog', () => {
  // The bug this guards: a menu and a downloader that spell `small.en`
  // differently. The pane renders SPEECH_MODELS; the fetcher reads KNOWN_MODELS.
  it('offers every model the settings pane lists', () => {
    for (const model of SPEECH_MODELS) {
      expect(KNOWN_MODELS[model.id]).toBe(model.file)
      expect(modelFileFor(model.id)).toBe(model.file)
    }
  })

  it('still resolves the names only the CLI can ask for', () => {
    expect(modelFileFor('tiny.en')).toBe('ggml-tiny.en.bin')
    expect(modelFileFor('small')).toBe('ggml-small.bin')
  })

  it('takes an explicit filename, and falls back for anything else', () => {
    expect(modelFileFor('ggml-medium.en.bin')).toBe('ggml-medium.en.bin')
    expect(modelFileFor('enormous')).toBe(DEFAULT_MODEL_FILE)
  })

  it('puts every model in the models directory', () => {
    expect(modelPathFor('small.en')).toBe(`${modelsDir()}/ggml-small.en.bin`)
  })
})
