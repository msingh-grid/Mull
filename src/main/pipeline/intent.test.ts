import { describe, expect, it } from 'vitest'
import type { ClassifiedIntent, ClassifyRequest, Engine, EngineState } from '../engine/types'
import { IntentRouter } from './intent'

const SAID = 'Can you make my last message less apologetic?'
const COMPOSER = 'I will get back to you today, sorry I was slow.'

interface FakeEngineOptions {
  state?: EngineState
  answer?: ClassifiedIntent | Error
  /** Milliseconds to take. Tests that care pass their own `timeoutMs`. */
  takes?: number
}

function engineThat(options: FakeEngineOptions = {}): Engine & { asked: ClassifyRequest[] } {
  const asked: ClassifyRequest[] = []
  return {
    asked,
    name: 'fake',
    model: null,
    ready: async () => options.state ?? { kind: 'ready' },
    classify: async (request) => {
      asked.push(request)
      if (options.takes) await new Promise((resolve) => setTimeout(resolve, options.takes))
      if (options.answer instanceof Error) throw options.answer
      return options.answer ?? { kind: 'dictate' }
    },
    transform: async () => ({ text: '' }),
    plan: async () => ({ steps: [], context: null })
  }
}

const INPUT = {
  transcript: SAID,
  app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
  selection: null,
  fieldText: COMPOSER,
  fieldTruncated: false
}

describe('IntentRouter — the fast path', () => {
  /**
   * The invariant, narrowed but intact: an empty box has nothing an edit could
   * act on, so nothing is asked and nothing is waited for.
   */
  it('types without asking anyone when there is nothing to edit', async () => {
    const engine = engineThat({ answer: { kind: 'edit', target: 'document', instruction: 'x' } })
    const router = new IntentRouter({ engine })

    const decision = await router.decide({ ...INPUT, fieldText: null })

    expect(decision.by).toBe('fast-path')
    expect(decision.route).toEqual({ kind: 'dictate', text: SAID })
    expect(engine.asked).toEqual([])
  })

  it('treats a whitespace-only field as empty', async () => {
    const engine = engineThat()
    const router = new IntentRouter({ engine })
    expect((await router.decide({ ...INPUT, fieldText: '   \n ' })).by).toBe('fast-path')
    expect(engine.asked).toEqual([])
  })
})

describe('IntentRouter — the model', () => {
  it('routes the sentence that started all this', async () => {
    const engine = engineThat({
      answer: {
        kind: 'edit',
        target: 'document',
        instruction: 'make my last message less apologetic'
      }
    })
    const router = new IntentRouter({ engine })

    const decision = await router.decide(INPUT)

    expect(decision.by).toBe('model')
    expect(decision.route).toEqual({
      kind: 'edit',
      target: 'document',
      instruction: 'make my last message less apologetic'
    })
    expect(decision.classifyMs).not.toBeNull()
  })

  it('shows the model what is on screen, and only that', async () => {
    const engine = engineThat()
    await new IntentRouter({ engine }).decide({ ...INPUT, selection: 'sorry I was slow' })

    // With a selection, the field text is withheld: the selection is the
    // subject, and the rest of the box is not the classifier's business.
    expect(engine.asked[0]).toMatchObject({ selection: 'sorry I was slow', fieldText: null })
  })

  it('corrects a target that does not exist', async () => {
    // The model asked for "selection" when nothing is selected. Pointing a card
    // at nothing is worse than acting on the field it was shown.
    const engine = engineThat({
      answer: { kind: 'edit', target: 'selection', instruction: 'tighten it' }
    })
    const decision = await new IntentRouter({ engine }).decide(INPUT)
    expect(decision.route).toMatchObject({ kind: 'edit', target: 'document' })
  })

  it('falls back to the user’s words when the model returns no instruction', async () => {
    const engine = engineThat({
      answer: { kind: 'edit', target: 'document', instruction: '   ' }
    })
    const decision = await new IntentRouter({ engine }).decide(INPUT)
    expect(decision.route).toMatchObject({ instruction: SAID })
  })
})

