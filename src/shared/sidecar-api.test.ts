import { describe, expect, it } from 'vitest'
import {
  CheckPermissionsResultSchema,
  InsertTextParamsSchema,
  InsertTextResultSchema,
  FocusedElementParamsSchema,
  ReplaceRangeParamsSchema,
  SidecarMethods,
  SidecarNotifications,
  WindowContextParamsSchema,
  WindowContextResultSchema,
  UiTargetsResultSchema,
  SIDECAR_PROTOCOL_VERSION
} from './sidecar-api'

describe('sidecar-api zod contract', () => {
  it('round-trips insertText params through parse (ndjson-style)', () => {
    const params = { text: 'hello from mull', strategy: 'paste' as const }
    // simulate the wire: serialize one ndjson line, parse it back, validate
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'insertText', params })
    const wire = JSON.parse(line) as { params: unknown }
    const parsed = InsertTextParamsSchema.parse(wire.params)
    expect(parsed).toEqual(params)
  })

  it('validates results and rejects bad strategies', () => {
    const result = { inserted: true, strategyUsed: 'ax', reason: null, verified: true, caret: 42 }
    expect(InsertTextResultSchema.parse(result)).toEqual(result)
    expect(() => InsertTextParamsSchema.parse({ text: 'x', strategy: 'osascript' })).toThrow()
  })

  it('requires the honesty fields — a result may not just omit `verified`', () => {
    // Nullable, not optional: a sidecar that has nothing to say about whether
    // the text landed must say so explicitly rather than leaving the key out.
    expect(() =>
      InsertTextResultSchema.parse({ inserted: true, strategyUsed: 'paste', reason: null })
    ).toThrow()
    expect(
      InsertTextResultSchema.parse({
        inserted: true,
        strategyUsed: 'paste',
        reason: null,
        verified: null,
        caret: null
      }).verified
    ).toBeNull()
  })

  it('replaceRange carries the expectation that guards undo', () => {
    const parsed = ReplaceRangeParamsSchema.parse({
      start: 10,
      length: 5,
      text: '',
      expect: 'hello'
    })
    expect(parsed.expect).toBe('hello')
    expect(() => ReplaceRangeParamsSchema.parse({ start: -1, length: 5, text: '' })).toThrow()
  })

  it('windowContext bounds what may be asked of another app', () => {
    // Both ceilings exist because every attribute read is a synchronous message
    // into someone else's process. A caller cannot ask for an unbounded walk.
    expect(() => WindowContextParamsSchema.parse({ maxChars: 100_000 })).toThrow()
    expect(() => WindowContextParamsSchema.parse({ deadlineMs: 60_000 })).toThrow()
    expect(WindowContextParamsSchema.parse({}).screenshot).toBeUndefined()
  })

  it('windowContext says why there is no picture, not just that there isn’t one', () => {
    const result = WindowContextResultSchema.parse({
      app: null,
      windowTitle: '#terms-doc',
      blocks: [
        { role: 'AXStaticText', text: 'by EOD?', label: null, focused: false, selected: false },
        { role: 'AXTextArea', text: '', label: 'Message', focused: true, selected: false }
      ],
      truncated: false,
      stoppedBy: 'complete',
      harvestMs: 13,
      screenshot: null,
      screenshotReason: 'no-screen-recording'
    })
    expect(result.screenshot).toBeNull()
    expect(result.screenshotReason).toBe('no-screen-recording')
    // The empty focused block survives parsing: an empty composer is not
    // nothing, it is where a reply goes.
    expect(result.blocks[1]).toMatchObject({ text: '', focused: true })
  })

  it('checkPermissions gains screenRecording without breaking an older answer', () => {
    const old = CheckPermissionsResultSchema.parse({ accessibility: true, inputMonitoring: true })
    expect(old.screenRecording).toBe(false)
  })

  it('applies defaults (focusedElement contextBytes = ±2KB)', () => {
    expect(FocusedElementParamsSchema.parse({})).toEqual({ contextBytes: 2048 })
  })

  it('exposes every contract method with params+result schemas', () => {
    const methods = Object.keys(SidecarMethods)
    expect(methods).toEqual([
      'init',
      'checkPermissions',
      'promptAccessibility',
      'frontmostApp',
      'focusedElement',
      'selectedText',
      'windowContext',
      'uiTargets',
      'promptScreenRecording',
      'insertText',
      'replaceSelection',
      'replaceRange',
      'secureInputState',
      'activateApp',
      'keyChord',
      'startHotkeyTap',
      'stopHotkeyTap'
    ])
    // Bumped whenever a shape changes; the sidecar's `init` refuses a mismatch.
    expect(SIDECAR_PROTOCOL_VERSION).toBe(7)
  })
})

/**
 * The target list is the model's whole vocabulary for acting on a window, so
 * the contract has to make two things impossible rather than merely unlikely.
 */
describe('uiTargets', () => {
  const target = {
    index: 0,
    role: 'AXRow',
    subrole: null,
    title: 'Priya Sharma',
    help: null,
    value: null,
    frame: { x: 0, y: 120, width: 260, height: 32 },
    actions: ['AXPress'],
    enabled: true,
    focused: false,
    kind: 'press'
  }

  it('parses a scan off the wire', () => {
    const parsed = UiTargetsResultSchema.parse({
      app: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 900 },
      windowTitle: 'Slack',
      harvestId: 'scan-3',
      targets: [target],
      truncated: false,
      stoppedBy: 'complete',
      scanMs: 62
    })
    expect(parsed.targets[0]?.title).toBe('Priya Sharma')
    expect(parsed.harvestId).toBe('scan-3')
  })

  /**
   * There are exactly two kinds and they are not interchangeable. `press` is
   * one event in a place the user can see; `type` puts a string somewhere that
   * might be a composer. A third kind arriving off the wire — or a typo for one
   * of these two — must fail here rather than be acted on.
   */
  it('admits no kind but press and type', () => {
    expect(() =>
      UiTargetsResultSchema.parse({
        app: null,
        windowTitle: null,
        harvestId: 'scan-1',
        targets: [{ ...target, kind: 'send' }],
        truncated: false,
        stoppedBy: 'complete',
        scanMs: 1
      })
    ).toThrow()
  })

  /**
   * An element that reports no rectangle says so. Defaulting it to the origin
   * would put an invisible control at the top-left corner of the screenshot the
   * model is lining this list up against, which is worse than absent.
   */
  it('keeps an unknown frame null rather than inventing one', () => {
    const parsed = UiTargetsResultSchema.parse({
      app: null,
      windowTitle: null,
      harvestId: 'scan-1',
      targets: [{ ...target, frame: null }],
      truncated: false,
      stoppedBy: 'complete',
      scanMs: 1
    })
    expect(parsed.targets[0]?.frame).toBeNull()
  })
})

describe('notifications', () => {
  it('validates the hotkey notification the event tap sends', () => {
    expect(SidecarNotifications.hotkey.parse({ phase: 'down', chord: 'opt-space' })).toEqual({
      phase: 'down',
      chord: 'opt-space'
    })
    expect(SidecarNotifications.hotkey.safeParse({ phase: 'sideways' }).success).toBe(false)
    expect(
      SidecarNotifications.hotkey.safeParse({ phase: 'up', chord: 'caps-lock' }).success
    ).toBe(false)
  })

  it('is a closed set — an unknown notification has no schema to hide behind', () => {
    expect(Object.keys(SidecarNotifications)).toEqual(['hotkey'])
  })
})
