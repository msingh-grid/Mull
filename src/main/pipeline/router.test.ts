import { describe, expect, it } from 'vitest'
import { justSend, nothingToEdit, route, wantsSend } from './router'

/**
 * What is left of this file after M5b, and what is not.
 *
 * There used to be an 88-case fixture table here pitting instruction-shaped
 * sentences against dictation-shaped ones, because a regex had to tell them
 * apart on every utterance. It cannot, and the proof is in the git history:
 * "summarize this thread", "catch me up on this" and "what did they decide"
 * were all typed into a Slack composer verbatim.
 *
 * The key answers that question now — ⌥Space dictates, Fn asks — so the table
 * is gone and so are its tests. Two things still live here:
 *
 *   `justSend` / `wantsSend`  the authorisation check that keeps an
 *                             irreversible act out of the model's hands. These
 *                             run on the main path and matter most.
 *   `route`                   the degraded fallback, for when the user pressed
 *                             Fn and there is no engine to ask.
 */

const SELECTED = { hasSelection: true, hasFieldText: true }
const FIELD_ONLY = { hasSelection: false, hasFieldText: true }
const EMPTY = { hasSelection: false, hasFieldText: false }
const EMPTY_WITH_SCREEN = { hasSelection: false, hasFieldText: false, hasScreen: true }

describe('nothingToEdit', () => {
  it('is true only when there is neither a selection nor field text', () => {
    expect(nothingToEdit(EMPTY)).toBe(true)
    expect(nothingToEdit(SELECTED)).toBe(false)
    expect(nothingToEdit(FIELD_ONLY)).toBe(false)
  })
})

/**
 * The fallback picks a lane from what is on screen, never from the words —
 * language is exactly what it has no business judging. The user already said
 * this was an instruction by pressing Fn; all that is left is *which*.
 */
describe('route — the degraded fallback', () => {
  it('edits the selection when there is one', () => {
    expect(route('anything at all', SELECTED)).toEqual({
      kind: 'edit',
      instruction: 'anything at all',
      target: 'selection'
    })
  })

  it('edits the field when there is text but nothing highlighted', () => {
    expect(route('make it shorter', FIELD_ONLY)).toMatchObject({
      kind: 'edit',
      target: 'document'
    })
  })

  it('composes from the window when there is nothing to edit', () => {
    expect(route('summarize this thread', EMPTY_WITH_SCREEN)).toEqual({
      kind: 'compose',
      instruction: 'summarize this thread'
    })
  })

  /**
   * Nothing selected, nothing in the box, nothing readable on screen. There is
   * no instruction that could act on anything, so the words are typed — the
   * user said something and it must not disappear.
   */
  it('types the words when there is nothing to act on at all', () => {
    expect(route('summarize this thread', EMPTY)).toEqual({
      kind: 'dictate',
      text: 'summarize this thread'
    })
  })

  /**
   * The phrasings that used to be typed. None of them is listed anywhere now —
   * they reach a lane because of where the caret is, not because of a verb.
   */
  it('no longer depends on recognising the verb', () => {
    for (const said of [
      'summarize this thread',
      'catch me up on this',
      'what did they decide about the redlines',
      'turn this into bullet points',
      'ask her when the vendor call is'
    ]) {
      expect(route(said, EMPTY_WITH_SCREEN)).toMatchObject({ kind: 'compose' })
      expect(route(said, SELECTED)).toMatchObject({ kind: 'edit' })
    }
  })
})

describe('justSend — the only thing that can press send', () => {
  it('hears a send command with nothing else in it', () => {
    for (const said of [
      'send it',
      'send the message',
      'send',
      'just send it now',
      'go ahead and send it',
      'send that',
      'please send the reply'
    ]) {
      expect(justSend(said)).toBe(true)
    }
  })

  it('does not hear one where there is a message to write', () => {
    expect(justSend('send that I will be done in two days')).toBe(false)
    expect(justSend('send them a written message')).toBe(false)
    expect(justSend('send the deck tonight')).toBe(false)
    expect(justSend('reply to this and send it')).toBe(false)
    expect(justSend('')).toBe(false)
  })

  it('routes to send only when there is something in the box', () => {
    expect(route('send the message', FIELD_ONLY)).toEqual({ kind: 'send' })
    // An empty composer means those words could not have been about anything
    // already written, so the fallback treats them like any other instruction.
    expect(route('send the message', EMPTY)).toMatchObject({ kind: 'dictate' })
  })
})

describe('wantsSend', () => {
  it('hears the verb leading the request', () => {
    expect(wantsSend('Send that I will get the code done in 2 days.')).toEqual({
      send: true,
      without: 'Send that I will get the code done in 2 days.'
    })
    expect(wantsSend('send her a note about the delay').send).toBe(true)
    expect(wantsSend('send them a written message saying I will be late').send).toBe(true)
  })

  it('hears it tacked onto the end, and strips it from the request', () => {
    expect(wantsSend('reply saying the redlines are with legal and send it')).toEqual({
      send: true,
      without: 'reply saying the redlines are with legal'
    })
    expect(wantsSend('draft an answer declining, then send')).toMatchObject({ send: true })
    expect(wantsSend('make this less apologetic and send it now')).toMatchObject({
      send: true,
      without: 'make this less apologetic'
    })
  })

  it('leaves an ordinary request alone', () => {
    expect(wantsSend('summarize this thread')).toEqual({
      send: false,
      without: 'summarize this thread'
    })
    expect(wantsSend('reply to this politely')).toMatchObject({ send: false })
    expect(wantsSend('')).toMatchObject({ send: false })
  })

  /**
   * The sentences this must not hear. A false positive only costs a second
   * button on a card the user is reading — but a button that appears because
   * someone mentioned a deck is a button nobody trusts.
   */
  it('does not hear a send in speech that merely contains the word', () => {
    for (const said of [
      'and I will send the deck tonight',
      'reply saying I will send Priya the numbers',
      'tell her I will send it',
      'reply to this and send the contract over',
      'send Priya the numbers'
    ]) {
      expect(wantsSend(said).send).toBe(false)
    }
  })
})
