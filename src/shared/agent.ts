import { z } from 'zod'
import { MODEL_IDS } from './settings'

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
 * that one closure carries the whole safety argument:
 *
 *   - **nothing here can express Return**
 *
 * That is the load-bearing sentence and everything else rests on it. ⏎ is how
 * Slack, Messages, Mail and Discord all send; a model that wanted to send a
 * message **could not describe the act**, which is a far stronger statement than
 * one that has been asked not to, and it does not depend on the model being well
 * behaved or on the screen it was shown being free of instructions.
 *
 * ### Three lines used to be here and are not any more
 *
 * They came out one at a time, each with an argument, and reading them in order
 * is the honest account of how much of the original fence is left.
 *
 * *"no verb writes text anywhere."* `setText` writes text. The argument was that
 * it does not touch the keystroke closure: a message that has been typed but
 * cannot be sent is a message sitting in a box the user can see and clear.
 * Typing is visible and reversible; sending is neither, and sending is still
 * unreachable. What it costs is real — Mull can put text into a composer, and a
 * user with the muscle memory to press ⏎ can send it. The card shows every write
 * as it happens and the journal records what the field held before.
 *
 * *"no verb leaves the frontmost window."* `switchTab` and `openUrl` do. A
 * browser tab was never a window — it is invisible to `kAXWindowsAttribute`,
 * which is exactly why Mull could not tell two of them apart — so reaching one
 * is less a new *kind* of reach than the first time the old kind worked.
 * `openUrl` is the genuine widening: the first verb here that reaches the
 * network, and it needs no keystroke to do it. It carries `checkUrl`'s gate for
 * that reason.
 *
 * *"no verb carries a keystroke, so ⏎ cannot be named."* `key` carries a
 * keystroke. This is the clause that sounds like the fence coming down, and the
 * reason it is not is the shape of `AgentKeySchema`: a closed enumeration of
 * seven navigation keys that **never contained Return**, in the same way and for
 * the same reason as `NavKeySchema` in `@shared/sidecar-api`. The property was
 * never really "no keystrokes" — it was "⏎ is not expressible" — and that is
 * still true, structurally, one type away from anyone who tries to widen it.
 * A filter would have been one edit from letting ⏎ through; an enumeration that
 * never held it is not.
 *
 * *"no verb changes which application is in front."* `switchApp` does, and it is
 * the widening with the least novel reach and the most novel *feel*: everything
 * it can do, `press` could already do to the window it was standing in, and the
 * app it moves to must be one already running and already listed by `apps`. What
 * is new is that the user's screen moves. That is why it carries `because`, why
 * the card shows it before the switch, and why `restore` was always unconditional.
 *
 * ### Commit is still out, but it is no longer out for free
 *
 * For four of those widenings the answer to "could this send something" was the
 * same sentence and it cost nothing to say: **there is no Return in the
 * vocabulary.** It was a fact about a type, it needed no enforcement, and it did
 * not depend on the model behaving.
 *
 * `chooseMenu` ends that era. Mail sends with a menu item; so does Slack. A
 * vocabulary that can choose any menu command can send, and "the agent cannot
 * press ⏎" would have gone on being true while ceasing to mean anything. The
 * keystroke closure is not *wrong* — nothing here can still press Return — it is
 * simply no longer the whole argument.
 *
 * What replaces it, for this one tool, is weaker and is worth naming as weaker:
 * a deny-list on the command's name (`checkMenuCommand`), a rule that the pair
 * must have come back from `menus` in this run, and the card showing the command
 * before it runs. A regex is not a type. It is the first control here that could
 * be wrong about a phrasing nobody thought of, and it is load-bearing.
 *
 * The honest summary: commit is still out of reach, but it is held out by a
 * guard rather than by a shape, and a guard is the kind of thing that has to be
 * maintained. See `checkMenuCommand`.
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
 * Put text into a field, a box or a combo.
 *
 * The first widening of this vocabulary, and the reasoning is worth keeping
 * where the schema is rather than only in a commit message.
 *
 * Typing used to be unreachable here entirely, and in the older lane it was
 * reachable only for controls whose *name* matched `search|find|filter|…`. That
 * name check was an allow-list, and it failed the way allow-lists always fail in
 * this codebase: an event title, a description, a comment and a guest field all
 * fall through it, which is to say every form in every app.
 *
 * **The boundary moved rather than opened.** What the name check was really
 * protecting was a message being *sent*, and typing is not sending: text in a
 * box is visible, is reversible, and does nothing until something presses
 * Return. Nothing in this vocabulary can press a key — there is still no verb
 * that carries one, so `AGENT_TOOLS` below remains unable to describe the act.
 * That closure is what makes this safe, and it is the thing to check before
 * widening anything else.
 *
 * Two consequences worth stating: the field's previous contents are journalled,
 * so a write says what it replaced; and `⌥Z` does not take this back, because
 * undo follows the user's own caret rather than a run's.
 */
