import { describe, expect, it } from 'vitest'
import type { UiTarget } from '@shared/sidecar-api'
import {
  CLASSIFIER_FIELD_CHARS,
  classifyPrompt,
  parseClassification,
  renderRecent
} from './classify'

const target = (index: number, title: string): UiTarget => ({
  index,
  role: 'AXRow',
  subrole: null,
  title,
  help: null,
  value: null,
  frame: null,
  actions: ['AXPress'],
  enabled: true,
  focused: false,
  kind: 'press'
})

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
    expect(prompt).toContain('name="Slack"')
    expect(prompt).toContain('bundle="com.tinyspeck.slackmacgap"')
  })

  it('names the window, so “is Priya already in front of me” is answerable', () => {
    const prompt = classifyPrompt({
      ...base,
      context: {
        app: base.app,
        windowTitle: 'Anil Turaga (DM) - Grid Dynamics - Slack',
        blocks: [{ role: 'AXStaticText', text: 'morning', label: null, focused: false, selected: false }],
        truncated: false,
        image: null,
        imageReason: null,
        chars: 7,
        harvestMs: 4
      }
    })
    expect(prompt).toContain('window="Anil Turaga (DM) - Grid Dynamics - Slack"')
  })

  it('lists what can be pressed, so “here” can be told from “elsewhere”', () => {
    const prompt = classifyPrompt({ ...base, targets: [target(0, 'Direct Messages'), target(1, 'eng-platform')] })
    expect(prompt).toContain('<targets>')
    expect(prompt).toContain('eng-platform')
  })

  it('says how many targets it left out rather than silently truncating', () => {
    // A cut-off list reads exactly like a complete one, and "the channel is not
    // in this window" is the wrong conclusion to draw from a list that stopped.
    const many = Array.from({ length: 80 }, (_, i) => target(i, `row ${i}`))
    const prompt = classifyPrompt({ ...base, targets: many })
    expect(prompt).toContain('and 20 more not listed')
  })

  it('sends no target block when the window was never scanned', () => {
    expect(classifyPrompt(base)).not.toContain('<targets')
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

/**
 * The conversation, for reading follow-ups against.
 *
 * "And what about Priya" is not a question about anything on screen and not an
 * instruction about any text, so every rule in this file read it as a message
 * to type — the right reading of that sentence alone, and the wrong one of that
 * sentence after "what did Anil say about the terms doc".
 */
describe('renderRecent', () => {
  it('says what was asked, where, and what came back', () => {
    const block = renderRecent([
      {
        said: 'what did Anil say about the terms doc',
        route: 'navigate',
        app: 'Slack',
        outcome: 'The redlines are with legal.',
        at: 0
      }
    ])
    expect(block).toContain('<recent>')
    expect(block).toContain('“what did Anil say about the terms doc”')
    expect(block).toContain('in Slack')
    expect(block).toContain('navigate')
    expect(block).toContain('The redlines are with legal.')
  })

  /**
   * A turn the user has already spoken over. Said rather than dropped, because
   * "I asked this and it has not come back" is exactly the situation a
   * follow-up arrives in.
   */
  it('marks a turn that has not finished', () => {
    const block = renderRecent([
      { said: 'what did Anil say', route: 'navigate', app: 'Slack', outcome: null, at: 0 }
    ])
    expect(block).toContain('still going')
  })

  it('renders nothing at all when there is nothing to say', () => {
    expect(renderRecent([])).toBeNull()
    expect(renderRecent(null)).toBeNull()
    expect(renderRecent(undefined)).toBeNull()
  })

  // Before the screen and the field: "is this a follow-up?" is answered from the
  // conversation, and only if the answer is no does the window become evidence.
  it('goes into the prompt ahead of the window', () => {
    const prompt = classifyPrompt({
      transcript: 'and what about Priya',
      app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
      selection: null,
      fieldText: 'sorry I was late',
      fieldTruncated: false,
      recent: [
        {
          said: 'what did Anil say about the terms doc',
          route: 'navigate',
          app: 'Slack',
          outcome: 'The redlines are with legal.',
          at: 0
        }
      ]
    })
    expect(prompt.indexOf('<recent>')).toBeGreaterThan(prompt.indexOf('<said>'))
    expect(prompt.indexOf('<recent>')).toBeLessThan(prompt.indexOf('<field'))
  })

  it('is absent from a prompt with no history, so nothing changes for the first thing said', () => {
    const prompt = classifyPrompt({
      transcript: 'make this crisp',
      app: null,
      selection: null,
      fieldText: 'sorry I was late',
      fieldTruncated: false
    })
    expect(prompt).not.toContain('<recent>')
  })
})
