/**
 * Typed JSON-RPC contract for the Swift sidecar (`mull-mac`).
 *
 * SOURCE OF TRUTH for the Electron <-> sidecar boundary (docs/PLAN.md,
 * "Key contracts"). Change this file first; the Swift side mirrors it.
 *
 * FRAMING: newline-delimited JSON (ndjson) over the sidecar's stdio.
 * One JSON-RPC 2.0 message per line, UTF-8, no embedded newlines:
 *
 *   -> {"jsonrpc":"2.0","id":1,"method":"insertText","params":{...}}\n
 *   <- {"jsonrpc":"2.0","id":1,"result":{...}}\n
 *
 * Requests flow Electron -> sidecar; the sidecar may also emit notifications
 * (no `id`) for async events (e.g. secure-input changes) in later milestones.
 *
 * Every method's params/result are zod schemas; the inferred types are the
 * only types the TS side should use. The Swift side mirrors these shapes in
 * Codable structs (validated by XCTest fixtures against the same JSON).
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Common shapes
// ---------------------------------------------------------------------------

/** Insertion strategies, in preference order: AX write -> paste-swap -> keystroke typing. */
export const InsertionStrategySchema = z.enum(['ax', 'paste', 'type'])
export type InsertionStrategy = z.infer<typeof InsertionStrategySchema>

export const AppRefSchema = z.object({
  bundleId: z.string(),
  name: z.string(),
  pid: z.number().int()
})
export type AppRef = z.infer<typeof AppRefSchema>

export const SelectionSchema = z.object({
  /**
   * UTF-16 offset of the selection start within the element's *whole* value —
   * absolute, not relative to the clamped `FocusedElement.text` window, so it
   * can be handed straight back to `replaceRange`. -1 when unknown.
   */
  start: z.number().int(),
  length: z.number().int().nonnegative(),
  text: z.string()
})
export type Selection = z.infer<typeof SelectionSchema>

// ---------------------------------------------------------------------------
// Method schemas
// ---------------------------------------------------------------------------

export const InitParamsSchema = z.object({
  /** Contract version the host was built against; sidecar rejects mismatches. */
  protocolVersion: z.number().int().positive()
})
export const InitResultSchema = z.object({
  ok: z.literal(true),
  sidecarVersion: z.string(),
  protocolVersion: z.number().int().positive(),
  pid: z.number().int()
})

export const CheckPermissionsParamsSchema = z.object({})
export const CheckPermissionsResultSchema = z.object({
  /** AXIsProcessTrusted() — gates everything else the sidecar does. */
  accessibility: z.boolean(),
  /** IOHIDCheckAccess for Input Monitoring (needed by the event tap in M3). */
  inputMonitoring: z.boolean(),
  /**
   * CGPreflightScreenCaptureAccess() — gates the screenshot half of
   * `windowContext` (M5a). Defaulted rather than required so the field can be
   * read from a result that predates it without throwing.
   */
  screenRecording: z.boolean().default(false)
})

export const PromptAccessibilityParamsSchema = z.object({})
export const PromptAccessibilityResultSchema = z.object({
  /** True if the system prompt / System Settings pane was presented. */
  prompted: z.boolean(),
  /** Trust state re-read after prompting (grants require app restart on some OSes). */
  accessibility: z.boolean()
})

export const FrontmostAppParamsSchema = z.object({})
export const FrontmostAppResultSchema = z.object({
  app: AppRefSchema.nullable(),
  windowTitle: z.string().nullable()
})

export const FocusedElementParamsSchema = z.object({
  /**
   * Max surrounding text to return on each side of the caret, counted in UTF-16
   * units (what AX itself indexes by), not bytes. Default 2048.
   */
  contextBytes: z.number().int().positive().max(8192).default(2048)
})
export const FocusedElementResultSchema = z.object({
  /** Null when nothing focused / element unreadable (e.g. non-AX app). */
  element: z
    .object({
      role: z.string(),
      /** AX reports the value as settable — i.e. an AX write has a chance. */
      editable: z.boolean(),
      /** Surrounding text, clamped to ±contextBytes around the caret. */
      text: z.string(),
      /** Absolute UTF-16 offset at which `text` begins (0 unless clamped). */
      textStart: z.number().int().nonnegative(),
      /** True when `text` is a window onto a longer value. */
      truncated: z.boolean(),
      selection: SelectionSchema.nullable()
    })
    .nullable(),
  app: AppRefSchema.nullable(),
  /** Why `element` is null: 'no-accessibility' | 'no-focused-element' | 'unreadable'. */
  reason: z.string().nullable()
})