export const SetTextInputSchema = z.object({
  index: z.number().int().nonnegative().describe('an index from the current scan'),
  expectTitle: z
    .string()
    .describe('that target’s title as you were shown it — checked before the write'),
  text: z
    .string()
    .max(2_000)
    .describe('what to put in it. Replaces whatever is there; it does not append')
})

/**
 * How many times one `key` call may repeat.
 *
 * Ten `pageDown`s is a long document and about as far as reading blind is worth
 * going before looking again. The real reason for a cap is that a repeat count
 * is the one number in this vocabulary that turns a single decision into many
 * actions, and an unbounded one would let one tool call hold a key down through
 * a list the agent has not seen.
 *
 * Declared here rather than beside the other budgets below because
 * `KeyInputSchema` reads it as the module loads, and a `const` used before its
 * line is a dead-zone error rather than a hoisted one.
 */
export const MAX_KEY_REPEAT = 10

/**
 * The keys the agent may press — an enumeration, not a filter.
 *
 * ### Why this is a list and not a subtraction
 *
 * The obvious implementation is `NavKeySchema` minus a couple of entries, and
 * the obvious implementation is wrong for exactly the reason `NavKeySchema`'s
 * own docstring gives about `keyChord`: **a filter is one edit away from letting
 * ⏎ through, and a list is one where it was never present.** Someone adding
 * `home` and `end` here next month edits a list of strings; they cannot
 * accidentally widen a predicate. That difference is the whole safety property
 * of this file now that a key tool exists at all.
 *
 * ### The two that are missing, and why
 *
 * **Return** is the actuator. It is how Slack, Messages, Mail and Discord all
 * send, and leaving it out is what keeps "Mull cannot send a message" a fact
 * about the type rather than a promise about behaviour. `@shared/nav` made the
 * same omission for the same reason; this is that decision restated for the
 * loop rather than inherited from it.
 *
 * **`backTab`** is here and its bare cousin ⇧ is not, which is the same
 * distinction the whole file turns on: `backTab` is a *name* for one keystroke
 * that Mull's own table maps to ⇧⇥, not a modifier the model may attach to
 * anything. It is here because moving backwards through a form is unreachable
 * otherwise — unlike ⌘F or ⌘S, which the menus now reach, with better labels
 * and `checkMenuCommand` attached.
 *
 * **Escape** is missing for a duller reason, and it is not a safety one.
 * `ChordScope` registers Escape as a global shortcut, and a synthetic key posted
 * to `.cghidEventTap` arrives *upstream* of where that registration listens — so
 * an agent pressing Escape to dismiss a menu would trip Mull's own stop and end
 * its own run, from inside itself. It is reachable another way in any case: a
 * dialog that can be escaped almost always has a Cancel button, and `press`
 * finds it.
 */
export const AgentKeySchema = z.enum([
  'tab',
  'backTab',
  'up',
  'down',
  'left',
  'right',
  'pageUp',
  'pageDown'
])
export type AgentKey = z.infer<typeof AgentKeySchema>

