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
  inputMonitoring: z.boolean()
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
  chord: z.enum(['opt-space', 'fn']),
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
  /** False when the tap is watching but the key still reaches the app. */
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
 *
 * The `init` handshake rejects a mismatch, so a stale `mull-mac` binary fails
 * loudly at boot instead of returning shapes the host can't parse.
 */
export const SIDECAR_PROTOCOL_VERSION = 4

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