/**
 * The selection, wherever it is — not only in the focused element.
 *
 * `focusedElement` answers "what is the caret in", which is a different
 * question from "what has the user highlighted". They came apart the first time
 * someone selected a sent Slack message while the composer held focus: Mull saw
 * nothing selected, decided there was nothing to edit, and typed the
 * instruction into the box.
 */
export const SelectedTextParamsSchema = z.object({
  /**
   * Permit the ⌘C fallback when AX finds nothing.
   *
   * It presses a key in someone else's app and swaps their pasteboard (and
   * swaps it back), so it is never taken unless the host asks — which it does
   * only for an utterance that already looks like an instruction.
   */
  allowCopy: z.boolean().optional()
})
export const SelectedTextResultSchema = z.object({
  text: z.string().nullable(),
  /**
   * Whether an AX write into the element holding this selection has a chance.
   * False is the interesting case: text the user can point at but Mull must not
   * try to rewrite in place — a sent message, a web page, a PDF.
   */
  editable: z.boolean(),
  /** 'focused' | 'tree' | 'copy'; null when nothing was found. */
  source: z.string().nullable(),
  reason: z.string().nullable()
})

/**
 * What is on screen, in both the forms Mull can read it.
 *
 * `focusedElement` answers "what is the caret in" and `selectedText` answers
 * "what is highlighted". Neither answers *"reply to this"*, because "this" is
 * the conversation above the composer — text nobody selected, in elements
 * nobody focused. This verb reads that, two ways at once:
 *
 *   blocks      the window's Accessibility tree in reading order. Exact text,
 *               exact names, no OCR in the loop.
 *   screenshot  one window, rendered. Everything the AX tree has no
 *               representation for: charts, canvases, PDFs, layout.
 *
 * They are complementary rather than redundant. The harvest knows how a name
 * is spelled; the picture knows what the thing actually looks like.
 */
export const ContextBlockSchema = z.object({
  role: z.string(),
  text: z.string(),
  /** The element's own label, when `text` came from its value ("To:"). */
  label: z.string().nullable(),
  /** Where the caret is. True even when `text` is empty — an empty composer
   *  is not nothing, it is the place a reply goes. */
  focused: z.boolean(),
  selected: z.boolean()
})
export type ContextBlock = z.infer<typeof ContextBlockSchema>

export const WindowContextParamsSchema = z.object({
  maxChars: z.number().int().positive().max(32_000).optional(),
  /**
   * Wall-clock bound on the AX walk. The other budgets bound the work; this
   * one bounds the *waiting*, because every attribute read is a synchronous
   * message into another process and an app that has stopped answering will
   * hang any walk that only counts nodes.
   */
  deadlineMs: z.number().int().min(50).max(2_000).optional(),
  /** Take the picture too. Costs the Screen Recording grant. */
  screenshot: z.boolean().optional()
})

