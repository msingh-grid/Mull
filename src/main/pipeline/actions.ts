import type { SidecarApi, UiTarget } from '@shared/sidecar-api'
import type { ScreenContext } from '@shared/context'
import type { NavStep } from '@shared/nav'
import type { JournalDraft, JournalEntry } from '@shared/types'
import { insertionProfile } from '../services/insertion-table'

/**
 * Performing one navigation step, and refusing the ones that are not.
 *
 * This is the only place in Mull that drives someone else's UI on the model's
 * say-so, so almost all of it is guards. The shape of the guards matters more
 * than their contents:
 *
 * **The step union is the safety argument**, and it lives in `@shared/nav` so
 * that the engine validating the model's answer and this file performing it
 * cannot drift apart. There is no `send` verb, no `keyChord`, no free-text
 * `insertText`.
 *
 * **Targets are integers into a list Mull made.** The model never names an
 * element; it picks an index out of a scan (`AXTargets`), and the press quotes
 * the role and title back so a stale index refuses instead of landing on
 * whatever moved into that slot. See `services/sidecar.ts` → `pressTarget`.
 *
 * **Nothing here decides anything.** The executor performs a step it is handed
 * and reports what happened. What to do next is the loop's problem, and whether
 * to run at all is the card's.
 */


/**
 * Controls this will not press, whatever the model says.
 *
 * A deny-list, and it is worth saying why that is not the same mistake as the
 * verb tables deleted in M5b. Those were allow-lists: a phrasing nobody thought
 * of fell through and was typed into a Slack composer, silently and uselessly,
 * and the only fix was to keep adding words forever. This fails the other way.
 * A destructive label nobody listed gets pressed — bad — but a listed one that
 * fires wrongly merely refuses and says so, and every word added makes it
 * strictly safer. Allow-lists rot; deny-lists are merely incomplete.
 *
 * It is a backstop, not the defence. The defences are that the plan is a
 * proposal until Run, that the steps appear on a card as they happen, and that
 * Escape stops it.
 */
const DESTRUCTIVE =
  /\b(delete|remove|leave|archive|block|unsend|discard|trash|deactivate|unsubscribe|sign out|log out|log off)\b/i

/**
 * What a `type` target has to look like.
 *
 * Belt and braces over the sidecar's own `textRoles`, which already excludes
 * `AXTextArea` — a composer is a text area, a search box is a text field. This
 * adds the name check, because an app could plausibly put a one-line reply box
 * on `AXTextField` and the navigator has no business typing into it.
 */
const SEARCH_FIELD = /search|find|filter|jump to|go to|channel|user|name|query|address|url|location/i

// ---------------------------------------------------------------------------

export interface StepResult {
  ok: boolean
  /** One clause, for the card and the journal. Always set, including on ok. */
  detail: string
  /** Set when the step was refused here rather than by the sidecar. */
  refusedBy?: 'destructive' | 'not-a-search-field' | 'no-such-target' | 'wrong-kind'
  /**
   * What a `read` step read. Set only by `read`, and only when it succeeded.
   *
   * This used to be thrown away the moment it was counted, and `detail` — "51
   * blocks · 6023 chars" — was all that survived. The plan then reported that
   * number to someone who had asked what a conversation said, which is the
   * entire navigation feature failing at its last step with every part of it
   * working. The words have to leave this method for anything to be answered
   * from them.
   */
  read?: ScreenContext | null
}

/** Where a scan came from, and what it saw. Handed in, never fetched here. */
export interface Scan {
  harvestId: string
  targets: UiTarget[]
}

/**
 * The plan a step belongs to.
 *
 * `goal` is the user's own words, carried down purely so each journal row can
 * say what was being attempted. A press with no record of why is a line in a
 * ledger nobody can read back.
 */
export interface PlanContext {
  app: { bundleId: string; name: string } | null
  goal: string
}

export interface ActionDeps {
  sidecar: SidecarApi
  journal?: { append(draft: JournalDraft): JournalEntry }
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  sleep?: (ms: number) => Promise<void>
}

/** How long to let a press settle before anyone looks at the window again. */
export const STEP_SETTLE_MS = 420