/**
 * Press a navigation key, once or a few times.
 *
 * What it is actually for is reading. A window's text harvest is capped, a long
 * document or a long thread is mostly below the fold, and until now the agent
 * had no way to reach any of it: `press` needs a target and a scrollbar is not
 * one that means anything. `pageDown` is how the rest of a page gets read, and
 * it is most of why this tool exists.
 *
 * The rest is arrow-key work in lists and menus that answer to nothing else —
 * an autocomplete dropdown, a native menu that has opened, a table row. Those
 * are the cases where the accessibility tree offers a control that cannot be
 * pressed into the state you want.
 */
export const KeyInputSchema = z.object({
  key: AgentKeySchema.describe('which key. There is no Return here and there will not be one'),
  times: z
    .number()
    .int()
    .positive()
    .max(MAX_KEY_REPEAT)
    .optional()
    .describe('press it more than once — for paging through a long document')
})

/**
 * Bring something into view.
 *
 * ### Why this is not `key({key: 'pageDown'})`
 *
 * Paging is blind in both directions. The model cannot tell how far a page is
 * in this window, so it guesses a count and looks again; and a page key moves
 * whatever holds keyboard focus, which in a browser is frequently not the thing
 * being read. The failure is silent — the window scrolls somewhere, and the next
 * `look` describes it as though that was the plan.
 *
 * `AXScrollToVisible` inverts it: the *element* is asked to make itself visible,
 * so the application picks which of its scroll views to move and by how much.
 * Surveyed across six applications it is advertised by 519 of 575 elements, so
 * this is a general answer rather than one that works in the app it was tested
 * in.
 *
 * It changes nothing and presses nothing — the gentlest verb in this
 * vocabulary, and the only one whose entire effect is on what the user can see.
 */
export const ScrollToInputSchema = z.object({
  index: z.number().int().nonnegative().describe('an index from the current scan'),
  expectTitle: z
    .string()
    .describe('that target’s title as you were shown it — checked before the scroll')
})

/**
 * What else is running.
 *
 * The question that has to be answered before the agent can go anywhere, and the
 * one nothing else in the vocabulary can answer: `look` describes the window in
 * front, and a bundle id is not something to guess at —
 * `com.tinyspeck.slackmacgap` is not a name anybody would invent.
 *
 * Takes nothing, like `tabs`, and for the same reason: it is a question about
 * the machine rather than about anything the model has been shown.
 */
export const AppsInputSchema = z.object({})

/**
 * Go to another application.
 *
 * ### What is new here is not the reach
 *
 * Everything `switchApp` can do once it arrives, `press` and `setText` could
 * already do to the window they were standing in, and the set of places it can
 * reach is the set of applications the user already has open — it cannot launch
 * anything, and the handler refuses a bundle id that did not come back from
 * `apps`. So the *capability* barely moves.
 *
 * What moves is the user's screen, at machine speed, possibly while they are
 * reading something. `AGENT-V2.md` §11 is blunt about this being the risk most
 * likely to make a working feature feel like a malfunction, and the answer is
 * not a gate — it is that the card says where it is going and why *before* it
 * goes, and that `restore` puts things back however the run ends.
 *
 * Hence `because`: required, in the user's terms rather than the model's, and it
 * is on the card rather than only in the journal. A switch nobody can explain is
 * the one thing worse than a switch nobody expected.
 */
export const SwitchAppInputSchema = z.object({
  bundleId: z
    .string()
    .min(1)
    .max(200)
    .describe('the id exactly as the apps list gave it — not the name, and not a guess'),
  because: z
    .string()
    .min(1)
    .max(120)
    .describe('one clause the user will read as the screen moves: why you are going there')
})

