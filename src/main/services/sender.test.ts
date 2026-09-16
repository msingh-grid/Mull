import { describe, expect, it } from 'vitest'
import { JournalStore } from '../store/journal'
import { memoryDatabase } from '../store/journal.test-helpers'
import { FakeSidecar, type FakeSidecarOptions } from './sidecar'
import { sendChord, type SendChord } from './send-table'
import { describeSend, Sender } from './sender'

const SLACK = { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' }
const TEXT = 'I will get the code done in 2 days.'
const RETURN = sendChord(SLACK.bundleId) as SendChord

function setup(overrides: FakeSidecarOptions = {}): {
  sender: Sender
  sidecar: FakeSidecar
  journal: JournalStore
} {
  const sidecar = new FakeSidecar({
    accessibility: true,
    app: { ...SLACK, pid: 7 },
    text: TEXT,
    caret: TEXT.length,
    ...overrides
  })
  const journal = new JournalStore(memoryDatabase())
  return { sender: new Sender({ sidecar, journal, sleep: async () => {} }), sidecar, journal }
}

const request = {
  app: SLACK,
  chord: RETURN,
  text: TEXT,
  transcript: 'send the message'
}

describe('Sender', () => {
  it('posts the app’s chord and confirms from an emptied composer', async () => {
    const { sender, sidecar, journal } = setup({ chordEffect: 'clears' })
    const outcome = await sender.send(request)

    expect(outcome).toEqual({ sent: true })
    expect(sidecar.chords).toEqual([{ key: 'return', modifiers: [] }])
    expect(journal.recent(1)[0]).toMatchObject({
      status: 'applied',
      summary: 'Sent · Slack',
      verified: true,
      undoable: false
    })
  })

  /**
   * The read-back, and the reason this is not a fire-and-forget keystroke.
   * `keyChord` reports that the window server accepted the event, which is a
   * different claim entirely from "the message went".
   */
  it('calls it unsent when the composer still holds the text', async () => {
    const { sender, journal } = setup({ chordEffect: 'ignores' })
    const outcome = await sender.send(request)

    expect(outcome).toMatchObject({ sent: false, reason: 'unchanged' })
    expect(journal.recent(1)[0]).toMatchObject({ status: 'failed', verified: false })
  })

  /**
   * `unknown` is a real answer, not a failure of nerve: Mail's ⌘⇧D closes the
   * compose window, so there is frequently nothing left to read. Claiming
   * either way would be a guess, and both guesses cost a real message.
   */
  it('says it cannot tell when there is no composer left to read', async () => {
    const { sender, journal } = setup({ chordEffect: 'clears', noFocus: true })
    const outcome = await sender.send(request)

    expect(outcome).toEqual({ sent: 'unknown' })
    expect(describeSend(outcome, 'Mail')).toContain('couldn’t confirm')
    // Recorded as applied — something probably happened — but unverified, so
    // `undoable` stays false and the summary says so out loud.
    expect(journal.recent(1)[0]).toMatchObject({
      status: 'applied',
      verified: null,
      summary: 'Sent · Slack — unconfirmed'
    })
  })

  it('refuses to press anything in the wrong app', async () => {
    const { sender, sidecar } = setup({ chordEffect: 'clears' })
    const outcome = await sender.send({
      ...request,
      app: { bundleId: 'com.apple.TextEdit', name: 'TextEdit' }
    })

    expect(outcome).toMatchObject({ sent: false, reason: 'different-app' })
    expect(sidecar.chords).toEqual([])
  })

  it('reports a chord the window server would not take', async () => {
    const { sender } = setup({ chordEffect: 'refuses' })
    const outcome = await sender.send(request)
    expect(outcome).toMatchObject({ sent: false, reason: 'chord-refused' })
  })

  it('refuses while secure input is on, like every other write verb', async () => {
    const { sender } = setup({ secureInput: true })
    const outcome = await sender.send(request)
    expect(outcome).toMatchObject({ sent: false, reason: 'chord-refused' })
  })
})

describe('describeSend', () => {
  it('never claims more than it saw', () => {
    expect(describeSend({ sent: true }, 'Slack')).toBe('Sent in Slack.')
    expect(describeSend({ sent: 'unknown' }, 'Mail')).not.toContain('Sent in')
    expect(describeSend({ sent: false, reason: 'unchanged', detail: null }, 'Slack')).toContain(
      'press send yourself'
    )
  })
})
