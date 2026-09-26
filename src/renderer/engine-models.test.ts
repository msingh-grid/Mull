import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { engineModelControls } from './engine-models'

describe('engineModelControls', () => {
  it('shows Claude choices for Automatic, subscription, and API-key lanes', () => {
    for (const engine of ['auto', 'subscription', 'api-key'] as const) {
      const controls = engineModelControls({ ...DEFAULT_SETTINGS, engine })
      expect(controls).toMatchObject({
        codex: false,
        editValue: 'sonnet',
        classifierValue: 'sonnet',
        showAgentModel: true
      })
      expect(controls.options.map((option) => option.value)).toEqual(['haiku', 'sonnet', 'opus'])
    }
  })

  it('shows independent Codex choices and hides the Claude agent model', () => {
    const controls = engineModelControls({
      ...DEFAULT_SETTINGS,
      engine: 'codex-subscription',
      editModel: 'opus',
      classifierModel: 'haiku',
      codexEditModel: 'sol',
      codexClassifierModel: 'luna'
    })
    expect(controls).toMatchObject({
      codex: true,
      editValue: 'sol',
      classifierValue: 'luna',
      showAgentModel: false
    })
    expect(controls.options.map((option) => option.value)).toEqual(['luna', 'terra', 'sol'])
  })
})
