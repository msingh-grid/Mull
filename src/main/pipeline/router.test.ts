import { describe, expect, it } from 'vitest'
import { looksLikeInstruction, mightBeCompose, route, worthAsking } from './router'

/**
 * The fixture table docs/PLAN.md asks for.
 *
 * More than half of it is sentences that must NOT be read as instructions,
 * because that is the failure that costs the user something: an edit-routed
 * dictation puts their sentence in a card instead of in their document. The
 * reverse — an instruction that gets typed — is visible and ⌥Z undoes it.
 *
 * Every line here is phrased the way someone would actually say it out loud.
 * When a real misroute turns up, it belongs in this table before it belongs in
 * the stoplist.
 */

/** With text selected, these are instructions about that text. */
const INSTRUCTIONS = [
  'make this crisp',
  'make this shorter',
  'make it sound less apologetic',
  'make it more direct',
  'make it into a checklist',
  'make the tone warmer',
  'tighten this up',
  'tighten it',
  'proofread',
  'proofread this',
  'rewrite this as bullet points',
  'rephrase that more formally',
  'reword it',
  'condense this to two sentences',
  'polish this',
  'tidy this up',
  'shorten this',
  'shorten it by half',
  'expand on this',
  'summarize this',
  'summarise this in one line',
  'summarize it',
  'simplify this',
  'clarify that last sentence',
  'translate this into French',
  'turn this into bullet points',
  'convert this to a numbered list',
  'fix the grammar',
  'fix the typos',
  'fix the punctuation',
  'correct the spelling',
  'soften the tone',
  'clean up the wording',
  'trim this down',
  'cut this down by half',
  'punch this up',
  // The same instructions, wrapped the way people actually speak them.
  'could you tighten this up',
  'please make this crisp',
  'hey Mull, tighten this up',
  'just make this shorter',
  "let's turn this into bullets"
]

/**
 * Said with text selected, and still just words. These are the ones that
 * matter: each is an ordinary sentence that opens with an instruction verb, or
 * carries a "this"/"it" exactly where the router looks for its object.
 */
const DICTATIONS = [
  'make sure Priya signs off',
  'make sure this gets to legal before Friday',
  'make a note of this for the retro',
  'make time for this on Thursday',
  'make it to the meeting if you can',
  'turn it off before you leave',
  'turn left at the lights and park behind the building',
  'fix the meeting to 3pm and tell Dan',
  'fix it later, we ship on Tuesday',
  "correct me if I'm wrong but the deal closed",
  'cut it short and send the deck',
  'clean the kitchen before they arrive',
  'cut the budget by ten percent this quarter',
  'trim the guest list down to twelve',
  'convert the file to PDF and email it',
  'summarise the call for me in the email below',
  'translate the contract when you have a minute',
  'expand the team next quarter if budget allows',
  'shorten the deadline to Tuesday',
  'simplify the onboarding for new hires next month',
  'correct, that is what I meant',
  'it turns out the deal closed yesterday',
  'that said, make it clear we need sign-off',
  'Following up on the terms doc, we still need your sign-off by Friday',
  'Thanks for the quick turnaround on this, it really helped',
  'I think we should turn this down and wait for the next round'
]

const SELECTED = { hasSelection: true, hasFieldText: true }
const NOTHING_TO_EDIT = { hasSelection: false, hasFieldText: false }
/** The Slack case: a composer with text in it, nothing highlighted. */
const FIELD_ONLY = { hasSelection: false, hasFieldText: true }

describe('route — with a selection', () => {
  for (const transcript of INSTRUCTIONS) {
    it(`edits: “${transcript}”`, () => {
      expect(route(transcript, SELECTED)).toEqual({
        kind: 'edit',
        instruction: transcript,
        target: 'selection'
      })
    })
  }

  for (const transcript of DICTATIONS) {
    it(`types: “${transcript}”`, () => {
      expect(route(transcript, SELECTED)).toEqual({ kind: 'dictate', text: transcript })
    })
  }

  it('types anything longer than an instruction, however it starts', () => {
    const long =
      'make this whole paragraph much shorter and also change the tone so it sounds friendlier'
    expect(route(long, SELECTED).kind).toBe('dictate')
  })

  it('types an empty transcript rather than opening an empty card', () => {
    expect(route('   ', SELECTED)).toEqual({ kind: 'dictate', text: '' })
  })
})

