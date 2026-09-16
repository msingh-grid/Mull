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

/**
 * A question about what was on screen, answered and shown — never written.
 *
 * Its own kind rather than an `EditIntent` target, because every target there
 * names somewhere text ended up. This one has no such place: the row exists to
 * record that Mull read a window (and photographed it) and what it said back,
 * and `undoable` is false for the simplest possible reason.
 */
export interface AskIntent {
  kind: 'ask'
  /** What the user wanted to know, in their own words. */
  question: string
  transcript: string
}

export type Intent = DictateIntent | EditIntent | CommandIntent | AskIntent

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
  /**
   * What Mull could see when it acted. Absent on rows that read nothing.
   *
   * This is a receipt, not a feature. "It says it can only see the sidebar"
   * cannot be argued about from the outside — either the words were in front of
   * the model or they were not — and until this existed there was no way to
   * find out which. Everything here is exactly what was sent, with no
   * re-rendering: if the row shows a wall of sidebar names and three messages,
   * that is what the model read.
   */
  capture?: CaptureRecord | null
  /**
   * The plan this row belongs to — the `nav.plan` row's own id.
   *
   * Null on everything that stands alone, which is most rows. It exists because
   * an expedition writes one row per press plus one for itself, and without a
   * thread between them the journal showed five unrelated `COMMAND` lines that
   * happened to land in the same minute. Knowing that four presses *were* one
   * request is most of what makes the record readable afterwards.
   */
  groupId?: string | null
  /** How long this entry took, in ms. Null where nothing measured it. */
  ms?: number | null
  /** Everything worth keeping whose shape depends on which lane wrote it. */
  detail?: EntryDetail | null
}

/**
 * The parts of a row that vary by lane.
 *
 * One loose object rather than columns, because the renderer prints it rather
 * than querying it, and because a lane that learns to record something new
 * should not need a migration to do it.
 *
 * Every string here can be model-authored, so every string here is clamped
 * before it is written — see `clampDetail` in `store/journal.ts`.
 */
export interface EntryDetail {
  /** Position within its plan, 1-based. */
  step?: number
  /** The model's own words for why it did this. */
  because?: string
  /**
   * What the step turned out to have done, learned one turn later.
   *
   * Written by `amend`, not by the row's author: whether a press moved anything
   * is only knowable from the *next* look at the window, which happens after
   * the row already exists.
   */
  evidence?: string
  /** The list the model was choosing from at the moment it chose. */
  scan?: { targets: number; press: number; type: number; stoppedBy: string }
  /** How long the model took to answer. */
  askMs?: number
}

/** The evidence behind one entry: what was read, and what was seen. */
export interface CaptureRecord {
  /** The window transcript as the model received it, verbatim. */
  text: string | null
  /** Blocks harvested, before any budget trimmed them. */
  blocks: number
  /** Characters of window text sent. */
  chars: number
  /** A budget stopped the walk before the window ran out. */
  truncated: boolean
  harvestMs: number
  windowTitle: string | null
  /**
   * Where the JPEG was kept, relative to the captures directory. Null when
   * there was no picture — and then `imageReason` says why, because "Mull took
   * no screenshot" and "Mull is not allowed to take screenshots" are different
   * facts and only one of them is the user's to fix.
   */
  imageFile: string | null
  imageReason: string | null
  imageBytes: number | null
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