describe('IntentRouter — the fallback', () => {
  it('uses the rules when the classifier is too slow', async () => {
    const engine = engineThat({
      takes: 60,
      answer: { kind: 'edit', target: 'document', instruction: 'never arrives in time' }
    })
    const router = new IntentRouter({ engine, timeoutMs: 10 })

    const decision = await router.decide(INPUT)

    expect(decision.by).toBe('rules')
    expect(decision.fallbackReason).toBe('timed-out')
    // The rules do know this sentence now, so the user still gets their edit —
    // which is the point of keeping them rather than refusing.
    expect(decision.route.kind).toBe('edit')
  })

  it('uses the rules when the classifier throws', async () => {
    const engine = engineThat({ answer: new Error('rate limited') })
    const decision = await new IntentRouter({ engine }).decide(INPUT)
    expect(decision.by).toBe('rules')
    expect(decision.fallbackReason).toBe('engine-error')
  })

  it('does not even ask a signed-out engine', async () => {
    const engine = engineThat({ state: { kind: 'signed-out' } })
    const decision = await new IntentRouter({ engine }).decide(INPUT)

    expect(decision.by).toBe('rules')
    expect(decision.fallbackReason).toBe('signed-out')
    expect(engine.asked).toEqual([])
  })

  it('does not ask while the engine is rate limited', async () => {
    const engine = engineThat({ state: { kind: 'local-only', reason: 'busy.' } })
    const decision = await new IntentRouter({ engine }).decide(INPUT)
    expect(decision.fallbackReason).toBe('local-only')
    expect(engine.asked).toEqual([])
  })

  it('sends nothing anywhere when the user has chosen rules only', async () => {
    const engine = engineThat()
    const router = new IntentRouter({ engine, useModel: () => false })

    const decision = await router.decide(INPUT)

    expect(decision.by).toBe('rules')
    expect(decision.fallbackReason).toBe('rules-only')
    expect(engine.asked).toEqual([])
  })

  it('never throws, whatever the engine does', async () => {
    const engine: Engine = {
      name: 'hostile',
      model: null,
      ready: async () => {
        throw new Error('even ready() fails')
      },
      classify: async () => {
        throw new Error('and so does classify')
      },
      transform: async () => ({ text: '' }),
      plan: async () => ({ steps: [], context: null })
    }
    const decision = await new IntentRouter({ engine }).decide(INPUT)
    expect(decision.by).toBe('rules')
  })
})

/**
 * The second fast path, which exists because of a measurement: a warm Agent SDK
 * classification is p50 4.2s. Asking on every utterance into a half-written
 * email would make dictation unusable, so ordinary speech has to skip the
 * question entirely.
 */
describe('IntentRouter — words that could not be an instruction', () => {
  const PLAIN = [
    'and I will send the deck tonight',
    'Thanks so much, that really helped',
    'Following up on the terms doc, we still need your sign-off',
    'I think we should wait for the next round',
    'sounds good, Tuesday works for me'
  ]

  for (const transcript of PLAIN) {
    it(`types without asking: “${transcript}”`, async () => {
      const engine = engineThat()
      const decision = await new IntentRouter({ engine }).decide({ ...INPUT, transcript })

      expect(decision.by).toBe('fast-path')
      expect(engine.asked).toEqual([])
    })
  }

  /**
   * The other half of the trade. These *might* be instructions, so they are
   * worth a few seconds of asking — including the ones the model will correctly
   * send straight back as dictation.
   */
  for (const transcript of [
    'Can you make my last message less apologetic?',
    'tighten this up',
    'make sure Priya signs off before Friday',
    'fix the meeting to 3pm and tell Dan'
  ]) {
    it(`asks about: “${transcript}”`, async () => {
      const engine = engineThat()
      await new IntentRouter({ engine }).decide({ ...INPUT, transcript })
      expect(engine.asked.length).toBe(1)
    })
  }
})
