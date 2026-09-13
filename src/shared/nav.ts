import { z } from 'zod'
import { NavKeySchema } from './sidecar-api'

/**
 * What the navigator may ask for — the whole vocabulary, in one place.
 *
 * Shared because two layers need exactly the same shape and must not be able to
 * drift: `engine/agent.ts` validates the model's answer against it, and
 * `pipeline/actions.ts` performs what survives. If those were two definitions,
 * "the model cannot ask to send" would be true in one file and a hope in the
 * other.
 *
 * ### The union is the safety argument
 *
 * There is no `send` verb, no `keyChord`, no free-text `insertText`. A model
 * that wanted to send a message **could not describe the act** — which is a
 * much stronger statement than a model that has been asked not to, and it does
 * not depend on the model being well behaved or on the screen it was shown
 * being free of instructions.
 *
 * Three layers now say the same thing three different ways:
 *
 *   `ClassifiedIntent`  has no `send` field, so routing cannot ask for one
 *   `navKey`            is not `keyChord`, so ⏎ cannot be named
 *   here                has no shape that carries a keystroke at all
 *
 * ### Targets are integers, never names
 *
 * `index` points into the scan the model was shown (`AXTargets`). The model
 * never names an element, which is what makes "exact match or refuse" a
 * comparison of numbers rather than a guess about labels — two buttons called
 * Send are two different integers. The press quotes the role and title back to
 * the sidecar so a stale index refuses instead of landing on whatever moved
 * into that slot.
 */
export const NavStepSchema = z.discriminatedUnion('verb', [
  z.object({
    verb: z.literal('press'),
    /** Index into the scan the model was shown. */
    index: z.number().int().nonnegative(),
    /** The title as shown. Printed on the card, so the user reads a name. */
    label: z.string()
  }),
  z.object({
    verb: z.literal('type'),
    index: z.number().int().nonnegative(),
    /**
     * Short on purpose. This is a search query, and the only text the
     * navigator can put anywhere; a paragraph arriving here would mean
     * something upstream has gone wrong.
     */
    text: z.string().min(1).max(120)
  }),
  z.object({ verb: z.literal('navKey'), key: NavKeySchema }),
  /** Look at wherever we have arrived. Writes nothing. */
  z.object({ verb: z.literal('read') }),
  /** Finished — with or without an answer. `because` goes on the card. */
  z.object({ verb: z.literal('done'), because: z.string() })
])
export type NavStep = z.infer<typeof NavStepSchema>

/** What happened to a step, as the card shows it and the next turn is told. */
export interface NavAttempt {
  step: NavStep
  ok: boolean
  /** One clause: the row that was pressed, or why it wasn't. */
  detail: string
}

/**
 * How many steps a plan may take before Mull stops and says so.
 *
 * Small deliberately. A navigator that needs eleven presses to find a
 * conversation is lost, and the honest end to being lost is a sentence on a
 * card rather than another press.
 */
export const MAX_NAV_STEPS = 6
