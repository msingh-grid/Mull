import type { ScreenContext } from '@shared/context'
import type { SidecarApi, UiTarget } from '@shared/sidecar-api'
import { FIND_LIMIT } from '@shared/agent'
import { renderContext, renderTargets } from '../engine/prompts'
import type { ActionExecutor, Scan } from './actions'
import { describeChange } from './navigate'

/**
 * What the five tools actually do.
 *
 * Deliberately separate from the loop that calls them (`engine/agent-loop.ts`)
 * and from the lane that shows them (`pipeline/agent.ts`), because these are the
 * only part of the agent that touches the machine and they should be readable
 * and testable without a subprocess anywhere near them. Every one of them is a
 * plain async function over a `SidecarApi` and an `ActionExecutor`.
 *
 * ### The guard
 *
 * Every handler begins by asking whether the run is still wanted. That is
 * belt-and-braces — `canUseTool` refuses first and its refusal is synchronous,
 * so nothing should ever reach here after a stop — but the two failure modes are
 * different enough to be worth both. `canUseTool` protects against a tool call
 * the model has already emitted; this protects against a handler that was
 * already *running* when the user pressed Escape and is about to take its second
 * round trip. And unlike the permission callback it can be unit-tested without
 * the SDK, which is why the stop's tests live here.
 *
 * ### Why the results are prose
 *
 * A tool result is read by a model, not parsed by code, and these reuse the
 * exact renderers the questionnaire used — `renderContext` and `renderTargets`
 * from `engine/prompts.ts`. The model reads a numbered list better than it reads
 * a serialization of one, and every token spent on braces is a token not spent
 * on what the window says.
 */

