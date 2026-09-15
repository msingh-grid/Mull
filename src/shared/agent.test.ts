import { describe, expect, it } from 'vitest'
import {
  AGENT_TOOLS,
  DoneInputSchema,
  FindInputSchema,
  LookInputSchema,
  NoteInputSchema,
  PressInputSchema,
  SetTextInputSchema,
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

describe('setText', () => {
  it('takes an index, the title it was shown with, and the text', () => {
    expect(
      SetTextInputSchema.safeParse({ index: 3, expectTitle: 'Title', text: 'Q3 review' }).success
    ).toBe(true)
  })

  // Same read-back discipline as a press, for the same reason: a stale index
  // must refuse rather than write into whatever moved into that slot.
  it('refuses a write that does not say what it thinks it is writing into', () => {
    expect(SetTextInputSchema.safeParse({ index: 3, text: 'Q3 review' }).success).toBe(false)
  })

  // Empty is meaningful — it is how you clear a field.
  it('allows clearing a field', () => {
    expect(SetTextInputSchema.safeParse({ index: 0, expectTitle: 'Title', text: '' }).success).toBe(
      true
    )
  })

  it('refuses a document', () => {
    expect(
      SetTextInputSchema.safeParse({ index: 0, expectTitle: 'Title', text: 'x'.repeat(2_001) })
        .success
    ).toBe(false)
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
  it('names six tools and no more', () => {
    expect([...AGENT_TOOLS]).toEqual(['look', 'find', 'press', 'setText', 'note', 'done'])
  })

  /**
   * The structural safety argument, asserted where anyone widening it will trip
   * over it.
   *
   * **No verb carries a keystroke, and no verb leaves the frontmost window.** A
   * model that wanted to send a message could not describe the act — which holds
   * whatever it was shown on screen, and does not depend on it being well
   * behaved.
   *
   * This used to assert "nothing writes text" as well. `setText` writes text,
   * and that clause came out deliberately: typing is visible and reversible, and
   * what makes it safe is precisely that the keystroke closure below did *not*
   * move. A future change that makes this fail is the test working — the
   * widening wants its own gate in `canUseTool` rather than a quiet edit here.
   */
  it('carries nothing that presses a key or leaves the window', () => {
    // The actuator, and the ways out of this window.
    const forbidden = ['key', 'modifiers', 'chord', 'send', 'submit', 'url', 'bundleId', 'window']
    for (const [tool, schema] of Object.entries(SHAPES)) {
      const fields = Object.keys(schema.shape)
      for (const field of forbidden) {
        expect(fields, `${tool} must not carry "${field}"`).not.toContain(field)
      }
    }
  })

  /**
   * Which tools may carry text, and why the list is exactly this long.
   *
   * `setText` puts it in a field; `note` puts it on the card and nowhere else.
   * A third would be a new way for words to reach somebody's app, and should
   * arrive with an argument rather than by addition.
   */
  it('lets exactly two tools carry text, for two different reasons', () => {
    const carriers = Object.entries(SHAPES)
      .filter(([, schema]) => Object.keys(schema.shape).includes('text'))
      .map(([name]) => name)
    expect(carriers).toEqual(['setText', 'note'])
  })
})

/** Every tool's input shape, so the assertions above cannot quietly miss one. */
const SHAPES = {
  look: LookInputSchema,
  find: FindInputSchema,
  press: PressInputSchema,
  setText: SetTextInputSchema,
  note: NoteInputSchema,
  done: DoneInputSchema
}

describe('toolName', () => {
  // What `canUseTool` is handed, and therefore what the stop has to match on.
  it('is the full MCP name, not the bare one', () => {
    expect(toolName('press')).toBe('mcp__mull__press')
  })
})
