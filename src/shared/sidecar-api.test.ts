import { describe, expect, it } from 'vitest'
import {
  InsertTextParamsSchema,
  InsertTextResultSchema,
  FocusedElementParamsSchema,
  ReplaceRangeParamsSchema,
  SidecarMethods,
  SidecarNotifications,
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
    expect(SIDECAR_PROTOCOL_VERSION).toBe(4)
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
