import type { Settings } from '@shared/settings'

export interface EngineModelOption {
  value: string
  label: string
}

export const CLAUDE_MODEL_OPTIONS: readonly EngineModelOption[] = [
  { value: 'haiku', label: 'Fast — Haiku 4.5' },
  { value: 'sonnet', label: 'Careful — Sonnet 5' },
  { value: 'opus', label: 'Most careful — Opus 5' }
]

export const CODEX_MODEL_OPTIONS: readonly EngineModelOption[] = [
  { value: 'luna', label: 'Fast — GPT-5.6-Luna' },
  { value: 'terra', label: 'Careful — GPT-5.6-Terra' },
  { value: 'sol', label: 'Most careful — GPT-5.6-Sol' }
]

type ModelSettings = Pick<
  Settings,
  'engine' | 'editModel' | 'classifierModel' | 'codexEditModel' | 'codexClassifierModel'
>

/** Provider-specific values for the two controls shared by both engine families. */
export function engineModelControls(settings: ModelSettings): {
  codex: boolean
  editValue: string
  classifierValue: string
  options: readonly EngineModelOption[]
  showAgentModel: boolean
} {
  const codex = settings.engine === 'codex-subscription'
  return {
    codex,
    editValue: codex ? settings.codexEditModel : settings.editModel,
    classifierValue: codex ? settings.codexClassifierModel : settings.classifierModel,
    options: codex ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS,
    showAgentModel: !codex
  }
}