export const WindowContextResultSchema = z.object({
  app: AppRefSchema.nullable(),
  windowTitle: z.string().nullable(),
  blocks: z.array(ContextBlockSchema),
  /** A budget stopped the walk before the tree ran out. */
  truncated: z.boolean(),
  /** Which one: 'complete' | 'nodes' | 'chars' | 'deadline' | 'no-window' | 'no-accessibility'. */
  stoppedBy: z.string(),
  harvestMs: z.number().int().nonnegative(),
  /**
   * Elements the walk visited.
   *
   * Optional because it is additive: a sidecar binary built before this field
   * existed omits it, and a host that refused to parse that would turn a
   * missing diagnostic into no accessibility at all. `npm run build:sidecar` is
   * a separate manual step from `npm run dev`, so a stale binary is not a
   * hypothetical — see the note in `services/browser.ts`.
   *
   * Paired with `blocks.length` it answers the question an empty read cannot
   * answer alone: two blocks out of 190 nodes is a window with nothing in it,
   * two blocks out of 3800 is a window whose text this walk could not see.
   */
  nodes: z.number().int().nonnegative().optional(),
  /** Subtrees abandoned at the depth bound — the budget `stoppedBy` never names. */
  clipped: z.number().int().nonnegative().optional(),
  /** The deepest level the walk reached, against that bound. */
  deepest: z.number().int().nonnegative().optional(),
  /** What the app said when asked to build a tree: 'enabled' | 'unsupported'. */
  wake: z.string().optional(),
  /**
   * A JPEG on disk, not bytes on the wire. Base64 in an ndjson line is a third
   * bigger than the file and lands in the log; the host reads this path, sends
   * it, and deletes it.
   */
  screenshot: z
    .object({
      path: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      bytes: z.number().int(),
      elapsedMs: z.number().int()
    })
    .nullable(),
  /** Why there is no picture: 'not-requested' | 'no-screen-recording' | … */
  screenshotReason: z.string().nullable()
})

/**
 * What can be pressed here — the window read a third way.
 *
 * `windowContext` answers *what does this window say*. This answers *what can
 * be done to it*, and the two are near complements: the reading harvest
 * deny-lists `AXButton`, `AXMenuItem`, `AXPopUpButton`, `AXCheckBox` and
 * `AXTabGroup` as furniture, which is right for reading a conversation and
 * removes every single thing you would press.
 *
 * **The model is shown this list and answers with an `index`, never a name.**
 * That is the whole reason pressing things in someone else's window is safe to
 * build. A design where the model says "press the Send button" and Mull goes
 * looking is a guess dressed as a lookup — there are two buttons called Send,
 * and "Priya Sharma" sits beside "Priya (you)". Enumerating first turns it into
 * a comparison of integers.
 *
 * Still a read. Nothing in this verb presses, focuses or types.
 */
export const UiTargetSchema = z.object({
  /** The address. Stable only within one `harvestId`. */
  index: z.number().int().nonnegative(),
  role: z.string(),
  subrole: z.string().nullable(),
  /** Never empty — an unnamed control is dropped, because a model cannot pick
   *  it and a user cannot check it on the card. */
  title: z.string(),
  help: z.string().nullable(),
  value: z.string().nullable(),
  /** Screen rectangle, so the list can be lined up against the screenshot. */
  frame: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .nullable(),
  actions: z.array(z.string()),
  enabled: z.boolean(),
  focused: z.boolean(),
  /** 'press' | 'type'. Not interchangeable: only a `type` target accepts text,
   *  and the executor refuses anything that is not a search field. */
  kind: z.enum(['press', 'type'])
})
export type UiTarget = z.infer<typeof UiTargetSchema>

export const UiTargetsParamsSchema = z.object({
  maxTargets: z.number().int().positive().max(400).optional(),
  deadlineMs: z.number().int().min(50).max(2_000).optional()
})

