import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../services/sidecar'
import { CONTEXT_CHARS, captureContext, isExcluded } from './context'

const SLACK = { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 7 }
const THREAD = [
  'Priya Sharma  14:02',
  'can you confirm the redlines by EOD?',
  'You  14:05',
  'sorry, I was slow — will do'
]

const temporary: string[] = []
function pretendCapture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mull-context-test-'))
  const path = join(dir, 'shot.jpg')
  writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))
  temporary.push(dir)
  return path
}

afterEach(() => {
  while (temporary.length > 0) {
    const dir = temporary.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('captureContext — what Mull is allowed to look at', () => {
  it('reads the window when the user has allowed it', async () => {
    const sidecar = new FakeSidecar({ accessibility: true, app: SLACK, context: THREAD })
    const context = await captureContext({ sidecar, mode: 'text' })

    expect(context?.app).toEqual({ bundleId: SLACK.bundleId, name: SLACK.name })
    expect(context?.blocks.map((b) => b.text)).toEqual(THREAD)
    expect(context?.chars).toBe(THREAD.join('').length)
  })

  it('reads nothing at all when context is off', async () => {
    const sidecar = new FakeSidecar({ accessibility: true, app: SLACK, context: THREAD })
    expect(await captureContext({ sidecar, mode: 'off' })).toBeNull()
  })

  /**
   * The refusal that must never be a setting. An app Mull will not type into is
   * an app it has no business reading, and 1Password's search box is not a
   * place for a transcript in either direction.
   */
  it('never reads a credential app, whatever the setting says', async () => {
    const sidecar = new FakeSidecar({
      accessibility: true,
      app: { bundleId: 'com.1password.1password', name: '1Password', pid: 9 },
      context: ['Personal vault', 'AWS root — production']
    })
    expect(await captureContext({ sidecar, mode: 'text+screen' })).toBeNull()
  })

  it('honours the user’s own exclusion list', async () => {
    const sidecar = new FakeSidecar({ accessibility: true, app: SLACK, context: THREAD })
    const context = await captureContext({
      sidecar,
      mode: 'text',
      excluded: [SLACK.bundleId]
    })
    expect(context).toBeNull()
  })

  /** Reading a password field is its own harm, quite apart from typing in one. */
  it('reads nothing while secure input is on', async () => {
    const sidecar = new FakeSidecar({
      accessibility: true,
      secureInput: true,
      app: SLACK,
      context: THREAD
    })
    expect(await captureContext({ sidecar, mode: 'text' })).toBeNull()
  })

  it('reads nothing without Accessibility', async () => {
    const sidecar = new FakeSidecar({ accessibility: false, app: SLACK, context: THREAD })
    expect(await captureContext({ sidecar, mode: 'text' })).toBeNull()
  })
})

describe('captureContext — the picture', () => {
  it('is not asked for in text mode', async () => {
    const sidecar = new FakeSidecar({
      accessibility: true,
      app: SLACK,
      context: THREAD,
      screenshotPath: pretendCapture()
    })
    const context = await captureContext({ sidecar, mode: 'text' })
    expect(context?.image).toBeNull()
    expect(context?.imageReason).toBe('not-requested')
  })

  /**
   * The sidecar writes a JPEG into the temp directory and nothing else comes
   * back for it. A folder slowly filling with photographs of someone's screen
   * is exactly what this app must not leave behind.
   */
  it('is read in, and the file on disk is deleted', async () => {
    const path = pretendCapture()
    const sidecar = new FakeSidecar({
      accessibility: true,
      app: SLACK,
      context: THREAD,
      screenshotPath: path
    })

    const context = await captureContext({ sidecar, mode: 'text+screen' })

    expect(context?.image?.mediaType).toBe('image/jpeg')
    expect(context?.image?.dataBase64).toBe('/9j/4AAQ')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(existsSync(path)).toBe(false)
  })

  it('says why there is no picture rather than just not having one', async () => {
    const sidecar = new FakeSidecar({ accessibility: true, app: SLACK, context: THREAD })
    const context = await captureContext({ sidecar, mode: 'text+screen' })
    expect(context?.image).toBeNull()
    // Actionable: this is the one the settings pane turns into "grant Screen
    // Recording", rather than a silent absence the user cannot explain.
    expect(context?.imageReason).toBe('no-screen-recording')
  })
})

describe('captureContext — budgets', () => {
  it('keeps the end of a long window, not the beginning', async () => {
    // A conversation's newest messages are what an instruction is about; the
    // oldest lines are the ones to lose.
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`)
    const sidecar = new FakeSidecar({ accessibility: true, app: SLACK, context: long })

    const context = await captureContext({ sidecar, mode: 'text' })

    expect(context?.chars).toBeLessThanOrEqual(CONTEXT_CHARS)
    expect(context?.truncated).toBe(true)
    expect(context?.blocks.at(-1)?.text).toContain('line 399')
  })

  it('reports truncation the sidecar itself hit', async () => {
    const sidecar = new FakeSidecar({
      accessibility: true,
      app: SLACK,
      context: THREAD,
      contextStoppedBy: 'deadline'
    })
    expect((await captureContext({ sidecar, mode: 'text' }))?.truncated).toBe(true)
  })
})

describe('isExcluded', () => {
  it('refuses every known credential app', () => {
    expect(isExcluded('com.1password.1password')).toBe(true)
    expect(isExcluded('com.bitwarden.desktop')).toBe(true)
    expect(isExcluded('com.apple.keychainaccess')).toBe(true)
  })

  it('allows an ordinary app', () => {
    expect(isExcluded('com.tinyspeck.slackmacgap')).toBe(false)
  })
})

describe('captureContext — a window still building its accessibility tree', () => {
  /**
   * The Slack bug, as a test. An Electron app has no accessibility tree until
   * something asks for one, and Chromium then builds it asynchronously — so the
   * first read of a cold app comes back with the window title and nothing else.
   * Reporting that as "this window is empty" is how Mull ended up composing a
   * reply to a conversation it could not see.
   */
  it('asks again rather than reporting an empty window', async () => {
    const sidecar = new FakeSidecar({
      accessibility: true,
      app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 7 },
      context: ['Priya: any word on the redlines?', 'Dev: legal has it until Thursday'],
      contextStoppedBy: 'tree-warming'
    })

    const context = await captureContext({ sidecar, mode: 'text' })

    expect(context).not.toBeNull()
    expect(context?.blocks.length).toBe(2)
    expect(context?.chars).toBeGreaterThan(0)
  })

  it('gives up honestly when the tree never arrives', async () => {
    const sidecar = new FakeSidecar({
      accessibility: true,
      app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 7 },
      context: ['Priya: any word on the redlines?'],
      contextStoppedBy: 'tree-warming'
    })
    // Never finishes warming.
    Object.defineProperty(sidecar, 'treeWarmed', { get: () => false, set: () => {} })

    const context = await captureContext({ sidecar, mode: 'text' })

    // An empty window, said plainly — not a wrong one, and not a hang.
    expect(context?.blocks).toEqual([])
    expect(context?.truncated).toBe(true)
  })
})
