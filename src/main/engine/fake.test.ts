import { describe, expect, it } from 'vitest'
import { CANONICAL_SAMPLE, FakeEngine, tighten } from './fake'
import { diffText } from '../pipeline/diff'

const engine = (): FakeEngine => new FakeEngine({ chunkMs: 0 })

describe('FakeEngine', () => {
  it('does not claim to be an engine', async () => {
    expect(await engine().ready()).toEqual({
      kind: 'local-only',
      reason: 'No engine is connected yet.'
    })
  })

  it('produces the design’s canonical edit from the canonical sample', async () => {
    const result = await engine().transform({
      instruction: 'make this crisp',
      text: CANONICAL_SAMPLE.before,
      app: null
    })
    expect(result.text).toBe(CANONICAL_SAMPLE.after)
  })

  it('falls back to the canonical sample when given nothing to edit', async () => {
    const result = await engine().transform({ instruction: 'tighten', text: '   ', app: null })
    expect(result.text).toBe(CANONICAL_SAMPLE.after)
  })

  it('streams strictly growing prefixes, ending at the final text', async () => {
    const seen: string[] = []
    const result = await engine().transform(
      { instruction: 'crisp', text: CANONICAL_SAMPLE.before, app: null },
      (partial) => seen.push(partial)
    )
    expect(seen.length).toBeGreaterThan(3)
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!.startsWith(seen[i - 1]!)).toBe(true)
    }
    expect(seen.at(-1)).toBe(result.text)
  })

  it('edits the user’s own text rather than inventing a paraphrase', async () => {
    const before = 'I was just wondering if maybe we could ship on Tuesday.'
    const { text } = await engine().transform({ instruction: 'crisp', text: before, app: null })
    expect(text).toBe('We could ship on Tuesday.')
    // Everything it kept is text the user actually wrote.
    for (const segment of diffText(before, text).segments) {
      if (segment.kind === 'ins') expect(before.toLowerCase()).toContain(segment.text.toLowerCase())
    }
  })

  it('proposes a plan without running anything', async () => {
    const plan = await engine().plan({ instruction: 'save this to notes', app: null })
    expect(plan.steps).toHaveLength(3)
    expect(plan.steps.every((step) => step.verb && step.object)).toBe(true)
  })
})

describe('tighten', () => {
  it('leaves already-crisp text alone', () => {
    expect(tighten('Send the deck today.')).toBe('Send the deck today.')
  })

  it('does not leave a dangling comma or double space behind a cut', () => {
    const out = tighten('I think that maybe  we should,  no rush at all, ship it.')
    expect(out).not.toMatch(/\s{2,}/)
    expect(out).not.toMatch(/\s,/)
  })

  it('re-capitalises when the opening words are what got cut', () => {
    expect(tighten('just a quick note, the build is green.')).toBe('The build is green.')
  })
})