describe('route — with nothing to edit', () => {
  // The fast path, stated as a test: an empty field with nothing selected has
  // nothing an edit could act on, so the transcript is typed no matter how much
  // it sounds like an order. This branch returns before the rules are consulted
  // at all — and before `IntentRouter` would reach for the model.
  for (const transcript of [...INSTRUCTIONS.slice(0, 8), ...DICTATIONS.slice(0, 8)]) {
    it(`types: “${transcript}”`, () => {
      expect(route(transcript, NOTHING_TO_EDIT)).toEqual({
        kind: 'dictate',
        text: transcript
      })
    })
  }
})

describe('looksLikeInstruction', () => {
  // Used for the "select some text first" hint, which is the whole reason it
  // is a separate export: route() has already decided to type the words, and
  // this is what lets the HUD explain why.
  it('recognises an instruction even when nothing is selected', () => {
    expect(looksLikeInstruction('make this crisp')).toBe(true)
  })

  it('does not fire on ordinary speech', () => {
    expect(looksLikeInstruction('send the revised deck to Dan before lunch')).toBe(false)
  })

  it('does not fire on an empty transcript', () => {
    expect(looksLikeInstruction('')).toBe(false)
  })
})

describe('route — a field with text but no selection', () => {
  it('edits the whole field rather than requiring a selection', () => {
    expect(route('tighten this up', FIELD_ONLY)).toEqual({
      kind: 'edit',
      instruction: 'tighten this up',
      target: 'document'
    })
  })

  it('still types ordinary speech', () => {
    expect(route('make sure Priya signs off', FIELD_ONLY).kind).toBe('dictate')
  })
})

/**
 * The sentence that sent this whole design back to the drawing board.
 *
 * Said in Slack with an apologetic half-written line in the composer, M4 typed
 * it as a question. The rules now recognise it — an adjective is allowed
 * between the determiner and the noun — but the real fix is that `IntentRouter`
 * asks a model first and only falls back to these rules offline. This test is
 * here so the fallback is at least not wrong about the case we know about.
 */
describe('the sentence from docs/M4-VERIFY.md', () => {
  const SAID = 'Can you make my last message less apologetic?'

  it('is an instruction when there is something to edit', () => {
    expect(looksLikeInstruction(SAID)).toBe(true)
    expect(route(SAID, FIELD_ONLY)).toEqual({
      kind: 'edit',
      instruction: SAID,
      target: 'document'
    })
  })

  it('is still typed when the box is empty', () => {
    expect(route(SAID, NOTHING_TO_EDIT).kind).toBe('dictate')
  })

  it('recognises its relatives', () => {
    for (const said of [
      'make my last message less apologetic',
      'rewrite the previous email',
      'shorten that last paragraph',
      'fix up my note'
    ]) {
      expect(looksLikeInstruction(said), said).toBe(true)
    }
  })
})

/**
 * The compose gate (M5a), and the third narrowing of the invariant it caused.
 *
 *   M4    dictation never waits.
 *   M4.1  …when there is nothing to edit.
 *   M5a   …unless the words themselves ask for something.
 *
 * An empty composer used to be proof there was nothing to do. It is now the
 * single most likely place for "reply saying I'll have it by five". What did
 * not change is the thing that matters: ordinary speech has no compose verb
 * either, so it still never waits.
 */
