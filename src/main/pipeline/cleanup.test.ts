import { describe, expect, it } from 'vitest'
import { cleanTranscript, summarise } from './cleanup'

describe('cleanTranscript', () => {
  it('strips whisper non-speech annotations', () => {
    expect(cleanTranscript('[BLANK_AUDIO] hello there').text).toBe('Hello there')
    expect(cleanTranscript('(music) ship it').text).toBe('Ship it')
  })

  it('removes standalone fillers and reports them', () => {
    const result = cleanTranscript('um, send the deck uh today')
    expect(result.text).toBe('Send the deck today')
    expect(result.removedFillers).toEqual(['um', 'uh'])
  })

  it('leaves real words that merely contain a filler', () => {
    expect(cleanTranscript('I was humming a tune').text).toBe('I was humming a tune')
    expect(cleanTranscript('the number is fine').text).toBe('The number is fine')
  })

  it('tightens spacing around punctuation', () => {
    expect(cleanTranscript('hello , world . done').text).toBe('Hello, world. done')
  })

  it('capitalises the first letter without lowering anything else', () => {
    expect(cleanTranscript('nASA called').text).toBe('NASA called')
    expect(cleanTranscript('“quoted” start').text).toBe('“Quoted” start')
  })

  it('returns empty for audio that was only noise', () => {
    expect(cleanTranscript('  [BLANK_AUDIO]  ').text).toBe('')
    expect(cleanTranscript('um uh').text).toBe('')
  })

  it('collapses runs of whitespace', () => {
    expect(cleanTranscript('one\n\ttwo   three').text).toBe('One two three')
  })
})

describe('summarise', () => {
  it('passes short text through untouched', () => {
    expect(summarise('Ship it')).toBe('Ship it')
  })

  it('ellipsises long text at the limit', () => {
    const out = summarise('a'.repeat(80))
    expect(out).toHaveLength(48)
    expect(out.endsWith('…')).toBe(true)
  })
})