export const UiTargetsResultSchema = z.object({
  app: AppRefSchema.nullable(),
  windowTitle: z.string().nullable(),
  /**
   * Names the set of element handles the sidecar is holding for this scan.
   *
   * A press quotes it back, so a step decided against a stale look is refused
   * rather than landing on whatever now occupies that index. Empty when the
   * scan found nothing to hold.
   */
  harvestId: z.string(),
  targets: z.array(UiTargetSchema),
  truncated: z.boolean(),
  /**
   * 'complete' | 'nodes' | 'deadline' | 'targets' | 'no-window'
   * | 'no-accessibility' | 'secure-input' | 'tree-warming' | 'browser-cold'
   *
   * `browser-cold` is the one that is not about budgets. A Chromium browser
   * builds its page accessibility only once something wakes it, and until then
   * it answers every query politely with its own furniture — Back, Reload, the
   * tab strip — and nothing whatsoever from the page. The targets are real and
   * pressable; they are simply not what anybody meant. Measured on Chrome 152:
   * asleep, 190 nodes and no page; awake, 3836 nodes with 2999 from the page.
   *
   * Said out loud because "this page has no buttons" and "this browser is not
   * showing me the page" are indistinguishable from the sidecar's side and
   * want opposite responses from the user.
   */
  stoppedBy: z.string(),
  scanMs: z.number().int().nonnegative(),

  /**
   * What the walk walked through, and how much of it was a web page.
   *
   * All four are optional for the same reason `nodes` above is: they are
   * additive fields on an unchanged verb, and a sidecar that predates them
   * should degrade to "unknown" rather than to "no accessibility".
   *
   * They exist because `stoppedBy` alone could not describe the failure that
   * prompted them. A Chrome window showing Google Calendar answered
   * `stoppedBy: 'complete'` with eighteen targets — the tab strip, Back,
   * Reload, New Tab — which is indistinguishable from a small window that
   * genuinely holds eighteen buttons. With `nodes: 190, webNodes: 0` beside it,
   * it is not ambiguous at all.
   */
  /** Elements visited, against the scan's `maxNodes`. */
  nodes: z.number().int().nonnegative().optional(),
  /**
   * How many of those carried an `AXDOMIdentifier`.
   *
   * **Not a page detector**, though it was built as one: Chrome's own toolbar
   * and tab strip are WebUI and carry DOM identifiers, so a Chrome window
   * showing none of the page still measures 112 "web" nodes out of 119. Use
   * `webAreas`. This one is kept because the ratio is diagnostic.
   */
  webNodes: z.number().int().nonnegative().optional(),
  /**
   * Web *documents* — nodes whose role is `AXWebArea`. The honest test: a
   * browser rendering a page has at least one, a browser whose renderer
   * accessibility is off has none however much furniture it publishes.
   */
  webAreas: z.number().int().nonnegative().optional(),
  /** Targets dropped as the same control seen twice. Large in a live browser. */
  duplicates: z.number().int().nonnegative().optional(),
  /**
   * Subtrees abandoned at `maxDepth`, and how deep the walk got.
   *
   * The depth bound is the only budget that never reached `stoppedBy`: it drops
   * the subtree and lets the walk finish, so a window read to a depth of 40 and
   * no further reports itself "complete". A non-zero `clipped` is that walk
   * saying it stopped early after all.
   */
  clipped: z.number().int().nonnegative().optional(),
  deepest: z.number().int().nonnegative().optional(),
  /** Is this an app that keeps its page behind a renderer at all? */
  chromium: z.boolean().optional(),
  /**
   * What the app said when asked to build an accessibility tree:
   * 'enabled' — the switch was thrown and the tree is being built;
   * 'unsupported' — the app has no such attribute.
   *
   * Native apps answer 'unsupported' and nothing is lost: they have no renderer
   * to wake. A **browser** answering 'unsupported' is the interesting case —
   * current Chrome does, so Mull has no lever on that window at all, and a
   * `browser-cold` scan from one of those will not warm however long it is
   * asked again.
   */
  wake: z.string().optional()
})

/**
 * Act on one enumerated target — quoting the scan back.
 *
 * `expectRole` and `expectTitle` are what the caller was shown. The sidecar
 * re-reads the element and refuses on a mismatch, which is the read-back
 * discipline `insertText` has, moved to *before* the act rather than after.
 * That order is deliberate and the two cases are genuinely different: a write
 * can be checked afterwards and undone, a press cannot, and its failure mode is
 * hitting the wrong thing rather than hitting nothing. Between the scan the
 * model reasoned about and this call the user may have scrolled, or a
 * notification may have pushed a row down. A moved UI is the expected case.
 */
export const TargetActionParamsSchema = z.object({
  harvestId: z.string(),
  index: z.number().int().nonnegative(),
  expectRole: z.string().optional(),
  expectTitle: z.string().optional()
})

