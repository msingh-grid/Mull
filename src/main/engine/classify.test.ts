import { describe, expect, it } from 'vitest'
import { CLASSIFIER_FIELD_CHARS, classifyPrompt, parseClassification } from './classify'

describe('classifyPrompt', () => {
  const base = {
    transcript: 'make my last message less apologetic',
    app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
    selection: null,
    fieldText: null,
    fieldTruncated: false
  }

  it('separates what was said from what is on screen', () => {
    const prompt = classifyPrompt({ ...base, fieldText: 'sorry I was late' })
    expect(prompt).toContain('<said>\nmake my last message less apologetic\n</said>')
    expect(prompt).toContain('<field>\nsorry I was late\n</field>')
    expect(prompt).toContain('<app>Slack</app>')
  })

  it('shows the selection instead of the field when there is one', () => {
    const prompt = classifyPrompt({ ...base, selection: 'sorry', fieldText: 'sorry I was late' })
    expect(prompt).toContain('<selection>')
    expect(prompt).not.toContain('<field')
  })

  it('says when the field is a window onto something longer', () => {
    const prompt = classifyPrompt({ ...base, fieldText: 'a', fieldTruncated: true })
    expect(prompt).toContain('<field truncated="true">')
  })

  it('sends nothing about the page when there is nothing to send', () => {
    const prompt = classifyPrompt(base)
    expect(prompt).not.toContain('<field')
    expect(prompt).not.toContain('<selection')
  })

  it('clamps a long field from both ends', () => {
    const long = `START${'x'.repeat(50_000)}END`
    const prompt = classifyPrompt({ ...base, fieldText: long })
    expect(prompt.length).toBeLessThan(CLASSIFIER_FIELD_CHARS + 500)
    // Both ends survive: the opening says what kind of thing it is, the end is
    // what the caret is next to and what "this" usually means.
    expect(prompt).toContain('START')
    expect(prompt).toContain('END')
  })
})

describe('parseClassification', () => {
  it('reads the two shapes it asked for', () => {
    expect(parseClassification('{"intent":"dictate"}')).toEqual({ kind: 'dictate' })
    expect(
      parseClassification('{"intent":"edit","target":"document","instruction":"make it crisp"}')
    ).toEqual({ kind: 'edit', target: 'document', instruction: 'make it crisp' })
  })

  it('digs the JSON out of a model that added prose anyway', () => {
    expect(
      parseClassification('Sure! Here you go:\n```json\n{"intent":"dictate"}\n```\nHope that helps.')
    ).toEqual({ kind: 'dictate' })
  })

  /**
   * Every one of these is a way the classifier can fail, and every one of them
   * has to land on `dictate`. Typing an instruction the user meant as an edit
   * is a nuisance they undo in one keystroke; routing their sentence into a
   * card makes it vanish from where they were looking.
   */
  it('answers dictate for anything it cannot read', () => {
    for (const reply of [
      '',
      'I think that is an edit',
      '{',
      '{"intent":"edit"}', // no target, no instruction
      '{"intent":"edit","target":"everything","instruction":"x"}',
      '{"intent":"edit","target":"document","instruction":""}',
      '{"intent":"command","verb":"open"}',
      'null',
      '[]'
    ]) {
      expect(parseClassification(reply), JSON.stringify(reply)).toEqual({ kind: 'dictate' })
    }
  })

  it('trims the instruction it was given', () => {
    const parsed = parseClassification(
      '{"intent":"edit","target":"selection","instruction":"  tighten this up \\n"}'
    )
    expect(parsed).toEqual({ kind: 'edit', target: 'selection', instruction: 'tighten this up' })
  })
})