/**
 * What this application can be asked to do.
 *
 * ### Why this is a different question from `look`
 *
 * `look` and `find` answer *what is on the screen* — whatever is rendered at
 * this scroll position on this page, which changes constantly and is different
 * in every app. A menu bar answers *what this application can do*, in plain
 * words, in the same place regardless of what is on screen. Every Mac
 * application has one; a survey of eight across four toolkits found no
 * exceptions.
 *
 * It is also the only surface that works when the window does not. Zed publishes
 * zero targets and one block of text to accessibility, and has 110 commands in
 * its menus. Before this tool that app was unreachable in full.
 *
 * `query` is optional and works like `find`'s: a hundred and fifty commands is a
 * lot to read when you know you want "new event". Without it the whole surface
 * comes back, which is worth doing once at the start of a run in an unfamiliar
 * app.
 */
export const MenusInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('narrow to commands matching these words. Omit to see everything the app can do')
})

/**
 * Choose one command from the menus.
 *
 * ### This is the widening that needed a new gate
 *
 * Every previous addition to this vocabulary could be argued from the keystroke
 * closure: `setText` writes but cannot submit, `press` can only reach a control
 * the user can see, `key` is an enumeration that never held Return. The menu bar
 * does not sit inside that argument at all. **Send is a menu command.** So is
 * Delete, so is Move to Trash, so is Quit. Mail sends with ⇧⌘D and the menu item
 * that does it is three words in a list this tool can read.
 *
 * If this shipped as "press whatever the menus offer", the sentence the whole
 * design rests on — *a model that wanted to send a message could not describe the
 * act* — would have stopped being true, quietly, in a file about menus.
 *
 * So it arrives with `checkMenuCommand` below, the same way `openUrl` arrived
 * with `checkUrl`, and for a stronger reason: `checkUrl` narrows a widening,
 * this one preserves the invariant the vocabulary is built on.
 *
 * ### And the same "earned by looking" rule as everywhere else
 *
 * `menu` and `name` must be a pair that came back from `menus` in this run. The
 * authority is a value Mull read off the machine, never a string the model
 * composed — the same discipline as `knownApps` for `switchApp` and
 * `knownHosts` for `openUrl`. A model that has been talked into something by
 * what it read cannot invent a command that was not on the menu.
 */
