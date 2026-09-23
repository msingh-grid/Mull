import { describe, expect, it } from 'vitest'
import { memoryDatabase } from './journal.test-helpers'
import { SkillStore } from './skills'

/**
 * What survives a run.
 *
 * The tests here are mostly about the three bounds, because the bounds are what
 * make a learned prompt block something a person can still reason about: the
 * same lesson does not become ten rows, a clause that is never present when
 * things go right leaves, and no application accumulates more than a handful.
 */

const NOW = 1_700_000_000_000
const SLACK = { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' }
const CHROME = { bundleId: 'com.google.Chrome', name: 'Chrome' }

function store(options: { perApp?: number } = {}): SkillStore {
  return new SkillStore(memoryDatabase(), { now: () => NOW, ...options })
}

describe('learning', () => {
  it('keeps a clause against the application it was learned in', () => {
    const skills = store()
    skills.learn(SLACK, [{ kind: 'do', text: 'search opens an overlay; look again before pressing' }])

    expect(skills.forApp(SLACK.bundleId)).toMatchObject([
      { kind: 'do', text: 'search opens an overlay; look again before pressing', appName: 'Slack' }
    ])
    expect(skills.forApp(CHROME.bundleId)).toEqual([])
  })

  /**
   * A model asked the same question after ten runs in Slack writes the same
   * lesson ten slightly different ways. Ten rows saying one thing is how a
   * prompt fills up with one idea.
   */
  it('counts a lesson learned twice as a vote, not a second row', () => {
    const skills = store()
    skills.learn(SLACK, [{ kind: 'do', text: 'Tabs before look in a browser' }])
    skills.learn(SLACK, [{ kind: 'do', text: 'tabs before look in a browser.' }])

    const kept = skills.forApp(SLACK.bundleId)
    expect(kept).toHaveLength(1)
    expect(kept[0]?.wins).toBe(1)
    // The text stays as first written: a user who read it in Settings yesterday
    // should be reading the same clause that is in the prompt today.
    expect(kept[0]?.text).toBe('Tabs before look in a browser')
  })

  it('keeps a do and an avoid that say the same words apart', () => {
    const skills = store()
    skills.learn(SLACK, [{ kind: 'do', text: 'press the channel row' }])
    skills.learn(SLACK, [{ kind: 'avoid', text: 'press the channel row' }])
    expect(skills.forApp(SLACK.bundleId)).toHaveLength(2)
  })

  it('has nothing to learn from an empty list', () => {
    const skills = store()
    skills.learn(SLACK, [])
    expect(skills.count()).toBe(0)
  })
})

describe('what is shown, and what stops being shown', () => {
  it('puts what has been present when things went well at the top', () => {
    const skills = store()
    skills.learn(SLACK, [{ kind: 'do', text: 'the useful one, about search' }])
    skills.learn(SLACK, [{ kind: 'do', text: 'the useless one, about nothing' }])
    const [useful, useless] = skills.forApp(SLACK.bundleId)
    skills.credit([useful?.id as string], 'win')
    skills.credit([useless?.id as string], 'loss')

    expect(skills.forApp(SLACK.bundleId).map((row) => row.text)).toEqual([
      'the useful one, about search',
      'the useless one, about nothing'
    ])
  })

  /**
   * Not a claim that the lesson is wrong — the run may have failed for reasons
   * nothing to do with it. What this catches is the clause that is never
   * present when things go right.
   */
  it('forgets a clause that has ridden along with three failures and no wins', () => {
    const skills = store()
    skills.learn(SLACK, [{ kind: 'avoid', text: 'never press the compose button' }])
    const id = skills.forApp(SLACK.bundleId)[0]?.id as string

    skills.credit([id], 'loss')
    skills.credit([id], 'loss')
    expect(skills.forApp(SLACK.bundleId)).toHaveLength(1)
    skills.credit([id], 'loss')
    expect(skills.forApp(SLACK.bundleId)).toEqual([])
  })

  it('keeps one that has failed but has also worked', () => {
    const skills = store()
    skills.learn(SLACK, [{ kind: 'do', text: 'search opens an overlay, look again' }])
    const id = skills.forApp(SLACK.bundleId)[0]?.id as string
    skills.credit([id], 'win')
    for (let i = 0; i < 3; i += 1) skills.credit([id], 'loss')

    expect(skills.forApp(SLACK.bundleId)).toHaveLength(1)
  })

  it('caps what one application may accumulate, dropping the worst', () => {
    const skills = store({ perApp: 3 })
    // Five genuinely different lessons. Five rewordings of one lesson would
    // collapse to a single row long before the cap — see the dedupe tests.
    for (const text of [
      'the search overlay opens without changing the window title',
      'threads are reachable from the History menu, not the sidebar',
      'the composer keeps focus after a channel switch',
      'unread rows are bold and sort above the rest',
      'huddle controls only appear once a call is joined'
    ]) {
      skills.learn(SLACK, [{ kind: 'do', text }])
    }
    const kept = skills.forApp(SLACK.bundleId, 10)
    expect(kept).toHaveLength(3)
  })

  it('counts the runs that were shown a clause', () => {
    const skills = store()
    skills.learn(SLACK, [{ kind: 'do', text: 'a lesson worth showing to a run' }])
    const id = skills.forApp(SLACK.bundleId)[0]?.id as string
    skills.markUsed([id])
    skills.markUsed([id])

    const row = skills.forApp(SLACK.bundleId)[0]
    expect(row?.uses).toBe(2)
    expect(row?.lastUsedAt).toBe(NOW)
  })
})

describe('the user is in charge of it', () => {
  it('lists everything, grouped by application', () => {
    const skills = store()
    skills.learn(SLACK, [{ kind: 'do', text: 'a lesson about Slack windows' }])
    skills.learn(CHROME, [{ kind: 'avoid', text: 'a lesson about Chrome tabs' }])
    expect(skills.all().map((row) => row.appName)).toEqual(['Chrome', 'Slack'])
  })

  it('forgets one, and forgets everything', () => {
    const skills = store()
    skills.learn(SLACK, [{ kind: 'do', text: 'a lesson about Slack windows' }])
    skills.learn(CHROME, [{ kind: 'do', text: 'a lesson about Chrome tabs' }])
    skills.forget(skills.forApp(SLACK.bundleId)[0]?.id as string)
    expect(skills.count()).toBe(1)
    skills.clear()
    expect(skills.all()).toEqual([])
  })

  it('never asks about an application nobody named', () => {
    expect(store().forApp(null)).toEqual([])
  })

  /** A store that cannot write is a Mull that does not learn, never one that throws. */
  it('survives a database that has gone wrong', () => {
    const broken = {
      exec: (): void => {},
      prepare: (): never => {
        throw new Error('disk is gone')
      },
      close: (): void => {}
    }
    const skills = new SkillStore(broken)
    expect(() => skills.learn(SLACK, [{ kind: 'do', text: 'a lesson nobody will read' }])).not.toThrow()
    expect(skills.forApp(SLACK.bundleId)).toEqual([])
    expect(() => skills.credit(['nope'], 'loss')).not.toThrow()
    expect(skills.all()).toEqual([])
  })
})

/**
 * Learning the same thing twice, in different words.
 *
 * The unique index catches a note re-punctuated. This catches one re-worded,
 * which is the commoner case — nothing asks a model to phrase a lesson the way
 * it phrased it last week.
 *
 * **And it is a backstop, not the defence.** See the last test here: a real
 * pair from live runs scores 0.455 and is *not* caught, because each note
 * carries a clause of its own on top of the shared lesson. What actually keeps
 * the notebook small is that the distilling turn is now shown the whole
 * notebook for the app it is filing against and asked whether this is new
 * (`pipeline/agent.ts`), plus the gate in front of it. This is here to catch
 * the easy half cheaply, and the threshold is deliberately conservative: two
 * lessons wrongly merged is a note nobody ever reads, which is worse than a
 * near-duplicate the cap would have evicted anyway.
 */
describe('learning the same thing in different words', () => {
  it('counts a reworded lesson as a vote for the one already kept', () => {
    const skills = store()
    skills.learn(SLACK, [{ kind: 'do', text: 'the search overlay opens without changing the window title' }])
    skills.learn(SLACK, [{ kind: 'do', text: 'opening the search overlay does not change the window title' }])

    const kept = skills.forApp(SLACK.bundleId)
    expect(kept).toHaveLength(1)
    // The first wording stays: what a user read in Settings yesterday should be
    // what is in the prompt today.
    expect(kept[0]?.text).toBe('the search overlay opens without changing the window title')
    expect(kept[0]?.wins).toBe(1)
  })

  /** A `do` and an `avoid` built from the same nouns are opposite advice. */
  it('does not collapse advice that points the other way', () => {
    const skills = store()
    skills.learn(SLACK, [{ kind: 'do', text: 'the search overlay opens without changing the window title' }])
    skills.learn(SLACK, [{ kind: 'avoid', text: 'opening the search overlay does not change the window title' }])
    expect(skills.forApp(SLACK.bundleId)).toHaveLength(2)
  })

  it('keeps two lessons that are genuinely different', () => {
    const skills = store()
    skills.learn(SLACK, [{ kind: 'do', text: 'the search overlay opens without changing the window title' }])
    skills.learn(SLACK, [{ kind: 'do', text: 'huddle controls only appear once a call has been joined' }])
    expect(skills.forApp(SLACK.bundleId)).toHaveLength(2)
  })

  /**
   * The known limit, written down rather than left to be rediscovered.
   *
   * Both of these were written by live runs against Slack, hours apart, and
   * they are one lesson. They share `search result window title update` and
   * little else, which scores 0.455 — under the threshold, and the threshold is
   * not moving to fit one pair. The turn that can tell these apart is the one
   * that can read them both, which is why `known` is now the whole notebook.
   */
  it('does not pretend to catch a rewording that shares only its nouns', () => {
    const skills = store()
    skills.learn(SLACK, [
      {
        kind: 'avoid',
        text: 'Pressing a user name in search results opens their DM; the window title does not update.'
      }
    ])
    skills.learn(SLACK, [
      {
        kind: 'avoid',
        text: 'Window title does not update when switching DMs via search results; check the message content.'
      }
    ])
    expect(skills.forApp(SLACK.bundleId)).toHaveLength(2)
  })
})
