/**
 * Core domain types (M1 stubs — shapes per docs/PLAN.md "Key contracts").
 * These grow with the IntentRouter (M4), JournalStore (M2) and MemoryStore (M5);
 * keep changes additive where possible.
 */
import type { InsertionStrategy } from './sidecar-api'

// ---------------------------------------------------------------------------
// Intent — the router's output. Routing invariant: plain dictation NEVER
// waits on the engine; the fast path returns `{ kind: 'dictate' }` (or null →
// insert immediately) without an LLM round-trip.
// ---------------------------------------------------------------------------

/** Plain dictation: cleaned transcript text to insert at the caret. */
export interface DictateIntent {
  kind: 'dictate'
  /** Text after local rules cleanup (fillers, casing, dictionary subs). */
  text: string
}

/** An edit of existing text (selection or whole field), e.g. "make this shorter". */
export interface EditIntent {
  kind: 'edit'
  /** The user's instruction, e.g. "tighten this up". */
  instruction: string
  /**
   * What the edit applies to.
   *
   * `reference` is text Mull could read but not rewrite — a sent message, a web
   * page — so the result was inserted at the caret rather than replacing
   * anything. `draft` (M5a) replaced nothing at all: it is a reply written from
   * the conversation on screen, so the row has no `before` and undo removes the
   * insertion rather than restoring anything.
   */
  target: 'selection' | 'document' | 'reference' | 'draft'
  /** Raw transcript the instruction was parsed from (for the journal). */
  transcript: string
}

/** A whitelisted command, e.g. "open Slack" — never free-form computer use. */
export interface CommandIntent {
  kind: 'command'
  /** Whitelisted verb (validated against the M5 verb table with zod). */
  verb: string
  args: Record<string, unknown>
  transcript: string
}

export type Intent = DictateIntent | EditIntent | CommandIntent

// ---------------------------------------------------------------------------
// Journal — every action Mull takes is recorded and undoable (M2).
// ---------------------------------------------------------------------------

export type JournalStatus = 'applied' | 'cancelled' | 'failed' | 'undone'

export interface JournalEntry {
  id: string
  /** Epoch ms. */
  at: number
  intent: Intent
  /** App the action targeted. */
  app: { bundleId: string; name: string } | null
  /** Text state before/after, when the action changed text. */
  before: string | null
  after: string | null
  strategyUsed: InsertionStrategy | null
  status: JournalStatus
  /** One line for the journal row and the HUD's last-action ghost. */
  summary: string
  /**
   * Did the sidecar read back what it wrote? Undo requires `true`: removing
   * text we only *believe* we inserted is how you delete someone's paragraph.
   */
  verified: boolean | null
  /** Caret offset (UTF-16) immediately after the write, when AX reported it. */
  caret: number | null
  /** False once undone, or when the action left nothing to reverse. */
  undoable: boolean
  /** Epoch ms of the undo, if it happened. */
  undoneAt: number | null
}

/** What the store needs to create an entry; the rest it fills in. */
export type JournalDraft = Omit<JournalEntry, 'id' | 'at' | 'undoneAt'> & {
  id?: string
  at?: number
}

/**
 * An entry as the journal window receives it. `changes` is computed in main
 * from before/after so there is exactly one diff implementation in the app —
 * the row's count and the expanded row's marks can never disagree.
 */
export interface JournalEntryView extends JournalEntry {
  changes: number | null
}

// ---------------------------------------------------------------------------
// Memory v0 — FTS5-backed working memory items (M5).
// ---------------------------------------------------------------------------

export interface MemoryItem {
  id: string
  /** Epoch ms captured. */
  at: number
  /** Where the snippet came from. */
  source: { bundleId: string; name: string; windowTitle: string | null } | null
  /** Captured text (window/field snippet, vocabulary term, thread summary). */
  text: string
  kind: 'context' | 'vocabulary' | 'thread'
  /** Simhash for near-duplicate pruning. */
  simhash: string | null
}