export const ChooseMenuInputSchema = z.object({
  menu: z.string().min(1).max(60).describe('the heading it was listed under, exactly: File, Edit, …'),
  name: z
    .string()
    .min(1)
    .max(200)
    .describe('the command, exactly as the menus list spelled it — ellipsis and all'),
  because: z
    .string()
    .min(1)
    .max(120)
    .describe('one clause the user will read as it happens: why you are choosing this')
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
 *
 * ### `stay`, and the thing it fixes
 *
 * `restore` was unconditional, and that was right for exactly as long as a run
 * could only fetch something and come back: leaving somebody's Slack on a
 * stranger's DM because a plan ran out of steps is rude in a way no amount of
 * correctness elsewhere makes up for.
 *
 * `switchApp` ended that. "Open Slack" is a goal whose entire content is *be in
 * Slack*, and a run that opens Slack and then dutifully puts Zed back has done
 * nothing at all, slowly, while the screen flickered. The two shapes want
 * opposite endings and nothing outside the run can tell them apart — so the
 * model that read the goal says which it was.
 *
 * Optional rather than required, because it is meaningless for the majority of
 * runs that never left the window. When it is omitted the lane guesses from
 * what actually happened — a run that moved and came back with nothing to say
 * was a destination — and the guess is documented at the point it is made.
 */
export const DoneInputSchema = z.object({
  found: z.boolean().describe('true if you arrived and the answer is in front of you'),
  because: z.string().min(1).describe('one clause: what you found, or why you could not get there'),
  stay: z
    .boolean()
    .optional()
    .describe(
      'true if being here was the point — the user asked to be taken somewhere, so leave them here. ' +
        'Omit or false if you went to fetch something and the user should be put back where they were'
    )
})

/**
 * How long a URL the agent may open.
 *
 * Not a comfort limit — a length cap is the crudest of the three things
 * `checkUrl` does, and the only one that bounds how much a single request can
 * carry. Real addresses a person would say out loud are far under it; the things
 * well over it are tracking links and payloads.
 */
export const MAX_URL_LENGTH = 300

/**
 * What the browser has open, which the accessibility tree cannot say.
 *
 * Tabs are not windows. They do not appear in `kAXWindowsAttribute`, they carry
 * no URL, and Chrome's tree shows only the frontmost one's content — so before
 * this tool Mull could not tell two tabs apart, could not say which site it was
 * looking at, and could not go back to the one it came from. All three are
 * answered by AppleScript, which reads the browser's own tab model rather than
 * its rendering.
 *
 * It takes nothing. Like every other tool here it acts on whatever is in front,
 * and unlike every other tool it works when the accessibility tree is asleep —
 * a `browser-cold` window still has a tab list.
 */
export const TabsInputSchema = z.object({})

/**
 * Go to a tab that is already open.
 *
 * Locomotion, but the cheapest kind: nothing is opened, nothing is fetched and
 * nothing leaves the machine. The tab was already there and the user could have
 * clicked it. That is why this is separate from `openUrl` below and carries no
 * gate — the set of places it can reach is the set of places already on screen.
 *
 * Either a number from the `tabs` list or a fragment of the URL, and exactly one
 * of them. The schema cannot say "exactly one" and still expose a `.shape` for
 * the SDK, so the handler says it instead — and says it as a correction the
 * model can act on rather than a refusal.
 */
export const SwitchTabInputSchema = z.object({
  index: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('the number from the tabs list — these start at 1, unlike target indexes'),
  urlContains: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('part of the tab’s URL, if you would rather match than count')
})

/**
 * Open a URL — the one tool here that reaches the network.
 *
 * ### Why this one has a gate and the other eight do not
 *
 * Every other tool in this vocabulary acts inside a window the user is looking
 * at. `press` and `setText` change what is on that screen, which is visible and
 * reversible; the closure that made them safe is that **no verb carries a
 * keystroke**, so nothing could be submitted.
 *
 * A URL is not a keystroke and it does not need one. `https://elsewhere/?q=…`
 * is a request that leaves the machine the instant it is opened, carrying
 * whatever is in it — so for the first time in this vocabulary a tool can
 * *transmit*, and the keystroke closure has nothing to say about it. That is a
 * genuine widening, and the honest framing is that it sits nearer commit than
 * near typing: a request that has been sent cannot be taken back.
 *
 * So it arrives with `checkUrl` below rather than by addition, which is what
 * `agent.test.ts`'s closure block asks of anything that widens the reach.
 *
 * What the gate does *not* claim to do is stop exfiltration outright. It closes
 * the shapes that carry a payload cheaply and it blocks the schemes that are
 * code rather than navigation. A model that has been talked into it by something
 * it read can still reach a host it was told about. See `checkUrl`.
 */
export const OpenUrlInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(MAX_URL_LENGTH)
    .describe('an https address — a place, not a query. Only somewhere the goal or a tab named'),
  newTab: z
    .boolean()
    .optional()
    .describe('true to open beside what is there; false or absent replaces the current tab')
})

/**
 * Every tool, and nothing else. The list the loop is built from.
 *
 * Ordered as a run uses them rather than alphabetically: read the window, act on
 * it, then the two ways of leaving it — between applications, and between pages
 * — and then the two that end a turn.
 */
export const AGENT_TOOLS = [
  'look',
  'find',
  'press',
  'setText',
  'key',
  'scrollTo',
  'apps',
  'switchApp',
  'menus',
  'chooseMenu',
  'tabs',
  'switchTab',
  'openUrl',
  'note',
  'done'
] as const
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