describe('mightBeCompose', () => {
  const COMPOSE = [
    'reply to this',
    'reply saying I will have the redlines by five',
    'reply to Priya and say it is on the way',
    'respond to this politely',
    'answer her question',
    'draft a reply',
    'draft something back declining',
    'write back and say we need another week',
    'get back to him about the invoice',
    'could you reply to this saying yes'
  ]

  for (const transcript of COMPOSE) {
    it(`asks about: “${transcript}”`, () => {
      expect(mightBeCompose(transcript)).toBe(true)
    })
  }

  /**
   * The two deliberate omissions. "Tell her I'll be late" is the most natural
   * way to *dictate* a message into a chat window, not to request one — and
   * putting it in TIER_C would make the commonest utterance in Slack pay
   * several seconds of classification.
   */
  const DICTATION = [
    'tell her I will be late',
    'say that we are moving the date',
    'let them know the deck is ready',
    'and I will send the deck tonight',
    'thanks so much, that really helped',
    'sounds good, Tuesday works for me',
    'answering that question took me all morning',
    'replying to everyone is going to take a while'
  ]

  for (const transcript of DICTATION) {
    it(`does not ask about: “${transcript}”`, () => {
      expect(mightBeCompose(transcript)).toBe(false)
    })
  }

  it('has room for the content a compose carries inline', () => {
    // Unlike an edit instruction, a compose contains its own message, so the
    // 14-word ceiling that suits "tighten this up" would cut it off.
    expect(
      mightBeCompose(
        'reply saying I will have the redlines by five and apologise for the delay again'
      )
    ).toBe(true)
  })

  it('still refuses a paragraph', () => {
    expect(mightBeCompose(`reply ${'and again '.repeat(30)}`)).toBe(false)
  })
})

describe('worthAsking — the invariant, as one predicate', () => {
  const EMPTY = { hasSelection: false, hasFieldText: false, hasScreen: false }
  const EMPTY_WITH_SCREEN = { hasSelection: false, hasFieldText: false, hasScreen: true }
  const FIELD = { hasSelection: false, hasFieldText: true, hasScreen: true }

  it('never waits on ordinary speech into an empty box', () => {
    expect(worthAsking('and I will send the deck tonight', EMPTY_WITH_SCREEN)).toBe(false)
  })

  it('never waits on ordinary speech into a half-written message', () => {
    expect(worthAsking('and I will send the deck tonight', FIELD)).toBe(false)
  })

  /** The case M5a exists for: an empty composer under a conversation. */
  it('asks about a reply into an empty box, when it can see the window', () => {
    expect(worthAsking('reply saying I will have it by five', EMPTY_WITH_SCREEN)).toBe(true)
  })

  it('does not ask about a reply when it cannot see anything to reply to', () => {
    expect(worthAsking('reply saying I will have it by five', EMPTY)).toBe(false)
  })

  it('still asks about an edit instruction over text', () => {
    expect(worthAsking('tighten this up', FIELD)).toBe(true)
  })

  it('does not ask about an edit instruction with nothing to edit', () => {
    expect(worthAsking('tighten this up', EMPTY_WITH_SCREEN)).toBe(false)
  })
})

describe('route — the offline fallback knows about compose', () => {
  it('routes a reply to compose when the window was read', () => {
    expect(
      route('reply saying it is on the way', {
        hasSelection: false,
        hasFieldText: false,
        hasScreen: true
      })
    ).toEqual({ kind: 'compose', instruction: 'reply saying it is on the way' })
  })

  it('types it when there is no window to reply to', () => {
    expect(
      route('reply saying it is on the way', {
        hasSelection: false,
        hasFieldText: false,
        hasScreen: false
      })
    ).toMatchObject({ kind: 'dictate' })
  })

  /**
   * Compose is checked before the `nothingToEdit` gate. Checking it after would
   * make it unreachable in exactly the case it exists for.
   */
  it('prefers compose over an edit of the half-written text', () => {
    expect(
      route('reply to this', { hasSelection: false, hasFieldText: true, hasScreen: true })
    ).toMatchObject({ kind: 'compose' })
  })
})
