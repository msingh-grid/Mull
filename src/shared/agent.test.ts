import { describe, expect, it } from 'vitest'
import {
  AGENT_TOOLS,
  DoneInputSchema,
  FindInputSchema,
  LookInputSchema,
  NoteInputSchema,
  PressInputSchema,
  toolName
} from './agent'

/**
 * The vocabulary, and the fact that it is closed.
 *
 * Most of these are ordinary schema tests. The last describe block is not: it
 * is the structural half of the safety argument written down as an assertion,
 * so that widening the loop's reach becomes a deliberate act with a failing
 * test in front of it rather than a field somebody adds in passing.
 */

describe('look', () => {
  it('takes one of the three things a window can be read as', () => {
    for (const want of ['text', 'targets', 'both'] as const) {
      expect(LookInputSchema.safeParse({ want }).success).toBe(true)
    }
  })

  it('refuses anything else', () => {
    expect(LookInputSchema.safeParse({ want: 'screenshot' }).success).toBe(false)
    expect(LookInputSchema.safeParse({}).success).toBe(false)
  })
})

describe('find', () => {
  it('takes words, and optionally a kind', () => {
    expect(FindInputSchema.safeParse({ query: 'Anil' }).success).toBe(true)
    expect(FindInputSchema.safeParse({ query: 'search', kind: 'type' }).success).toBe(true)
  })

  it('refuses an empty query and a query the size of a document', () => {
    expect(FindInputSchema.safeParse({ query: '' }).success).toBe(false)
    expect(FindInputSchema.safeParse({ query: 'x'.repeat(121) }).success).toBe(false)
  })

  it('knows only the two kinds a scan can hold', () => {
    expect(FindInputSchema.safeParse({ query: 'a', kind: 'link' }).success).toBe(false)
  })
})

describe('press', () => {
  it('takes an index out of the scan, and the title it was shown with', () => {
    expect(PressInputSchema.safeParse({ index: 0, expectTitle: 'Search' }).success).toBe(true)
  })

  /**
   * The read-back is not optional, because it is the whole reason a stale index
   * refuses instead of landing on whatever moved into that slot.
   */
  it('refuses a press that does not say what it thinks it is pressing', () => {
    expect(PressInputSchema.safeParse({ index: 0 }).success).toBe(false)
  })

  it('refuses an index that is not one', () => {
    expect(PressInputSchema.safeParse({ index: -1, expectTitle: 'x' }).success).toBe(false)
    expect(PressInputSchema.safeParse({ index: 1.5, expectTitle: 'x' }).success).toBe(false)
  })
})

describe('note', () => {
  it('is one short clause, not an essay', () => {
    expect(NoteInputSchema.safeParse({ text: 'looking for Anil in the sidebar' }).success).toBe(true)
    expect(NoteInputSchema.safeParse({ text: '' }).success).toBe(false)
    expect(NoteInputSchema.safeParse({ text: 'x'.repeat(201) }).success).toBe(false)
  })
})

describe('done', () => {
  it('says which kind of done it is', () => {
    expect(DoneInputSchema.safeParse({ found: true, because: 'the thread is open' }).success).toBe(
      true
    )
    expect(DoneInputSchema.safeParse({ found: false, because: 'no Anil anywhere' }).success).toBe(
      true
    )
  })

  /**
   * Required, unlike `NavStepSchema`'s optional one. There a missing field
   * would have failed a parse and killed a plan; here the model is told what it
   * means in the tool schema and can simply be asked again.
   */
  it('refuses to finish without saying whether it arrived', () => {
    expect(DoneInputSchema.safeParse({ because: 'done' }).success).toBe(false)
    expect(DoneInputSchema.safeParse({ found: true }).success).toBe(false)
  })
})

describe('the closure', () => {
  it('names five tools and no more', () => {
    expect([...AGENT_TOOLS]).toEqual(['look', 'find', 'press', 'note', 'done'])
  })

  /**
   * The structural safety argument, asserted.
   *
   * There is no verb that writes text, no verb that carries a keystroke, and no
   * verb that leaves the frontmost window. A model that wanted to send a message
   * could not describe the act — which holds whatever it was shown on screen,
   * and does not depend on it being well behaved.
   *
   * M-B and M-C widen this deliberately. This test is what makes "deliberately"
   * true: it fails the moment the vocabulary grows, so the widening arrives with
   * the gate it needs rather than on its own.
   */
  it('carries nothing that writes, types, sends or leaves the window', () => {
    const shapes = {
      look: LookInputSchema,
      find: FindInputSchema,
      press: PressInputSchema,
      note: NoteInputSchema,
      done: DoneInputSchema
    }
    // Everything a tool could conceivably be asked to carry in order to write,
    // press a key, or go somewhere else.
    const forbidden = ['text', 'key', 'modifiers', 'send', 'url', 'app', 'bundleId', 'window']
    for (const [tool, schema] of Object.entries(shapes)) {
      const fields = Object.keys(schema.shape)
      for (const field of forbidden) {
        // `note.text` is the one word that collides, and it goes nowhere but the
        // card — it is never typed into anything.
        if (tool === 'note' && field === 'text') continue
        expect(fields, `${tool} must not carry "${field}"`).not.toContain(field)
      }
    }
  })
})

describe('toolName', () => {
  // What `canUseTool` is handed, and therefore what the stop has to match on.
  it('is the full MCP name, not the bare one', () => {
    expect(toolName('press')).toBe('mcp__mull__press')
  })
})