export const TargetActionResultSchema = z.object({
  ok: z.boolean(),
  /**
   * 'stale-scan' — that scan has aged out; look again.
   * 'no-such-target' — the scan is held but never had this many targets.
   * 'gone' — the handle outlived the element; the window has been replaced.
   * 'changed' — the element is no longer what the caller was shown.
   * 'disabled' | 'not-pressable' | 'not-typeable' | 'press-refused'
   * | 'focus-refused' | 'not-scrollable' | 'scroll-refused' | 'secure-input'
   * | 'no-accessibility'
   */
  reason: z.string().nullable(),
  /** What the element says it is now, so a refusal can be explained. */
  actualRole: z.string().nullable(),
  actualTitle: z.string().nullable()
})

/**
 * One navigation key, no modifiers, ever.
 *
 * **A separate verb from `keyChord`, and that is the point.** `keyChord` can
 * express ⏎ and ⌘-anything; this one structurally cannot. ⏎ is how Slack,
 * Messages, Discord and Mail all send, so it is the actuator — and the
 * navigator is handed an interface in which the actuator cannot be named. That
 * keeps "the model cannot send a message" a property of the type rather than a
 * promise about behaviour, the same seam as `ClassifiedIntent` having no
 * `send` field.
 *
 * Not a filter over `keyChord`'s map either: a filter is one edit away from
 * letting ⏎ through, and this list is one where it was never present.
 *
 * ### `backTab`, and why it does not break the sentence above
 *
 * It posts ⇧⇥ — a modifier, in a verb whose docstring says there are none. The
 * property that matters is not "no modifier is ever posted", it is **the caller
 * cannot compose a chord**: the shift is welded to a name inside
 * `RealSystem.navKeyCodes`, so the set of keystrokes that can leave this verb is
 * exactly as long as that literal, and ⏎ is still not in it.
 *
 * It earns the entry by being unreachable any other way. ⌘F and ⌘S have menu
 * commands in every application; moving *backwards* through a form has none.
 */
export const NavKeySchema = z.enum([
  'escape',
  'tab',
  'backTab',
  'up',
  'down',
  'left',
  'right',
  'pageUp',
  'pageDown'
])
export type NavKey = z.infer<typeof NavKeySchema>

export const NavKeyParamsSchema = z.object({ key: NavKeySchema })
export const NavKeyResultSchema = z.object({
  sent: z.boolean(),
  reason: z.string().nullable()
})

export const PromptScreenRecordingParamsSchema = z.object({})
export const PromptScreenRecordingResultSchema = z.object({
  prompted: z.boolean(),
  /** Re-read after prompting. The grant needs a relaunch, so this is usually
   *  still false immediately after the user clicks Allow — say so, don't lie. */
  screenRecording: z.boolean()
})

export const InsertTextParamsSchema = z.object({
  text: z.string(),
  /** Forced strategy; omit and the sidecar pastes (the host owns the chain). */
  strategy: InsertionStrategySchema.optional(),
  /**
   * How long to let the target app service a paste before the pasteboard is
   * restored. Tuned per app in `src/main/services/insertion-table.ts`: native
   * Cocoa apps are done in ~80ms, Electron targets need considerably longer.
   */
  settleMs: z.number().int().min(0).max(2000).optional()
})
export const InsertTextResultSchema = z.object({
  inserted: z.boolean(),
  strategyUsed: InsertionStrategySchema.nullable(),
  /** Populated when inserted=false (e.g. 'secure-input', 'no-focused-element'). */
  reason: z.string().nullable(),
  /**
   * Did the sidecar *read back* the text it wrote? Only the `ax` strategy can:
   * it re-reads the element afterwards. `paste` and `type` post key events into
   * the void and report null — an honest "don't know", never a cheerful true.
   */
  verified: z.boolean().nullable(),
  /** Caret offset after the write, when AX could report it (for undo). */
  caret: z.number().int().nullable()
})

export const ReplaceSelectionParamsSchema = z.object({
  text: z.string(),
  strategy: InsertionStrategySchema.optional(),
  settleMs: z.number().int().min(0).max(2000).optional()
})
export const ReplaceSelectionResultSchema = z.object({
  replaced: z.boolean(),
  strategyUsed: InsertionStrategySchema.nullable(),
  reason: z.string().nullable(),
  verified: z.boolean().nullable(),
  caret: z.number().int().nullable(),
  /** What was selected before the write — the `before` half of a journal entry. */
  replacedText: z.string().nullable()
})

