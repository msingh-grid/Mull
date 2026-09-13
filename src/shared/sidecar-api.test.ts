import { describe, expect, it } from 'vitest'
import {
  InsertTextParamsSchema,
  InsertTextResultSchema,
  FocusedElementParamsSchema,
  SidecarMethods,
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
    expect(
      InsertTextResultSchema.parse({ inserted: true, strategyUsed: 'ax', reason: null })
    ).toEqual({ inserted: true, strategyUsed: 'ax', reason: null })
    expect(() => InsertTextParamsSchema.parse({ text: 'x', strategy: 'osascript' })).toThrow()
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
      'insertText',
      'replaceSelection',
      'secureInputState',
      'activateApp',
      'keyChord'
    ])
    expect(SIDECAR_PROTOCOL_VERSION).toBe(1)
  })
})