/**
 * Which model drives the loop — and why it is not the one in Settings.
 *
 * `editModel` chooses between Sonnet and Haiku for rewriting a paragraph, where
 * the work is one call, the result is shown as a diff, and being wrong costs a
 * glance. None of that describes this. A run is twenty decisions taken against a
 * window that changes underneath it, each one committing the next, with no diff
 * in front of any of them — the compounding is the whole difficulty, and it is
 * exactly what a stronger model is for.
 *
 * So the loop gets its own choice rather than inheriting the writing one. It
 * is the most expensive thing Mull does and the one where a cheaper model does
 * not merely produce a worse answer, it produces a longer, more expensive run
 * that ends up somewhere else.
 *
 * `settings.agentModel` chooses; this is what that setting defaults to and
 * what a run built without settings gets. Spelled through `MODEL_IDS` so the
 * default and the menu cannot disagree.
 */
export const AGENT_MODEL = MODEL_IDS.opus

/**
 * What one run may cost before the SDK ends it. An estimate, not a bill.
 *
 * Raised with the model above: Opus at forty turns can reach fifty cents well
 * before it has run out of turns, and a budget that binds first would turn a
 * model choice into a step limit by accident.
 */
export const AGENT_BUDGET_USD = 1.5

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

/**
 * How many tabs one `tabs` call reports.
 *
 * Generous next to `FIND_LIMIT` because a tab line is a title and a URL rather
 * than a row of a three-hundred-entry scan, and because the answer is usually
 * the whole truth: most people have fewer than forty tabs open, and the ones who
 * have three hundred are not helped by seeing all of them either.
 */
export const TAB_LIMIT = 40

/**
 * How many applications one `apps` call reports.
 *
 * Thirty is past generous — a machine with thirty applications actually open is
 * unusual, and `background only is false` has already removed the sixty daemons
 * and menu-bar extras that would otherwise be most of the list. The cap is here
 * so that an unusual machine costs a long list rather than an unbounded one.
 */
export const APP_LIMIT = 30

/**
 * How many menu commands one `menus` call reports.
 *
 * Two hundred, which is above every application measured: Chrome 152, Zed 110,
 * Notes 106, Slack 89. Deliberately not a number that trims a real menu bar,
 * because a truncated command surface is worse than a long one — the model
 * cannot tell "this app cannot do that" from "the list stopped", and the first
 * conclusion is the one it would act on.
 *
 * `query` is the answer to the list being long, not this.
 */
export const MENU_LIMIT = 200


// ---------------------------------------------------------------------------

/** Why a URL was refused, in a clause the model is handed verbatim. */
export interface UrlVerdict {
  ok: boolean
  /** Present when refused: what was wrong, and what to do instead. */
  because: string
  /** The parsed host, when there was one. Journalled, and shown on the card. */
  host: string | null
}

/**
 * Schemes a URL may use. Everything else is refused before anything is parsed
 * for meaning.
 *
 * The exclusions are the point, and each one is a category rather than a
 * nuisance. `javascript:` typed into a browser's own address bar runs in the
 * origin of whatever is loaded — it is arbitrary code inside the user's logged-in
 * session, which would make every other control in this file decorative.
 * `file:` reads the disk. `data:` is a document the agent wrote, rendered as a
 * page, which is a way to smuggle a script past a check on the *address*.
 */
const URL_SCHEMES: ReadonlySet<string> = new Set(['https:', 'http:'])

/**
 * May the agent open this?
 *
 * Pure, and called twice on purpose — once in `canUseTool`, where a refusal is
 * synchronous and happens before any handler runs, and again in the handler
 * itself, for the same belt-and-braces reason every handler re-checks the stop.
 * Keeping it here rather than in either caller is what lets the policy be read
 * and tested in one piece.
 *
 * ### The three rules
 *
 * 1. **An http(s) address, and nothing else.** See `URL_SCHEMES` — the others
 *    are code, not navigation.
 * 2. **No credentials in the address.** `https://user:pass@host/` is both a way
 *    to smuggle a payload past a look at the host and a way to hand a site
 *    something it was never given.
 * 3. **A place, not a question — unless you are already there.** A host that was
 *    open in a tab when the run began may be addressed however it likes: the
 *    agent could already read that page, so a query string tells it nothing it
 *    did not have. Anywhere else gets the bare address, with no query and no
 *    fragment — which is enough to reach `calendar.google.com` and not enough to
 *    carry what was on the screen there.
 *
 * ### What this does not do, stated plainly
 *
 * It is not an exfiltration proof. Rule 3 makes a payload expensive rather than
 * impossible — a path is still a path, and forty turns is forty requests. What
 * it buys is that the cheap, single-shot version of the attack does not work,
 * that every attempt is one visible row on the card, and that the catastrophic
 * schemes are unreachable. The complete answer is the same asymmetry `justSend`
 * uses: a budget granted from the user's own words before the run starts, which
 * nothing on a page can reach. That is `AGENT-V2.md` §7 and it is not this.
 */
