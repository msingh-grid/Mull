import { z } from 'zod'

/**
 * User settings — the shape, shared by main, preload and every renderer.
 *
 * The schema lives here rather than beside the store because the settings
 * window sends patches back: both ends validating against the same object is
 * what stops a renderer from inventing a key the store will silently drop.
 * Persistence is src/main/store/settings.ts; this file never touches disk.
 */

export const SettingsSchema = z.object({
  /**
   * Gone at M5b, kept only so a stored settings file still parses.
   *
   * It used to choose *which* key starts dictation. The two keys now mean two
   * different things — ⌥Space dictates, Fn asks Mull to act — so there is
   * nothing left to choose, and a setting that quietly did nothing would be
   * worse than none. Nothing reads this.
   *
   * @deprecated
   */
  hotkey: z.enum(['opt-space', 'fn']).default('opt-space'),
  /** Window appearance. The HUD follows this too unless `hudTheme` overrides. */
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  /**
   * "Page in the dark" (docs/DESIGN.md §6.8): keep the HUD on paper-light even
   * when everything else goes lamplit.
   */
  hudTheme: z.enum(['follow', 'paper']).default('follow'),
  /** Epoch ms the user finished onboarding; null means they never have. */
  onboardingCompletedAt: z.number().int().nullable().default(null),
  launchAtLogin: z.boolean().default(false),
  /**
   * Which lane serves edits. `auto` prefers the Claude subscription and falls
   * back to an API key; the other two are explicit choices that refuse rather
   * than silently using the credential the user didn't pick.
   */
  engine: z.enum(['auto', 'subscription', 'api-key']).default('auto'),
  /**
   * Careful (Sonnet 5) or fast (Haiku 4.5). Default careful: an edit is
   * judgement about someone's writing, and the preview makes the judgement
   * cheap to check. The bench (`npm run bench:engine`) is what tells you
   * whether fast is worth it on your machine.
   */
  editModel: z.enum(['sonnet', 'haiku']).default('sonnet'),
  /**
   * How Mull decides dictate-vs-edit.
   *
   * `model` asks a fast model, but only when the focused field holds text or
   * something is selected — which means that text is sent to the model on those
   * utterances. `rules` keeps everything on this Mac and uses the local table,
   * which is measurably worse at natural phrasing. Dictation into an empty
   * field never leaves the machine either way.
   */
  routing: z.enum(['model', 'rules']).default('model'),
  /**
   * How much of the window in front of you Mull may read (M5a).
   *
   * `off` sends nothing but the text you are editing, as M4 did. `text` adds
   * the window's Accessibility transcript — the conversation above the
   * composer, which is what makes "reply to this" mean anything. `text+screen`
   * adds a picture of that one window, which is the only way to see charts,
   * canvases and PDFs.
   *
   * Defaulted on because without it the feature does not exist, and disclosed
   * rather than quiet: onboarding says so, Settings says so, and a chip on the
   * HUD names what is being read *while you are still speaking*. Credential
   * apps are never read at any setting, and neither is anything while secure
   * input is active.
   */
  context: z.enum(['off', 'text', 'text+screen']).default('text+screen'),
  /** Bundle ids the user never wants read, on top of the built-in refusals. */
  contextExcluded: z.array(z.string()).default([]),
  /**
   * Let the writing model think before it answers.
   *
   * **Off, and that default is worth a paragraph**, because it was accidentally
   * on for the whole of M4 and M5 and nobody could see it. The Agent SDK runs
   * extended reasoning unless told not to, and measured on the classifier —
   * same prompt, same model, same warm session — it cost:
   *
   *   thinking on    p50 20086ms   max 33438ms
   *   thinking off   p50   954ms   max  1219ms
   *
   * Twenty-two times, to deliberate over a choice between four words. Almost
   * everything Mull does is a single-shot transformation with the whole problem
   * already on the page, and all of it is something a person is waiting for.
   *
   * But *almost* is not *all*: "turn this thread into a project plan" is a
   * genuinely hard piece of writing and the seconds would be worth paying. So
   * this is armable from the HUD, where the decision is made in the moment,
   * beside the utterance it applies to.
   *
   * **Only the writing lanes.** The classifier picks one of four words and the
   * navigator picks an index out of a list; there is nothing there to think
   * about, and both sit on the critical path. They stay off at every setting.
   */
  thinking: z.boolean().default(false),
  /**
   * Where the user dragged the HUD, in screen coordinates. Null means the
   * default bottom-centre. Clamped back onto a real display at launch, because
   * a position saved on a monitor that has since been unplugged would leave the
   * panel invisible — and an invisible HUD looks exactly like a broken one.
   */
  hudPosition: z.object({ x: z.number(), y: z.number() }).nullable().default(null)
})

export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})