/**
 * Write to an explicit range of the focused element. AX-only by design: this is
 * how undo removes exactly what Mull inserted, and a key-event fallback that
 * "probably deletes the right characters" is worse than refusing.
 */
export const ReplaceRangeParamsSchema = z.object({
  start: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  text: z.string(),
  /** Refuse unless the range currently holds exactly this text. */
  expect: z.string().optional()
})
export const ReplaceRangeResultSchema = z.object({
  replaced: z.boolean(),
  reason: z.string().nullable(),
  verified: z.boolean().nullable()
})

export const SecureInputStateParamsSchema = z.object({})
export const SecureInputStateResultSchema = z.object({
  /** IsSecureEventInputEnabled() — when true, all insertion is hard-disabled. */
  active: z.boolean(),
  /** PID holding secure input, when the OS exposes it. */
  pid: z.number().int().nullable()
})

export const ActivateAppParamsSchema = z.object({
  bundleId: z.string()
})
export const ActivateAppResultSchema = z.object({
  activated: z.boolean(),
  reason: z.string().nullable()
})

// ---------------------------------------------------------------------------
// Hotkey tap (M3)
// ---------------------------------------------------------------------------

export const StartHotkeyTapParamsSchema = z.object({
  /**
   * Every chord to watch, at once (M5a).
   *
   * They used to be alternatives chosen in Settings; they now mean different
   * things — ⌥Space dictates, Fn instructs — so the tap watches both and says
   * which one fired in the notification.
   */
  chords: z.array(z.enum(['opt-space', 'fn'])).min(1),
  /**
   * Consume the chord so the focused app never sees it — this is what removes
   * the stray U+00A0 that ⌥Space types. Ignored for Fn, which the window
   * server does not let anyone swallow.
   */
  swallow: z.boolean().optional()
})
export const StartHotkeyTapResultSchema = z.object({
  started: z.boolean(),
  reason: z.string().nullable(),
  /**
   * Is ⌥Space being consumed? Fn never is — the window server handles the globe
   * key above this layer — so with both watched this reports the swallowable
   * one, and the host tells the user what to do about the other.
   */
  swallowing: z.boolean()
})

export const StopHotkeyTapParamsSchema = z.object({})
export const StopHotkeyTapResultSchema = z.object({ stopped: z.boolean() })

export const KeyChordParamsSchema = z.object({
  /** Key name, e.g. 'v', 'return', 'escape'. */
  key: z.string(),
  modifiers: z.array(z.enum(['cmd', 'shift', 'alt', 'ctrl', 'fn'])).default([])
})
export const KeyChordResultSchema = z.object({
  sent: z.boolean(),
  reason: z.string().nullable()
})

// ---------------------------------------------------------------------------
// The RPC map — one entry per method; both sides are generated/checked from it
// ---------------------------------------------------------------------------

/**
 * 2 (M2): `focusedElement` gained `textStart`/`truncated`/`reason`, the write
 * verbs gained `verified`/`caret`, and `replaceRange` was added.
 * 3 (M3): the hotkey event tap — `startHotkeyTap`/`stopHotkeyTap`, and with
 * them the sidecar's first *notifications*, messages it sends unprompted.
 * 4 (M4.2): `selectedText`, which looks past the focused element. The writes
 * moved with it: an AX write now targets the element that holds the selection
 * rather than whatever has focus, because reading from one and writing to the
 * other is how you overwrite the wrong text.
 * 5 (M5a): `windowContext` — the whole window, as text and as a picture — plus
 * `promptScreenRecording` and a `screenRecording` field on `checkPermissions`.
 * The sidecar's deployment target moves to macOS 14 with it: the capture is
 * `SCScreenshotManager`, and the deprecated `CGWindowListCreateImage` is not a
 * thing to build a new feature on.
 * 6 (M5b): `startHotkeyTap` takes `chords` rather than one `chord`. The two
 * keys stopped being alternatives and became two verbs — ⌥Space dictates and
 * Fn instructs — so the tap watches both at once and names the one that fired.
 *
 * 7 (M5a Stage 5): `uiTargets` — the focused window read a third way, as a
 * numbered list of what can be pressed or typed into. Still a read; the verbs
 * that act on the numbering come with it and are guarded separately.
 *
 * The `init` handshake rejects a mismatch, so a stale `mull-mac` binary fails
 * loudly at boot instead of returning shapes the host can't parse.
 */
