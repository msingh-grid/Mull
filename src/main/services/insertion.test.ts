import { describe, expect, it } from 'vitest'
import { FakeSidecar } from './sidecar'
import { InsertionService } from './insertion'

const TEXTEDIT = { bundleId: 'com.apple.TextEdit', name: 'TextEdit' }
const SLACK = { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' }

describe('InsertionService', () => {
  it('uses the first strategy that works and reports which', async () => {
    const sidecar = new FakeSidecar({ accessibility: true })
    const result = await new InsertionService({ sidecar }).insert('hello', TEXTEDIT)

    expect(result.inserted).toBe(true)
    expect(result.strategyUsed).toBe('ax')
    expect(result.attempts).toHaveLength(1)
    expect(sidecar.text).toBe('hello')
  })

  it('falls through to paste when the app has no AX text', async () => {
    const sidecar = new FakeSidecar({ accessibility: true, supports: { ax: false } })
    const result = await new InsertionService({ sidecar }).insert('hello', TEXTEDIT)

    expect(result.inserted).toBe(true)
    expect(result.strategyUsed).toBe('paste')
    expect(result.attempts.map((a) => a.strategy)).toEqual(['ax', 'paste'])
    expect(result.attempts[0]?.reason).toBe('ax-unsupported')
  })

  it('treats an unverifiable AX write as a failure and keeps walking', async () => {
    // The app accepts the write and drops it. Trusting the return code here
    // would lose the user's sentence silently.
    const sidecar = new FakeSidecar({ accessibility: true, axLies: true })
    const result = await new InsertionService({ sidecar }).insert('hello', TEXTEDIT)

    expect(result.inserted).toBe(true)
    expect(result.strategyUsed).toBe('paste')
    expect(result.attempts[0]).toMatchObject({ strategy: 'ax', ok: false, verified: false })
  })

  it('sends the app-specific settle delay with the paste', async () => {
    const sidecar = new FakeSidecar({ accessibility: true })
    await new InsertionService({ sidecar }).insert('hi', SLACK)
    expect(sidecar.calls[0]).toMatchObject({ strategy: 'paste', settleMs: 280 })
  })

  it('stops the walk on secure input instead of trying the next strategy', async () => {
    const sidecar = new FakeSidecar({ accessibility: true, secureInput: true })
    const result = await new InsertionService({ sidecar }).insert('hello', TEXTEDIT)

    expect(result.inserted).toBe(false)
    expect(result.reason).toBe('secure-input')
    expect(result.attempts).toHaveLength(1)
    expect(sidecar.insertions).toHaveLength(0)
  })

  it('never writes into a credential app, permissions notwithstanding', async () => {
    const sidecar = new FakeSidecar({ accessibility: true })
    const result = await new InsertionService({ sidecar }).insert('hunter2', {
      bundleId: 'com.1password.1password',
      name: '1Password'
    })

    expect(result.inserted).toBe(false)
    expect(result.reason).toBe('refused-credential-app')
    expect(sidecar.calls).toHaveLength(0)
  })

  it('remembers that an app has no AX text and stops paying for the attempt', async () => {
    const sidecar = new FakeSidecar({ accessibility: true, supports: { ax: false } })
    const service = new InsertionService({ sidecar })

    await service.insert('first', TEXTEDIT)
    sidecar.calls.length = 0
    await service.insert('second', TEXTEDIT)

    expect(sidecar.calls.map((c) => c.strategy)).toEqual(['paste'])
    expect(service.planFor(TEXTEDIT).chain).toEqual(['paste'])
    expect(service.learned()).toEqual([
      { bundleId: TEXTEDIT.bundleId, unsupported: ['ax'] }
    ])
  })

  it('keeps the demotion per app', async () => {
    const sidecar = new FakeSidecar({ accessibility: true, supports: { ax: false } })
    const service = new InsertionService({ sidecar })
    await service.insert('x', TEXTEDIT)

    expect(service.planFor({ bundleId: 'com.apple.Notes', name: 'Notes' }).chain).toEqual([
      'ax',
      'paste'
    ])
  })

  it('reports the last reason when every strategy is refused', async () => {
    const sidecar = new FakeSidecar({ accessibility: true, insertFails: 'cgevent-post-failed' })
    const result = await new InsertionService({ sidecar }).insert('hello', TEXTEDIT)

    expect(result.inserted).toBe(false)
    expect(result.reason).toBe('cgevent-post-failed')
    expect(result.attempts).toHaveLength(2)
  })

  it('survives a sidecar that throws mid-chain', async () => {
    const sidecar = new FakeSidecar({ accessibility: true })
    sidecar.insertText = async () => {
      throw new Error('sidecar: disposed')
    }
    const result = await new InsertionService({ sidecar }).insert('hello', TEXTEDIT)

    expect(result.inserted).toBe(false)
    expect(result.attempts[0]?.reason).toBe('sidecar: disposed')
  })

  it('carries `verified: null` through rather than inventing confidence', async () => {
    const sidecar = new FakeSidecar({
      accessibility: true,
      supports: { ax: false },
      unreadable: true
    })
    const result = await new InsertionService({ sidecar }).insert('hello', TEXTEDIT)

    expect(result.inserted).toBe(true)
    expect(result.verified).toBeNull()
    expect(result.caret).toBeNull()
  })

  it('replaceSelection returns what it overwrote', async () => {
    const sidecar = new FakeSidecar({
      accessibility: true,
      text: 'keep this',
      caret: 5,
      selectionLength: 4
    })
    const result = await new InsertionService({ sidecar }).replaceSelection('that', TEXTEDIT)

    expect(result.inserted).toBe(true)
    expect(result.replacedText).toBe('this')
    expect(sidecar.text).toBe('keep that')
  })
})
