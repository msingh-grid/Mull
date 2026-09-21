import { describe, expect, it } from 'vitest'
import { buildAsrPrompt } from './asr-prompt'
import type { FocusSnapshot } from './selection'
import type { ScreenContext } from '@shared/context'

const MAX = 220

function context(partial: Partial<ScreenContext>): ScreenContext {
  return {
    app: null,
    windowTitle: null,
    blocks: [],
    truncated: false,
    image: null,
    imageReason: null,
    chars: 0,
    harvestMs: 0,
    ...partial
  }
}

function snapshot(partial: Partial<Pick<FocusSnapshot, 'app' | 'context'>>) {
  return { app: null, context: null, ...partial }
}

describe('buildAsrPrompt', () => {
  it('is empty when there is nothing on screen to name', () => {
    expect(buildAsrPrompt(null, MAX)).toBe('')
    expect(buildAsrPrompt(snapshot({}), MAX)).toBe('')
  })

  it('names the app being spoken into first', () => {
    const prompt = buildAsrPrompt(
      snapshot({ app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' } }),
      MAX
    )
    expect(prompt).toBe('Slack')
  })

  it('picks up channel handles, which are never false positives', () => {
    const prompt = buildAsrPrompt(
      snapshot({
        app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
        context: context({ blocks: [{ text: '#eng-platform', focused: false } as never] })
      }),
      MAX
    )
    expect(prompt).toContain('#eng-platform')
  })

  it('splits adjacent names rather than merging them into one', () => {
    const prompt = buildAsrPrompt(
      snapshot({
        context: context({ blocks: [{ text: 'Anil Turaga Sarah Chen', focused: false } as never] })
      }),
      MAX
    )
    expect(prompt.split(', ')).toEqual(['Anil', 'Turaga', 'Sarah', 'Chen'])
  })

  it('keeps proper nouns and drops capitalised sentence openers', () => {
    const prompt = buildAsrPrompt(
      snapshot({
        context: context({
          blocks: [{ text: 'The terms doc from Anil Turaga. When can you look?', focused: false } as never]
        })
      }),
      MAX
    )
    expect(prompt).toContain('Anil')
    expect(prompt).toContain('Turaga')
    expect(prompt).not.toContain('The')
    expect(prompt).not.toContain('When')
  })

  it('is a noun list, never a sentence — whisper continues prose it is given', () => {
    const prompt = buildAsrPrompt(
      snapshot({
        app: { bundleId: 'x', name: 'Slack' },
        context: context({ windowTitle: 'Notion — Roadmap' })
      }),
      MAX
    )
    expect(prompt).not.toMatch(/[.?!]/)
    expect(prompt.split(', ').length).toBeGreaterThan(1)
  })

  it('never exceeds the character cap whisper enforces', () => {
    const blocks = Array.from({ length: 200 }, (_, i) => ({
      text: `Project Apollo${i} Zeus${i}`,
      focused: false
    })) as never[]
    const prompt = buildAsrPrompt(snapshot({ context: context({ blocks }) }), MAX)
    expect(prompt.length).toBeLessThanOrEqual(MAX)
  })

  it('does not list the same name twice in different cases', () => {
    const prompt = buildAsrPrompt(
      snapshot({
        app: { bundleId: 'x', name: 'Slack' },
        context: context({ blocks: [{ text: 'Slack Slack SLACK', focused: false } as never] })
      }),
      MAX
    )
    expect(prompt.toLowerCase().split('slack').length - 1).toBe(1)
  })
})