export class ActionExecutor {
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: ActionDeps) {
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Do one step, or refuse it.
   *
   * `app` is only for the journal row and the paste timing; the step acts on
   * whatever is in front, which by construction is the app the scan came from.
   */
  async perform(step: NavStep, scan: Scan, context: PlanContext): Promise<StepResult> {
    const result = await this.run(step, scan, context)
    this.record(step, result, context)
    return result
  }

  private async run(step: NavStep, scan: Scan, context: PlanContext): Promise<StepResult> {
    switch (step.verb) {
      case 'done':
        return { ok: true, detail: step.because }

      case 'navKey': {
        const sent = await this.deps.sidecar.navKey({ key: step.key })
        return sent.sent
          ? { ok: true, detail: step.key }
          : { ok: false, detail: sent.reason ?? 'the key did not go' }
      }

      case 'read': {
        const seen = await this.deps.sidecar.windowContext({ maxChars: 6_000, screenshot: false })
        const chars = seen.blocks.reduce((n, block) => n + block.text.length, 0)
        if (chars === 0) return { ok: false, detail: `nothing readable here (${seen.stoppedBy})` }
        return {
          ok: true,
          detail: `${seen.blocks.length} blocks · ${chars} chars`,
          read: {
            app: context.app,
            windowTitle: seen.windowTitle,
            blocks: seen.blocks,
            truncated: seen.truncated,
            // No second photograph. One was taken at key-down and the model has
            // already seen it; the words are what moved since then.
            image: null,
            imageReason: 'not-retaken-mid-plan',
            chars,
            harvestMs: seen.harvestMs
          }
        }
      }

      case 'press': {
        const target = scan.targets[step.index]
        if (!target) {
          return {
            ok: false,
            detail: `there is no target ${step.index}`,
            refusedBy: 'no-such-target'
          }
        }
        if (target.kind !== 'press') {
          return { ok: false, detail: `${target.title} is not pressable`, refusedBy: 'wrong-kind' }
        }
        if (DESTRUCTIVE.test(target.title)) {
          return {
            ok: false,
            detail: `Mull won’t press “${target.title}”`,
            refusedBy: 'destructive'
          }
        }
        // What the window was called before the press, so the result can say
        // whether anything happened. See below.
        const was = await this.windowTitle()
        const pressed = await this.deps.sidecar.pressTarget({
          harvestId: scan.harvestId,
          index: step.index,
          expectRole: target.role,
          expectTitle: target.title
        })
        if (!pressed.ok) return { ok: false, detail: describeRefusal(pressed, target) }
        // The press is asynchronous from the app's point of view — it returns
        // the moment the action is accepted, not when the UI has caught up. Let
        // it settle before the loop looks again, or the next scan describes the
        // window we were already looking at.
        await this.sleep(STEP_SETTLE_MS)

        /**
         * Did it actually go anywhere?
         *
         * `AXPress` reports whether the action was *accepted*, not whether it
         * did anything, and this is how the navigator got stuck in a loop:
         * history said `press 37 "Anil Turaga" — ok: Anil Turaga` and then said
         * exactly the same thing again, so pressing the same row a second time
         * looked as reasonable as pressing it the first. The model had no
         * evidence either way, because the only thing it was told about the
         * press was the label it had already chosen.
         *
         * The window title is the cheapest honest evidence there is — one ~2ms
         * round trip, and in every app where pressing a sidebar row means going
         * somewhere, it is exactly the thing that changes.
         */
        const now = await this.windowTitle()
        if (now && was && now !== was) return { ok: true, detail: `${target.title} → ${now}` }
        if (now && was && now === was) {
          return { ok: true, detail: `${target.title} — the window is still “${now}”` }
        }
        return { ok: true, detail: target.title }
      }

      case 'type': {
        const target = scan.targets[step.index]
        if (!target) {
          return {
            ok: false,
            detail: `there is no target ${step.index}`,
            refusedBy: 'no-such-target'
          }
        }
        if (target.kind !== 'type') {
          return {
            ok: false,
            detail: `${target.title} is not a text field`,
            refusedBy: 'wrong-kind'
          }
        }
        if (!SEARCH_FIELD.test(`${target.title} ${target.help ?? ''}`)) {
          // The one place the navigator could put words into someone's app, so
          // it is allowed exactly where words are a query and nowhere else.
          return {
            ok: false,
            detail: `“${target.title}” doesn’t look like a search box`,
            refusedBy: 'not-a-search-field'
          }
        }
        const focused = await this.deps.sidecar.focusTarget({
          harvestId: scan.harvestId,
          index: step.index,
          expectRole: target.role,
          expectTitle: target.title
        })
        if (!focused.ok) return { ok: false, detail: describeRefusal(focused, target) }

        // The ordinary insertion path from here, so this inherits the paste
        // timing tuned per app and the read-back that comes with it rather than
        // growing a second way to put text in a box.
        const profile = insertionProfile(context.app?.bundleId)
        const wrote = await this.deps.sidecar.insertText({
          text: step.text,
          settleMs: profile.settleMs
        })
        if (!wrote.inserted) {
          return { ok: false, detail: wrote.reason ?? 'the query would not go in' }
        }
        await this.sleep(STEP_SETTLE_MS)
        return { ok: true, detail: `“${step.text}” into ${target.title}` }
      }
    }
  }

  /**
   * Put it back.
   *
   * Always runs — after a finished plan, a cancelled one, and a failed one.
   * Leaving someone's Slack on a stranger's DM because a plan ran out of steps
   * is rude in a way that no amount of correctness elsewhere makes up for.
   *
   * Best effort, and honest about it: re-activating the app is reliable,
   * getting back to the exact conversation is not. When the row that was in
   * front can be found in the current scan it is pressed; otherwise the caller
   * is told where the window was left so the card can say so.
   */
  async restore(
    origin: { app: { bundleId: string; name: string } | null; windowTitle: string | null },
    scan: Scan | null
  ): Promise<StepResult> {
    if (origin.app) {
      const activated = await this.deps.sidecar.activateApp({ bundleId: origin.app.bundleId })
      if (!activated.activated) {
        return { ok: false, detail: activated.reason ?? 'could not switch back' }
      }
      await this.sleep(STEP_SETTLE_MS)
    }

    const wanted = origin.windowTitle?.trim()
    if (!wanted || !scan) {
      return { ok: true, detail: origin.app ? `back in ${origin.app.name}` : 'nothing to restore' }
    }

    const row = scan.targets.find(
      (target) => target.kind === 'press' && titlesMatch(target.title, wanted)
    )
    if (!row) return { ok: true, detail: `left in ${wanted}` }

    const pressed = await this.deps.sidecar.pressTarget({
      harvestId: scan.harvestId,
      index: row.index,
      expectRole: row.role,
      expectTitle: row.title
    })
    return pressed.ok
      ? { ok: true, detail: `back in ${row.title}` }
      : { ok: true, detail: `left in ${wanted}` }
  }

  /** What the front window is called, or null if it will not say. Never throws. */
  private async windowTitle(): Promise<string | null> {
    try {
      const front = await this.deps.sidecar.frontmostApp({})
      return front.windowTitle?.trim() || null
    } catch {
      return null
    }
  }

  private record(step: NavStep, result: StepResult, context: PlanContext): void {
    if (!this.deps.journal) return
    if (step.verb === 'done') return
    try {
      this.deps.journal.append({
        // A whitelisted command with a fixed argument list, exactly as `send`
        // is journalled. Someone reading back "what did Mull actually do out
        // there" should find each press as its own event.
        intent: {
          kind: 'command',
          verb: `nav.${step.verb}`,
          args: navArgs(step),
          transcript: context.goal
        },
        app: context.app,
        before: null,
        after: null,
        strategyUsed: null,
        status: result.ok ? 'applied' : 'failed',
        summary: `${step.verb} · ${result.detail}`,
        verified: result.ok,
        caret: null,
        // Nothing here can be taken back by ⌥Z. Pressing a sidebar row is not
        // destructive, but it is not an edit either, and pretending otherwise
        // would put a row in the undo stack that undoes nothing.
        undoable: false
      })
    } catch (err) {
      this.deps.log?.('error', 'actions: journal write failed', err)
    }
  }
}

