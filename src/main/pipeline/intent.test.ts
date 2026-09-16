import { describe, expect, it } from 'vitest'
import type { ClassifiedIntent, ClassifyRequest, Engine, EngineState } from '../engine/types'
import { IntentRouter, usableGoal } from './intent'

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
    compose: async () => ({ text: '' }),
    navigate: async () => ({ verb: 'done' as const, because: 'not this test' }),
    answer: async () => ({ text: 'not this test' })
  }
}

const INPUT = {
  transcript: SAID,
  app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
  selection: null,
  fieldText: COMPOSER,
  fieldTruncated: false
}

/**
 * There is no longer a gate here.
 *
 * `IntentRouter` is only ever reached on the instruct key, so the question
 * "was that an instruction?" has already been answered by a key press. What
 * used to sit at the top of `decide()` — a table of verbs deciding whether the
 * question was worth asking — is gone, along with the bug it kept producing.
 */
describe('IntentRouter — it asks, because the key already decided', () => {
  it('asks about words a verb table would have typed', async () => {
    for (const transcript of [
      'summarize this thread',
      'catch me up on this',
      'what did they decide about the redlines',
      'and I will send the deck tonight'
    ]) {
      const engine = engineThat()
      await new IntentRouter({ engine }).decide({ ...INPUT, transcript })
      expect(engine.asked.length).toBe(1)
    }
  })

  it('asks even when there is nothing in the field to edit', async () => {
    const engine = engineThat()
    await new IntentRouter({ engine }).decide({ ...INPUT, fieldText: null })
    expect(engine.asked.length).toBe(1)
  })

  /**
   * The model is still free to answer "those were just words" — and that is
   * now the only thing that can produce a dictate from this lane.
   */
  it('types the words when the model says they were the message', async () => {
    const engine = engineThat({ answer: { kind: 'dictate' } })
    const decision = await new IntentRouter({ engine }).decide({
      ...INPUT,
      transcript: 'and I will send the deck tonight'
    })

    expect(decision.by).toBe('model')
    expect(decision.route).toEqual({ kind: 'dictate', text: 'and I will send the deck tonight' })
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
      compose: async () => ({ text: '' }),
      navigate: async () => ({ verb: 'done' as const, because: 'not this test' }),
      answer: async () => ({ text: 'not this test' })
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
/**
 * Compose (M5a) — the route that needs no text in the field, only something on
 * screen to answer.
 */
describe('IntentRouter — composing a reply', () => {
  const WINDOW = {
    app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
    windowTitle: '#terms-doc',
    blocks: [
      {
        role: 'AXStaticText',
        text: 'can you confirm the redlines by EOD?',
        label: null,
        focused: false,
        selected: false
      }
    ],
    truncated: false,
    image: null,
    imageReason: 'not-requested',
    chars: 36,
    harvestMs: 11
  }

  const EMPTY_COMPOSER = {
    ...INPUT,
    transcript: 'reply saying I will have them by five',
    fieldText: null,
    context: WINDOW
  }

  it('routes a reply into an empty composer, which M4.1 would have typed', async () => {
    const engine = engineThat({
      answer: { kind: 'compose', instruction: 'say the redlines will be there by five' }
    })

    const decision = await new IntentRouter({ engine }).decide(EMPTY_COMPOSER)

    expect(decision.by).toBe('model')
    expect(decision.route).toEqual({
      kind: 'compose',
      instruction: 'say the redlines will be there by five'
    })
  })

  it('asks, even though the field is empty', async () => {
    const engine = engineThat()
    await new IntentRouter({ engine }).decide(EMPTY_COMPOSER)
    expect(engine.asked.length).toBe(1)
  })

  /**
   * A compose with nothing to compose from would be a card proposing text
   * invented out of nothing — which is the one thing this app must not do.
   */
  it('refuses to compose when it cannot see anything', async () => {
    const engine = engineThat({
      answer: { kind: 'compose', instruction: 'reply politely' }
    })
    const decision = await new IntentRouter({ engine }).decide({
      ...INPUT,
      transcript: 'reply to this',
      fieldText: 'half a sentence',
      context: null
    })
    expect(decision.route).toMatchObject({ kind: 'dictate' })
  })

  it('sends the window text to the classifier, but never the picture', async () => {
    const engine = engineThat()
    await new IntentRouter({ engine }).decide({
      ...EMPTY_COMPOSER,
      context: {
        ...WINDOW,
        image: {
          mediaType: 'image/jpeg' as const,
          dataBase64: 'AAAA',
          width: 1400,
          height: 900,
          bytes: 1024
        },
        imageReason: null
      }
    })
    // Classification is already p50 4.2s on the subscription lane; an image
    // would make the one call the user waits through blind even slower. The
    // text arrives, the picture is stripped before the request is built.
    expect(engine.asked[0]?.context?.blocks).toHaveLength(1)
    expect(engine.asked[0]?.context?.image).toBeNull()
  })
})

/**
 * Giving up on a classifier that cannot keep up — and taking it back.
 *
 * A timeout is the worst outcome available: the user waits the whole budget and
 * then receives the answer the local rules had instantly. So giving up has to
 * stay possible.
 *
 * But the first version gave up after two, against a 4.5s budget measured at
 * p50 5.4s — so it demoted itself inside the first two instructions of every
 * session, permanently, and a real log showed fourteen consecutive utterances
 * answered by the rules with the model never once consulted. The budget is 20s
 * now and the patience is five, and the demotion expires.
 */
describe('IntentRouter — an engine that cannot answer in time', () => {
  function slowEngine(): Engine & { asked: ClassifyRequest[] } {
    return engineThat({
      takes: 60,
      answer: { kind: 'edit', target: 'document', instruction: 'never arrives' }
    })
  }

  it('keeps asking through four timeouts, and stops after the fifth', async () => {
    const engine = slowEngine()
    const router = new IntentRouter({ engine, timeoutMs: 10 })

    for (let i = 0; i < 5; i += 1) {
      expect((await router.decide(INPUT)).fallbackReason).toBe('timed-out')
    }

    const sixth = await router.decide(INPUT)
    expect(sixth.by).toBe('rules')
    expect(sixth.fallbackReason).toBe('too-slow')
    // Five utterances to learn, none after that — and the point of five rather
    // than two is that a slow minute is not a broken engine.
    expect(engine.asked.length).toBe(5)
  })

  /**
   * The bug this whole change exists to fix: a bad stretch used to be
   * permanent. A flaky connection, a rate limit, a laptop waking up — and the
   * classifier was off until the app relaunched, with nothing on screen to say
   * so. The network problem should not outlive the network problem.
   */
  it('takes the demotion back once the wait is served', async () => {
    const engine = slowEngine()
    let clock = 0
    const router = new IntentRouter({ engine, timeoutMs: 10, now: () => clock })
    for (let i = 0; i < 5; i += 1) await router.decide(INPUT)
    expect((await router.decide(INPUT)).fallbackReason).toBe('too-slow')
    expect(engine.asked.length).toBe(5)

    clock += 4 * 60_000
    expect((await router.decide(INPUT)).fallbackReason).toBe('too-slow')

    clock += 2 * 60_000
    expect((await router.decide(INPUT)).fallbackReason).toBe('timed-out')
    expect(engine.asked.length).toBe(6)
  })

  it('does not give up on an engine that is merely erroring', async () => {
    // A rate limit or a dropped connection is a different problem and may clear
    // on its own; only a lane that is structurally too slow gets demoted.
    const engine = engineThat({ answer: new Error('rate limited') })
    const router = new IntentRouter({ engine })

    await router.decide(INPUT)
    await router.decide(INPUT)
    await router.decide(INPUT)

    expect(engine.asked.length).toBe(3)
  })

  it('forgets the moment the engine is swapped', async () => {
    const engine = slowEngine()
    const router = new IntentRouter({ engine, timeoutMs: 10 })
    for (let i = 0; i < 5; i += 1) await router.decide(INPUT)
    expect((await router.decide(INPUT)).fallbackReason).toBe('too-slow')

    // Signing in with an API key is exactly this: a lane that answers in a
    // fraction of the time the harness takes.
    router.reset()
    expect((await router.decide(INPUT)).fallbackReason).toBe('timed-out')
    expect(engine.asked.length).toBe(6)
  })

  it('a single answer in time clears the count', async () => {
    let slow = true
    const engine: Engine & { asked: ClassifyRequest[] } = {
      asked: [],
      name: 'sometimes',
      model: null,
      ready: async () => ({ kind: 'ready' }),
      classify: async (request) => {
        engine.asked.push(request)
        if (slow) await new Promise((resolve) => setTimeout(resolve, 60))
        return { kind: 'dictate' }
      },
      transform: async () => ({ text: '' }),
      compose: async () => ({ text: '' }),
      navigate: async () => ({ verb: 'done' as const, because: 'not this test' }),
      answer: async () => ({ text: 'not this test' })
    }
    const router = new IntentRouter({ engine, timeoutMs: 20 })

    for (let i = 0; i < 4; i += 1) await router.decide(INPUT)
    // One answer in time, and the count starts over.
    slow = false
    await router.decide(INPUT)
    slow = true
    for (let i = 0; i < 5; i += 1) {
      expect((await router.decide(INPUT)).fallbackReason).toBe('timed-out')
    }
    expect((await router.decide(INPUT)).fallbackReason).toBe('too-slow')
  })
})

/**
 * The goal the navigator is handed.
 *
 * It never sees what the user said — only this sentence and a list of what is
 * on screen — and what it does with it is press things. A real session
 * produced `goal="Anil Turaga"`, which leaves it to guess, and the guess is a
 * keystroke in somebody's application. The classifier prompt is the fix; this
 * is the backstop, and it only has to catch the shape that is definitely
 * useless.
 */
describe('usableGoal', () => {
  const said = 'may we get to Anil Turaga'

  it('keeps a goal that says where to go and what to do there', () => {
    for (const goal of [
      'open the conversation with Anil Turaga and read the recent messages',
      'open the #eng-platform channel and read the recent messages',
      'find whether Priya replied about pricing'
    ]) {
      expect(usableGoal(goal, said)).toBe(goal)
    }
  })

  it('falls back to the user’s own words when handed a name', () => {
    expect(usableGoal('Anil Turaga', said)).toBe(said)
    expect(usableGoal('#eng-platform', said)).toBe(said)
    expect(usableGoal('  ', said)).toBe(said)
  })

  /** Longer, but still nothing actually being asked for. */
  it('falls back on a noun phrase with no verb in it', () => {
    expect(usableGoal('the terms doc conversation with Anil', said)).toBe(said)
  })
})