export function checkUrl(raw: string, knownHosts: ReadonlySet<string> = new Set()): UrlVerdict {
  const trimmed = raw.trim()
  if (trimmed.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      host: null,
      because: `that address is ${trimmed.length} characters and the limit is ${MAX_URL_LENGTH}. Open the site itself and find your way from there`
    }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return {
      ok: false,
      host: null,
      because: 'that is not an address. Give a whole one, starting with https://'
    }
  }

  if (!URL_SCHEMES.has(parsed.protocol)) {
    return {
      ok: false,
      host: null,
      because: `“${parsed.protocol}” addresses cannot be opened here — only https and http. There is no way to run anything in the page`
    }
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      host: parsed.hostname || null,
      because: 'addresses with a name and password in them cannot be opened here'
    }
  }
  if (!parsed.hostname) {
    return { ok: false, host: null, because: 'that address has no site in it' }
  }

  const host = parsed.hostname.toLowerCase()
  if (!knownHosts.has(host) && (parsed.search || parsed.hash)) {
    return {
      ok: false,
      host,
      because:
        `nothing here is open at ${host}, so it can only be opened at its plain address — ` +
        'everything after the “?” or the “#” has to come off. Open the site and find your way from there'
    }
  }

  return { ok: true, host, because: '' }
}

// ---------------------------------------------------------------------------

/** Why a menu command was refused, in a clause the model is handed verbatim. */
export interface MenuVerdict {
  ok: boolean
  /** Present when refused: what was wrong, and what to do instead. */
  because: string
}

/**
 * Commands that commit, and are therefore the thing this vocabulary cannot do.
 *
 * ### Read this before adding a menu feature
 *
 * `AgentKeySchema` keeps Return unexpressible, and that one fact is what lets
 * every other tool here be argued as visible and reversible. The menu bar
 * routes straight around it: Mail's Send is a menu item, Slack's is a menu
 * item, and "the agent cannot press ⏎" would have become a true statement about
 * an irrelevant mechanism.
 *
 * So a send is refused by *name* here. That is an allow-list's evil twin and
 * this codebase is on record about which way that fails — `actions.ts`'s
 * `DESTRUCTIVE` docstring says it plainly: a phrasing nobody listed gets
 * through, and every word added makes it strictly safer. That trade is
 * acceptable for a backstop under a deny-list. It would not be acceptable as
 * the *only* thing standing between a model and sending mail, which is why it is
 * not: `chooseMenu` also refuses anything that did not come back from `menus`,
 * the card shows the command before it runs, and Escape stops the run.
 *
 * ### The four groups, and why each is here
 *
 * **Sending.** The closure. Not negotiable, and the reason this function exists.
 *
 * **Destruction.** The same list `DESTRUCTIVE` carries, restated because this
 * path does not go through `ActionExecutor` and a guard that is not on the path
 * is decoration.
 *
 * **Ending things.** Quit, Log Out, Restart, Shut Down. Not merely destructive
 * — they take Mull down mid-run, so the stop that is supposed to be the last
 * defence goes with them.
 *
 * **Spending.** Rare in a menu bar and free to include.
 *
 * Plain `Close` is deliberately absent: closing a tab is ordinary, common, and
 * the kind of thing a run legitimately needs, and denying it would cost more
 * than the unsaved window it might occasionally protect.
 */
