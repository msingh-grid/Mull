import { describe, expect, it } from 'vitest'
import { appliedText, diffText } from './diff'

describe('diffText', () => {
  it('reports no changes when nothing changed', () => {
    const result = diffText('send the deck today', 'send the deck today')
    expect(result.changes).toBe(0)
    expect(result.segments).toEqual([{ kind: 'same', text: 'send the deck today' }])
  })

  it('handles both sides being empty', () => {
    expect(diffText('', '')).toEqual({ segments: [], changes: 0 })
  })

  it('marks a replaced word as one change, not two', () => {
    const result = diffText('send the deck today', 'send the deck tomorrow')
    expect(result.changes).toBe(1)
    expect(result.segments.filter((s) => s.kind === 'del').map((s) => s.text.trim())).toEqual([
      'today'
    ])
    expect(result.segments.filter((s) => s.kind === 'ins').map((s) => s.text.trim())).toEqual([
      'tomorrow'
    ])
  })

  it('counts a pure insertion and a pure deletion separately', () => {
    expect(diffText('send the deck', 'send the deck today').changes).toBe(1)
    expect(diffText('send the deck today', 'send the deck').changes).toBe(1)
    // Two independent edits, one at each end.
    expect(diffText('the deck today', 'send the deck').changes).toBe(2)
  })

  it('counts a full rewrite word by word, paired in place', () => {
    // Word-level diffing localises each swap rather than striking the whole
    // line and rewriting it, so three words replaced reads as three changes —
    // which is also what someone looking at the card would say out loud.
    const result = diffText('one two three', 'four five six')
    // The separating spaces survive as `same` runs, which is what keeps the
    // card reading as a sentence rather than a column of tokens.
    expect(result.segments.map((s) => s.kind)).toEqual([
      'del',
      'ins',
      'same',
      'del',
      'ins',
      'same',
      'del',
      'ins'
    ])
    expect(result.changes).toBe(3)
  })

  it('grows text from nothing without emitting an empty deletion', () => {
    const result = diffText('', 'a new sentence')
    expect(result.segments).toEqual([{ kind: 'ins', text: 'a new sentence' }])
    expect(result.changes).toBe(1)
  })

  it('preserves whitespace so the body reads as prose, not tokens', () => {
    const result = diffText('hello  world', 'hello  there')
    expect(result.segments.map((s) => s.text).join('')).toContain('hello  ')
  })
})

describe('appliedText', () => {
  it('reconstructs exactly the after-string the diff was built from', () => {
    const cases: Array<[string, string]> = [
      ['send the deck today', 'send the deck tomorrow'],
      ['one two three', 'four five six'],
      ['', 'a new sentence'],
      ['delete all of this', ''],
      ['unchanged', 'unchanged']
    ]
    for (const [before, after] of cases) {
      expect(appliedText(diffText(before, after).segments)).toBe(after)
    }
  })
})