export const SIDECAR_PROTOCOL_VERSION = 8

// ---------------------------------------------------------------------------
// Notifications: sidecar -> host, no id, no reply.
// ---------------------------------------------------------------------------

export const HotkeyNotificationSchema = z.object({
  phase: z.enum(['down', 'up']),
  chord: z.enum(['opt-space', 'fn'])
})

/**
 * Validated the same way results are. A notification is the one message the
 * host did not ask for, which makes it the easiest place for a drifting binary
 * to go unnoticed — so it gets a schema too, and an unknown method is logged
 * rather than silently dropped.
 */
export const SidecarNotifications = {
  hotkey: HotkeyNotificationSchema
} as const

export type SidecarNotificationName = keyof typeof SidecarNotifications
export type SidecarNotification<N extends SidecarNotificationName> = z.infer<
  (typeof SidecarNotifications)[N]
>

export const SidecarMethods = {
  init: { params: InitParamsSchema, result: InitResultSchema },
  checkPermissions: { params: CheckPermissionsParamsSchema, result: CheckPermissionsResultSchema },
  promptAccessibility: {
    params: PromptAccessibilityParamsSchema,
    result: PromptAccessibilityResultSchema
  },
  frontmostApp: { params: FrontmostAppParamsSchema, result: FrontmostAppResultSchema },
  focusedElement: { params: FocusedElementParamsSchema, result: FocusedElementResultSchema },
  selectedText: { params: SelectedTextParamsSchema, result: SelectedTextResultSchema },
  windowContext: { params: WindowContextParamsSchema, result: WindowContextResultSchema },
  uiTargets: { params: UiTargetsParamsSchema, result: UiTargetsResultSchema },
  pressTarget: { params: TargetActionParamsSchema, result: TargetActionResultSchema },
  focusTarget: { params: TargetActionParamsSchema, result: TargetActionResultSchema },
  scrollTarget: { params: TargetActionParamsSchema, result: TargetActionResultSchema },
  navKey: { params: NavKeyParamsSchema, result: NavKeyResultSchema },
  promptScreenRecording: {
    params: PromptScreenRecordingParamsSchema,
    result: PromptScreenRecordingResultSchema
  },
  insertText: { params: InsertTextParamsSchema, result: InsertTextResultSchema },
  replaceSelection: { params: ReplaceSelectionParamsSchema, result: ReplaceSelectionResultSchema },
  replaceRange: { params: ReplaceRangeParamsSchema, result: ReplaceRangeResultSchema },
  secureInputState: { params: SecureInputStateParamsSchema, result: SecureInputStateResultSchema },
  activateApp: { params: ActivateAppParamsSchema, result: ActivateAppResultSchema },
  keyChord: { params: KeyChordParamsSchema, result: KeyChordResultSchema },
  startHotkeyTap: {
    params: StartHotkeyTapParamsSchema,
    result: StartHotkeyTapResultSchema
  },
  stopHotkeyTap: { params: StopHotkeyTapParamsSchema, result: StopHotkeyTapResultSchema }
} as const

export type SidecarMethodName = keyof typeof SidecarMethods

export type SidecarParams<M extends SidecarMethodName> = z.input<
  (typeof SidecarMethods)[M]['params']
>
export type SidecarResult<M extends SidecarMethodName> = z.infer<
  (typeof SidecarMethods)[M]['result']
>

/**
 * The typed client surface: what `SidecarClient` (M1 proper) implements over
 * the ndjson transport, and what fakes implement in tests.
 */
export type SidecarApi = {
  [M in SidecarMethodName]: (params: SidecarParams<M>) => Promise<SidecarResult<M>>
}