// ---------------------------------------------------------------------------

function navArgs(step: NavStep): Record<string, unknown> {
  switch (step.verb) {
    case 'press':
      return { index: step.index, label: step.label }
    case 'type':
      return { index: step.index, text: step.text }
    case 'navKey':
      return { key: step.key }
    default:
      return {}
  }
}

/**
 * Why a press did not happen, in a sentence a person can act on.
 *
 * "No" is not enough on a card. The three refusals mean genuinely different
 * things — look again, the window changed under us, or the row you meant is now
 * somebody else — and only the last one is alarming.
 */
export function describeRefusal(
  refusal: { reason: string | null; actualTitle: string | null },
  target: UiTarget
): string {
  switch (refusal.reason) {
    case 'stale-scan':
      return 'that look at the window is too old'
    case 'gone':
      return `“${target.title}” isn’t there any more`
    case 'changed':
      return refusal.actualTitle
        ? `that row is “${refusal.actualTitle}” now, not “${target.title}”`
        : `“${target.title}” moved`
    case 'disabled':
      return `“${target.title}” is greyed out`
    case 'not-pressable':
      return `“${target.title}” can’t be pressed`
    case 'not-typeable':
      return `“${target.title}” doesn’t take text`
    case 'secure-input':
      return 'a password field has the keyboard'
    default:
      return refusal.reason ?? 'it would not go'
  }
}

/**
 * Is this sidebar row the conversation the window title named?
 *
 * Loose on purpose and only used by `restore`, where the cost of a miss is a
 * sentence saying where the window was left. Slack's title is "Anil Turaga
 * (DM) - Grid Dynamics - Slack" and the row is "Anil Turaga (away,
 * notifications snoozed)", so neither contains the other; what they share is
 * the name at the front.
 */
function titlesMatch(rowTitle: string, windowTitle: string): boolean {
  const head = (text: string): string =>
    text
      .split(/[(–—|]|\s-\s/u)[0]!
      .trim()
      .toLowerCase()
  const row = head(rowTitle)
  return row.length > 2 && head(windowTitle) === row
}