/** Everything the handlers share. One object, made per run by the lane. */
export interface ToolContext {
  sidecar: SidecarApi
  executor: ActionExecutor
  /** The plan the steps belong to — carried into each journal row. */
  plan: { app: { bundleId: string; name: string } | null; goal: string; groupId: string }
  /** Is the run still wanted? Read before every act. */
  stopped: () => boolean
  /** The scan the model is currently choosing from. Owned here. */
  scan: Scan | null
  /**
   * The window as it looked just before the last press, and the row that press
   * wrote.
   *
   * `AXPress` reports that an action was *accepted*, not that it did anything,
   * and the executor's window-title check is right when a press changes windows
   * and silent when it opens an overlay — which is most of what a press does. So
   * the honest answer only exists on the *next* look, and this is what carries
   * the question that far. See `describeChange`.
   */
  pressed: { scan: Scan; entryId?: string } | null
  /**
   * The last window text a `look` returned.
   *
   * The answer is written from this rather than from a fresh read, because by
   * the time the run ends the window has been put back — and answering from a
   * window you have already left is how a plan reports on the wrong thing.
   */
  read: ScreenContext | null
  /** How many acts have been taken, so a step can be numbered. */
  steps: number
  /** Annotate a step's row once its effect is finally visible. */
  amend?: (entryId: string, evidence: string) => void
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

/** What a handler gives back: prose for the model, a clause for the card. */
export interface ToolOutcome {
  /** What the model is told. */
  text: string
  /** One clause for the card's step row, when this act deserves one. */
  detail?: string
  /** False when the act was refused or failed — the card marks the step. */
  ok?: boolean
  /**
   * The journal row a press wrote, so the lane can annotate it later.
   *
   * Whether a press moved anything is only visible from the *next* look at the
   * window, by which time the row exists. The id is how the evidence finds its
   * way home — see `JournalStore.amend`.
   */
  entryId?: string
}

/** The sentence a stopped run gives back instead of doing anything. */
export const STOPPED_MESSAGE =
  'the user stopped this run — take no further action and do not try again'

const STOPPED: ToolOutcome = { text: STOPPED_MESSAGE, ok: false, detail: 'stopped' }

// ---------------------------------------------------------------------------

/**
 * How much of a window one look is allowed to take in.
 *
 * The same numbers the questionnaire used (`pipeline/navigate.ts`), and for the
 * same reasons: 300 targets because Chrome showing Gmail returns 254 distinct
 * ones and a smaller cap stopped inside Chrome's own toolbar, and a 2s deadline
 * because that window takes ~500ms to walk.
 */
const SCAN_BUDGET = { maxTargets: 300, deadlineMs: 2_000 } as const
const READ_BUDGET = { maxChars: 6_000, screenshot: false } as const

/** Chromium builds its tree lazily; the same handshake `captureContext` uses. */
const TREE_ATTEMPTS = 3
const TREE_POLL_MS = 350

export async function look(
  context: ToolContext,
  input: { want: 'text' | 'targets' | 'both' },
  sleep: (ms: number) => Promise<void>
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const parts: string[] = []
  let detail = ''

  if (input.want !== 'targets') {
    const seen = await context.sidecar.windowContext(READ_BUDGET)
    const chars = seen.blocks.reduce((n, block) => n + block.text.length, 0)
    const read: ScreenContext = {
      app: context.plan.app,
      windowTitle: seen.windowTitle,
      blocks: seen.blocks,
      truncated: seen.truncated,
      // No picture. One was taken at key-down and the model has already seen it;
      // the words are what moved since then.
      image: null,
      imageReason: 'not-retaken-mid-run',
      chars,
      harvestMs: seen.harvestMs
    }
    // Kept even when empty is the wrong call — an empty read would overwrite a
    // good one from a window we have since left, and the answer is written from
    // whatever is here at the end.
    if (chars > 0) context.read = read
    parts.push(renderContext(read) ?? '<screen>\nthis window has no readable text\n</screen>')
    detail = `${seen.blocks.length} blocks · ${chars} chars`
  }

  if (input.want !== 'text') {
    const scan = await rescan(context, sleep)
    context.scan = scan
    if (scan.stoppedBy === 'browser-cold') {
      // Named as the app's own remedy rather than described as a mechanism.
      // "Chromium builds its renderer accessibility tree lazily" is true and
      // helps nobody; the model needs to know to stop rather than press Reload.
      parts.push(
        '<targets>\nthis browser is not sharing the page — only its own toolbar is ' +
          'visible, so nothing on the page can be reached. Say so and finish.\n</targets>'
      )
    } else {
      parts.push(renderTargets(scan.targets, undefined, scan.stoppedBy))
    }
    detail = detail ? `${detail} · ${scan.targets.length} targets` : `${scan.targets.length} targets`

    /**
     * Did the last press actually do anything?
     *
     * Asked here because here it is free — the look has both the window before
     * and the window after already in hand. It replaces a much weaker signal:
     * the executor compares window *titles*, which is right when a press changes
     * windows and silent when it opens an overlay, a pane or a modal. A Slack
     * search box opening took the list from 300 entries to 6 and left the title
     * alone, so history said "the window is still …" and a model one step from
     * the answer concluded it was stuck.
     */
    const pressed = context.pressed
    if (pressed) {
      context.pressed = null
      const change = describeChange(pressed.scan, scan)
      parts.push(change.detail)
      // The same sentence, written onto the row that press already wrote — the
      // evidence only exists one turn after the row does.
      if (pressed.entryId) context.amend?.(pressed.entryId, change.detail)
    }
  }

  return { text: parts.join('\n\n'), detail, ok: true }
}

export async function find(
  context: ToolContext,
  input: { query: string; kind?: 'press' | 'type' },
  sleep: (ms: number) => Promise<void>
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  // A `find` with no scan behind it is the common opening move, and failing it
  // would teach the model to call `look` first purely as a ritual.
  const scan = context.scan ?? (context.scan = await rescan(context, sleep))
  const hits = findTargets(scan.targets, input.query, input.kind)

  if (hits.length === 0) {
    return {
      text:
        `nothing here matches “${input.query}”. There are ${scan.targets.length} things ` +
        'in this window; look at them, or try a word that would appear in the label itself.',
      detail: `“${input.query}” — nothing`,
      ok: true
    }
  }
  return {
    text: renderTargets(hits),
    detail: `“${input.query}” — ${hits.length} of ${scan.targets.length}`,
    ok: true
  }
}

export async function press(
  context: ToolContext,
  input: { index: number; expectTitle: string }
): Promise<ToolOutcome> {
  if (context.stopped()) return STOPPED

  const scan = context.scan
  if (!scan) {
    return {
      text: 'you have not looked at this window yet — call look or find first',
      detail: 'pressed before looking',
      ok: false
    }
  }
  const target = scan.targets[input.index]
  if (!target) {
    return {
      text: `there is no target ${input.index} in the list you were shown`,
      detail: `no target ${input.index}`,
      ok: false
    }
  }

  context.steps += 1
  const result = await context.executor.perform(
    { verb: 'press', index: input.index, label: input.expectTitle },
    scan,
    { ...context.plan, step: context.steps }
  )

  // The scan is dead the moment something is pressed: the window it described
  // may have been replaced entirely. Dropping it here is what stops the next
  // press being aimed at a list that no longer exists.
  const before = scan
  context.scan = null

  if (!result.ok) {
    return { text: `that did not work: ${result.detail}`, detail: result.detail, ok: false }
  }

  // Held for the next look, which is the first moment anyone can tell whether
  // this press did anything at all.
  context.pressed = { scan: before, ...(result.entryId ? { entryId: result.entryId } : {}) }
  return {
    text:
      `pressed “${target.title}” — ${result.detail}. ` +
      `Look again before pressing anything else; the ${before.targets.length} numbers ` +
      'you were shown no longer mean anything.',
    detail: result.detail,
    ok: true,
    ...(result.entryId ? { entryId: result.entryId } : {})
  }
}

export function note(context: ToolContext, input: { text: string }): ToolOutcome {
  if (context.stopped()) return STOPPED
  return { text: 'noted', detail: input.text, ok: true }
}

// ---------------------------------------------------------------------------

/**
 * Which of these targets is the user talking about?
 *
 * Pure, and the most valuable thing in this file: it is what stops the loop
 * paying for 254 numbered lines on every single turn. Client-side for now — it
 * filters the scan the lane already holds — which gets the saving with no Swift.
 * Moving it into the sidecar would also cut the walk, and that is M-B.
 *
 * ### The ranking
 *
 * Deliberately simple, and ordered by how much a match tells you:
 *
 *   3  the title is exactly the query
 *   2  the title starts with it — "Anil" against "Anil Turaga (away)"
 *   1  it appears anywhere in the title, help or value
 *
 * Then by how much of the title the query accounts for, so a short precise
 * label outranks a long one that merely contains the word. "Priya Sharma" beats
 * "Search messages from Priya Sharma and 4 others" for the query "Priya".
 *
 * Every word of the query has to appear somewhere for a multi-word query to
 * match at all, because a query is a description rather than a guess — "terms
 * doc" must not match every row containing "the".
 */
export function findTargets(
  targets: UiTarget[],
  query: string,
  kind?: 'press' | 'type'
): UiTarget[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const words = needle.split(/\s+/u).filter(Boolean)

  const scored: Array<{ target: UiTarget; score: number; density: number }> = []
  for (const target of targets) {
    if (kind && target.kind !== kind) continue
    const title = target.title.toLowerCase()
    const haystack = `${title} ${target.help ?? ''} ${target.value ?? ''}`.toLowerCase()
    if (!words.every((word) => haystack.includes(word))) continue

    const score = title === needle ? 3 : title.startsWith(needle) ? 2 : 1
    scored.push({ target, score, density: needle.length / Math.max(title.length, 1) })
  }

  scored.sort((a, b) => b.score - a.score || b.density - a.density || a.target.index - b.target.index)
  return scored.slice(0, FIND_LIMIT).map((hit) => hit.target)
}

// ---------------------------------------------------------------------------

/** How long to let a window settle before looking at it. */
const SETTLE_MS = 250

/**
 * What can be pressed here, now.
 *
 * Fresh every time, never cached across an act — the whole point is that the
 * previous numbers stopped meaning anything the moment something was pressed.
 */
async function rescan(context: ToolContext, sleep: (ms: number) => Promise<void>): Promise<Scan> {
  await sleep(SETTLE_MS)
  let seen = await context.sidecar.uiTargets(SCAN_BUDGET)
  for (let attempt = 0; seen.stoppedBy === 'tree-warming' && attempt < TREE_ATTEMPTS; attempt += 1) {
    await sleep(TREE_POLL_MS)
    seen = await context.sidecar.uiTargets(SCAN_BUDGET)
  }
  return {
    harvestId: seen.harvestId,
    targets: seen.targets as UiTarget[],
    stoppedBy: seen.stoppedBy
  }
}
