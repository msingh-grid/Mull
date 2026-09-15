import { z } from 'zod'

/**
 * What the agent may ask for — the whole vocabulary, in one place.
 *
 * The counterpart of `@shared/nav` for the tool loop, and it exists for exactly
 * the same reason: `engine/agent-loop.ts` hands these schemas to the SDK, which
 * validates the model's tool calls against them, and `pipeline/agent-tools.ts`
 * performs what survives. Two definitions would mean "the model cannot type"
 * was true in one file and a hope in the other.
 *
 * ### What changed from `NavStepSchema`, and what did not
 *
 * The loop is the change. The model now calls a tool, reads the result, and
 * decides what to do next, rather than answering a questionnaire Mull re-renders
 * for it every turn. What has *not* changed is that the vocabulary is closed and
 * the closure is the safety argument:
 *
 *   - no verb writes text anywhere
 *   - no verb carries a keystroke, so ⏎ still cannot be named
 *   - no verb leaves the frontmost window, so nothing is opened, switched or
 *     activated
 *
 * A model that wanted to send a message still **could not describe the act**.
 * That is a much stronger statement than a model that has been asked not to, and
 * it does not depend on the model being well behaved or on the screen it was
 * shown being free of instructions. M-B and M-C widen this; each widening is a
 * decision taken on its own, with the gate in `canUseTool` to match.
 *
 * ### Targets are integers, never names
 *
 * Unchanged from `@shared/nav`, and for the same reason: `index` points into a
 * scan Mull made and showed the model. The model never names an element, which
 * is what makes "exact match or refuse" a comparison of numbers rather than a
 * guess about labels — two buttons called Send are two different integers. The
 * press quotes the title back so a stale index refuses instead of landing on
 * whatever moved into that slot.
 */

/** Read the front window: its words, what can be pressed, or both. */
export const LookInputSchema = z.object({
  want: z
    .enum(['text', 'targets', 'both'])
    .describe(
      'text = what the window says; targets = what can be pressed, numbered; both = one call for both'
    )
})

/**
 * Narrow the scan to what you were looking for.
 *
 * The tool that exists because the alternative is spending most of a prompt on
 * a list: one Gmail page is 254 distinct targets after deduplication, against a
 * scan budget of 300. Reading all of them every turn is the single largest
 * avoidable cost in the loop.
 */
export const FindInputSchema = z.object({
  query: z.string().min(1).max(120).describe('what you are looking for, in words'),
  kind: z
    .enum(['press', 'type'])
    .optional()
    .describe('restrict to things that can be pressed, or to text fields')
})

/** Press one enumerated target. The only verb that changes anything. */
export const PressInputSchema = z.object({
  index: z.number().int().nonnegative().describe('an index from the current scan'),
  expectTitle: z
    .string()
    .describe('that target’s title as you were shown it — checked before the press')
})

/**
 * Think out loud, once, in a sentence the user can read.
 *
 * Cheap externalised memory, and the only part of the model's reasoning that
 * reaches the card. Not required, and not a substitute for doing something.
 */
export const NoteInputSchema = z.object({
  text: z.string().min(1).max(200).describe('one short clause about what you are doing and why')
})

/**
 * Finished. `because` goes on the card.
 *
 * `found` splits the two very different things this used to mean — see
 * `@shared/nav`, where the same field was added for the same reason. `true`
 * means the window in front of you holds what was asked for. `false` means you
 * could not get there, and that is an honest outcome rather than a failure to
 * be papered over.
 *
 * Required here, unlike in `NavStepSchema`. There it was optional because a
 * missing field would have failed a parse and killed a plan; here the model is
 * told what the field means in the tool schema itself and can be asked again if
 * it omits one, so the stronger requirement costs nothing.
 */
export const DoneInputSchema = z.object({
  found: z.boolean().describe('true if you arrived and the answer is in front of you'),
  because: z.string().min(1).describe('one clause: what you found, or why you could not get there')
})

/** Every tool, and nothing else. The list the loop is built from. */
export const AGENT_TOOLS = ['look', 'find', 'press', 'note', 'done'] as const
export type AgentToolName = (typeof AGENT_TOOLS)[number]

/**
 * The MCP server name the tools are registered under.
 *
 * The SDK exposes an in-process tool as `mcp__<server>__<tool>`, and that full
 * name is what `canUseTool` is given and what any allow-list has to match — so
 * it is derived here rather than spelled out at each site.
 */
export const AGENT_SERVER = 'mull'

export function toolName(tool: AgentToolName): string {
  return `mcp__${AGENT_SERVER}__${tool}`
}

/**
 * How many turns a run may take.
 *
 * Six was right for a questionnaire that could only press things; a loop that
 * orients first, narrows with `find` and reads before it answers spends turns on
 * work that used to be done for it. Forty is deliberately generous — the budget
 * that actually binds is the money one below, and the one that actually protects
 * the user is the stop.
 */
export const MAX_AGENT_TURNS = 40

/** What one run may cost before the SDK ends it. An estimate, not a bill. */
export const AGENT_BUDGET_USD = 0.5

/**
 * How long a run may take in wall-clock before Mull ends it.
 *
 * The failure neither `maxTurns` nor the budget catches: a run that is not
 * looping and not spending, merely hung — on a scan of an app that has stopped
 * answering, or a model turn that never arrives. Nothing else closes that, and
 * a card that sits on RUNNING forever is the exact shape of bug the engine
 * watchdogs were added to end.
 */
export const AGENT_DEADLINE_MS = 180_000

/**
 * How many matches `find` returns.
 *
 * Ten. Enough that the right one is almost always among them, few enough that
 * asking twice is cheaper than reading the whole scan once.
 */
export const FIND_LIMIT = 10
