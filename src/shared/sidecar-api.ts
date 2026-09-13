/**
 * Typed JSON-RPC contract for the Swift sidecar (`mull-mac`).
 *
 * SOURCE OF TRUTH for the Electron <-> sidecar boundary (docs/PLAN.md,
 * "Key contracts"). The sidecar does not exist yet (built in M1 proper /
 * M2); this file defines the wire contract both sides are built against.
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
  /** UTF-16 offset of the selection start within `FocusedElement.text` (-1 if unknown). */
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
  /** Max bytes of surrounding text to return on each side of the caret. Default 2048 (±2KB). */
  contextBytes: z.number().int().positive().max(8192).default(2048)
})
export const FocusedElementResultSchema = z.object({
  /** Null when nothing focused / element unreadable (e.g. non-AX app). */
  element: z
    .object({
      role: z.string(),
      editable: z.boolean(),
      /** Surrounding text, clamped to ±contextBytes around the caret. */
      text: z.string(),
      selection: SelectionSchema.nullable()
    })
    .nullable(),
  app: AppRefSchema.nullable()
})

export const InsertTextParamsSchema = z.object({
  text: z.string(),
  /** Forced strategy; omit to let the sidecar walk the ax -> paste -> type chain. */
  strategy: InsertionStrategySchema.optional()
})
export const InsertTextResultSchema = z.object({
  inserted: z.boolean(),
  strategyUsed: InsertionStrategySchema.nullable(),
  /** Populated when inserted=false (e.g. 'secure-input', 'no-focused-element'). */
  reason: z.string().nullable()
})

export const ReplaceSelectionParamsSchema = z.object({
  text: z.string(),
  strategy: InsertionStrategySchema.optional()
})
export const ReplaceSelectionResultSchema = z.object({
  replaced: z.boolean(),
  strategyUsed: InsertionStrategySchema.nullable(),
  reason: z.string().nullable()
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
  activated: z.boolean()
})

export const KeyChordParamsSchema = z.object({
  /** Key name, e.g. 'v', 'return', 'escape'. */
  key: z.string(),
  modifiers: z.array(z.enum(['cmd', 'shift', 'alt', 'ctrl', 'fn'])).default([])
})
export const KeyChordResultSchema = z.object({
  sent: z.boolean()
})

// ---------------------------------------------------------------------------
// The RPC map — one entry per method; both sides are generated/checked from it
// ---------------------------------------------------------------------------

export const SIDECAR_PROTOCOL_VERSION = 1

export const SidecarMethods = {
  init: { params: InitParamsSchema, result: InitResultSchema },
  checkPermissions: { params: CheckPermissionsParamsSchema, result: CheckPermissionsResultSchema },
  promptAccessibility: {
    params: PromptAccessibilityParamsSchema,
    result: PromptAccessibilityResultSchema
  },
  frontmostApp: { params: FrontmostAppParamsSchema, result: FrontmostAppResultSchema },
  focusedElement: { params: FocusedElementParamsSchema, result: FocusedElementResultSchema },
  insertText: { params: InsertTextParamsSchema, result: InsertTextResultSchema },
  replaceSelection: { params: ReplaceSelectionParamsSchema, result: ReplaceSelectionResultSchema },
  secureInputState: { params: SecureInputStateParamsSchema, result: SecureInputStateResultSchema },
  activateApp: { params: ActivateAppParamsSchema, result: ActivateAppResultSchema },
  keyChord: { params: KeyChordParamsSchema, result: KeyChordResultSchema }
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
