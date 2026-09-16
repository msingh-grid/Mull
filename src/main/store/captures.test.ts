import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ScreenContext } from '@shared/context'
import { CaptureStore } from './captures'

const context = (patch: Partial<ScreenContext> = {}): ScreenContext => ({
  app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
  windowTitle: 'Anil Turaga (DM) - Slack',
  blocks: [
    { role: 'AXGroup', text: 'Anil: are you in office?', label: null, focused: false, selected: false }
  ],
  truncated: false,
  image: null,
  imageReason: 'no-screen-recording',
  chars: 24,
  harvestMs: 42,
  ...patch
})

const store = (keep?: number): { dir: string; captures: CaptureStore } => {
  const dir = mkdtempSync(join(tmpdir(), 'mull-captures-'))
  return { dir, captures: new CaptureStore({ dir, keep }) }
}

describe('CaptureStore', () => {
  /**
   * The receipt has to be the string the model was given. A re-render, or a
   * fresh read, would describe something that never happened.
   */
  it('keeps the transcript as it was rendered into the prompt', () => {
    const { captures } = store()
    const record = captures.save('e1', context())
    expect(record?.text).toContain('Anil: are you in office?')
    expect(record?.text).toContain('<screen')
    expect(record).toMatchObject({ blocks: 1, chars: 24, harvestMs: 42 })
  })

  /**
   * The whole reason this exists. "Mull took no screenshot" and "Mull is not
   * allowed to take screenshots" look identical in an empty box, and only one
   * of them is the user's to fix.
   */
  it('carries why there was no picture, not just that there wasn’t one', () => {
    const { captures } = store()
    expect(captures.save('e1', context())?.imageReason).toBe('no-screen-recording')
    expect(captures.save('e2', context({ imageReason: 'not-requested' }))?.imageReason).toBe(
      'not-requested'
    )
  })

  it('writes the picture beside the row it belongs to', () => {
    const { dir, captures } = store()
    const record = captures.save(
      'e9',
      context({
        image: {
          mediaType: 'image/jpeg',
          dataBase64: Buffer.from('not really a jpeg').toString('base64'),
          width: 1400,
          height: 900,
          bytes: 17
        },
        imageReason: null
      })
    )
    expect(record?.imageFile).toBe('e9.jpg')
    expect(readdirSync(dir)).toContain('e9.jpg')
    expect(captures.path('e9.jpg')).toBe(join(dir, 'e9.jpg'))
  })

  /** A path out of the captures directory is not a capture. */
  it('refuses to resolve anything but a bare filename', () => {
    const { captures } = store()
    expect(captures.path('../settings.json')).toBeNull()
    expect(captures.path('nested/thing.jpg')).toBeNull()
    expect(captures.path(null)).toBeNull()
  })

  it('says nothing rather than guessing when the picture has been pruned', () => {
    const { captures } = store()
    expect(captures.path('gone.jpg')).toBeNull()
  })

  /**
   * Each of these is a photograph of the user's screen. Keeping fewer is the
   * better default in both directions — disk, and what is lying around.
   */
  it('keeps only the most recent few pictures', () => {
    const { dir, captures } = store(2)
    for (const id of ['a', 'b', 'c']) {
      writeFileSync(join(dir, `${id}.jpg`), 'x')
      captures.save(id, context({
        image: { mediaType: 'image/jpeg', dataBase64: 'eA==', width: 1, height: 1, bytes: 1 },
        imageReason: null
      }))
    }
    expect(readdirSync(dir).filter((n) => n.endsWith('.jpg')).length).toBeLessThanOrEqual(2)
  })

  it('is a no-op when there was nothing to see', () => {
    const { captures } = store()
    expect(captures.save('e1', null)).toBeNull()
  })
})
