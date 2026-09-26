/**
 * Opt-in smoke coverage against the user's real ChatGPT-authenticated CLI.
 *
 * These calls consume subscription usage, so the ordinary suite skips them:
 *   MULL_CODEX_INTEGRATION=1 npx vitest run src/main/engine/codex.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CODEX_MODEL_IDS } from '@shared/settings'
import { resolveCodexCliPath } from '../locations'
import { CodexCliEngine, inspectCodexCli } from './codex'

const enabled = process.env['MULL_CODEX_INTEGRATION'] === '1'
const real = describe.skipIf(!enabled)
let engine: CodexCliEngine

real('CodexCliEngine real subscription', () => {
  beforeAll(() => {
    const inspection = inspectCodexCli(resolveCodexCliPath())
    if (!inspection.path || !inspection.compatible || !inspection.loggedIn) {
      throw new Error(inspection.reason ?? 'A compatible ChatGPT-authenticated Codex CLI is required.')
    }
    engine = new CodexCliEngine({
      codexPath: inspection.path,
      model: CODEX_MODEL_IDS.terra,
      classifierModel: CODEX_MODEL_IDS.terra
    })
  })

  afterAll(async () => engine?.dispose())

  it('classifies', async () => {
    const result = await engine.classify({
      transcript: 'make this shorter',
      app: null,
      selection: 'This sentence is unnecessarily long.',
      fieldText: null,
      fieldTruncated: false,
      context: null,
      targets: []
    })
    expect(result.kind).toBe('edit')
  }, 120_000)

  it('transforms', async () => {
    const result = await engine.transform({
      instruction: 'make this shorter',
      text: 'This sentence is unnecessarily long.',
      app: null
    })
    expect(result.text.length).toBeGreaterThan(0)
  }, 120_000)

  it('composes', async () => {
    const result = await engine.compose({ instruction: 'write a one-line thank you', app: null })
    expect(result.text.length).toBeGreaterThan(0)
  }, 120_000)

  it('answers', async () => {
    const result = await engine.answer({ goal: 'Answer with the word ready.' })
    expect(result.text.length).toBeGreaterThan(0)
  }, 120_000)

  it('returns one validated navigation step', async () => {
    const result = await engine.navigate({
      goal: 'Stop because this integration check is complete.',
      app: null,
      targets: [],
      history: [],
      stepsLeft: 1
    })
    expect(['press', 'type', 'navKey', 'read', 'done']).toContain(result.verb)
  }, 120_000)
})