const MENU_REFUSED: ReadonlyArray<{ pattern: RegExp; because: string }> = [
  {
    pattern: /\b(send|submit|post|publish|deliver|share|invite)\b/iu,
    because:
      'Mull does not send things. Put the text where it belongs and leave the sending to the user — ' +
      'that is the one thing this agent is built not to do'
  },
  {
    // `block` carries a lookahead because "Block Quote" is a paragraph style in
    // every writing app on the machine, and refusing it is the kind of nonsense
    // that gets a guard deleted rather than corrected. Found by running the real
    // list against Notes, not by thinking about it.
    pattern:
      /\b(delete|remove|trash|erase|empty|discard|clear|reset|revoke|deactivate|unsubscribe|block(?!\s*quote)|archive|leave|uninstall)\b/iu,
    because: 'Mull will not choose a command that destroys something. Ask the user to do it'
  },
  {
    pattern: /\b(quit|log ?out|sign ?out|log ?off|restart|shut ?down|force ?quit)\b/iu,
    because: 'that would end the application, and this run with it'
  },
  {
    pattern: /\b(buy|purchase|order|pay|checkout|subscribe)\b/iu,
    because: 'Mull will not choose a command that spends money'
  }
]

/**
 * May the agent choose this command?
 *
 * Pure, and called twice on purpose — once in `canUseTool`, where a refusal is
 * synchronous and lands before any handler runs, and again in the handler, for
 * the same belt-and-braces reason every handler re-checks the stop. The shape
 * mirrors `checkUrl` exactly, because it is doing the same job in the same place
 * in the design.
 *
 * Both halves of the path are tested, because a menu is two names and only one
 * of them is usually the interesting one: `File ▸ Move to Trash` is caught on
 * the item, and a hypothetical `Send ▸ …` is caught on the heading.
 */
export function checkMenuCommand(menu: string, name: string): MenuVerdict {
  const said = `${menu} ${name}`
  for (const { pattern, because } of MENU_REFUSED) {
    if (pattern.test(said)) return { ok: false, because }
  }
  return { ok: true, because: '' }
}

// ---------------------------------------------------------------------------

/**
 * Which applications have a tab model worth asking about, and in whose dialect.
 *
 * Two dictionaries, not one. Chromium's browsers all inherit Chrome's — a window
 * has `tabs`, an `active tab index`, and a tab has a `title`. Safari's predates
 * it and disagrees on every one of those nouns: a tab has a `name`, and the
 * window points at a `current tab` rather than an index. Anything not in this
 * table is a browser Mull will not pretend to understand.
 *
 * Arc is deliberately absent. It is scriptable, but its model is spaces rather
 * than windows-of-tabs, and a bridge that half-works against it would be worse
 * than one that says plainly that it cannot.
 */
export const BROWSERS: Readonly<Record<string, { name: string; dialect: 'chromium' | 'safari' }>> = {
  'com.google.Chrome': { name: 'Chrome', dialect: 'chromium' },
  'com.google.Chrome.beta': { name: 'Chrome Beta', dialect: 'chromium' },
  'com.google.Chrome.canary': { name: 'Chrome Canary', dialect: 'chromium' },
  'com.brave.Browser': { name: 'Brave', dialect: 'chromium' },
  'com.microsoft.edgemac': { name: 'Edge', dialect: 'chromium' },
  'com.vivaldi.Vivaldi': { name: 'Vivaldi', dialect: 'chromium' },
  'com.operasoftware.Opera': { name: 'Opera', dialect: 'chromium' },
  'com.apple.Safari': { name: 'Safari', dialect: 'safari' },
  'com.apple.SafariTechnologyPreview': { name: 'Safari Technology Preview', dialect: 'safari' }
}

/** Is the thing in front of us something whose tabs can be read? */
export function browserOf(
  bundleId: string | null | undefined
): { name: string; dialect: 'chromium' | 'safari' } | null {
  if (!bundleId) return null
  return BROWSERS[bundleId] ?? null
}
