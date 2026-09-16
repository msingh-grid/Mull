import type { InsertionStrategy, SidecarApi } from '@shared/sidecar-api'
import { DEFAULT_PROFILE, insertionProfile, type InsertionProfile } from './insertion-table'

/**
 * Getting text into the app in front of you.
 *
 * The service owns three decisions the pipeline shouldn't have to think about:
 *
 *  1. **Which strategy**, from the per-app table (`insertion-table.ts`).
 *  2. **When to stop trying.** Some failures mean "try the next strategy"
 *     (this app has no AX text); others mean "stop immediately" (secure input
 *     is on, Accessibility isn't granted). Walking the chain past a hard stop
 *     would be both futile and, in the secure-input case, dangerous.
 *  3. **What to believe afterwards.** A strategy that reports success but fails
 *     read-back is treated as a failure, so the chain continues. A strategy
 *     whose read-back is merely *unknown* is accepted — with `verified: null`
 *     carried all the way into the journal, so undo knows not to guess later.
 *
 * It also remembers. When an app proves a strategy structurally doesn't work,
 * that strategy is skipped for the rest of the session: the second utterance
 * into Slack doesn't pay for the same failed AX attempt as the first. The
 * memory is deliberately in-process — a fresh run re-tests its assumptions,
 * which is what makes docs/INSERTION-MATRIX.md re-runnable.
 */

export interface InsertionTarget {
  bundleId: string
  name: string
}

export interface InsertionAttempt {
  strategy: InsertionStrategy
  ok: boolean
  reason: string | null
  verified: boolean | null
  ms: number
}

export interface InsertionResult {
  inserted: boolean
  strategyUsed: InsertionStrategy | null
  /** True = read back, false = contradicted, null = target wouldn't say. */
  verified: boolean | null
  /** Caret offset after the write, when AX could report it. Undo needs this. */
  caret: number | null
  /** What `replaceSelection` overwrote. Null for plain insertion. */
  replacedText: string | null
  reason: string | null
  attempts: InsertionAttempt[]
}

/**
 * Failures that end the walk. Everything else is "this strategy doesn't work
 * here", which is exactly what the next strategy is for.
 */
const HARD_STOPS = new Set([
  'secure-input',
  'no-accessibility',
  'no-focused-element',
  'refused-credential-app'
])

/** Failures that say the app *structurally* lacks this strategy — worth remembering. */
const STRUCTURAL = new Set(['ax-unsupported', 'ax-verify-failed', 'ax-select-failed'])

export interface InsertionDeps {
  sidecar: SidecarApi
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  now?: () => number
  /** Test seam: skip the per-session demotion memory. */
  remember?: boolean
}

export class InsertionService {
  private readonly demoted = new Map<string, Set<InsertionStrategy>>()
  private readonly now: () => number
  private readonly log: NonNullable<InsertionDeps['log']>

  constructor(private readonly deps: InsertionDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? ((): void => {})
  }

  /** The chain this app would get right now, demotions included. */
  planFor(target: InsertionTarget | null): {
    profile: InsertionProfile
    chain: InsertionStrategy[]
  } {
    const profile = insertionProfile(target?.bundleId) ?? DEFAULT_PROFILE
    const skip = target ? this.demoted.get(target.bundleId) : undefined
    const chain = skip ? profile.chain.filter((s) => !skip.has(s)) : profile.chain
    return { profile, chain }
  }

  async insert(text: string, target: InsertionTarget | null): Promise<InsertionResult> {
    return this.write('insert', text, target)
  }

  /**
   * Replace what is selected.
   *
   * `onlyAx` narrows the chain to the one strategy that targets the element
   * holding the selection. Paste and type post keystrokes, which land wherever
   * the caret is — fine when the selection *is* the caret's element, and a way
   * to overwrite the wrong text when it is not (M4.2: a selection found
   * elsewhere in the app's accessibility tree).
   */
  async replaceSelection(
    text: string,
    target: InsertionTarget | null,
    options: { onlyAx?: boolean } = {}
  ): Promise<InsertionResult> {
    return this.write('replace', text, target, options)
  }

  private async write(
    mode: 'insert' | 'replace',
    text: string,
    target: InsertionTarget | null,
    options: { onlyAx?: boolean } = {}
  ): Promise<InsertionResult> {
    const planned = this.planFor(target)
    const profile = planned.profile
    const chain = options.onlyAx ? planned.chain.filter((s) => s === 'ax') : planned.chain
    const attempts: InsertionAttempt[] = []

    if (profile.refuse) {
      return {
        inserted: false,
        strategyUsed: null,
        verified: null,
        caret: null,
        replacedText: null,
        reason: `refused-${profile.refuse}`,
        attempts
      }
    }

    if (chain.length === 0) {
      return {
        inserted: false,
        strategyUsed: null,
        verified: null,
        caret: null,
        replacedText: null,
        reason: 'no-strategy-left',
        attempts
      }
    }

    let lastReason: string | null = 'no-strategy-left'

    for (const strategy of chain) {
      const startedAt = this.now()
      let inserted = false
      let reason: string | null = null
      let verified: boolean | null = null
      let caret: number | null = null
      let replacedText: string | null = null

      try {
        if (mode === 'replace') {
          const result = await this.deps.sidecar.replaceSelection({
            text,
            strategy,
            settleMs: profile.settleMs
          })
          inserted = result.replaced
          reason = result.reason
          verified = result.verified
          caret = result.caret
          replacedText = result.replacedText
        } else {
          const result = await this.deps.sidecar.insertText({
            text,
            strategy,
            settleMs: profile.settleMs
          })
          inserted = result.inserted
          reason = result.reason
          verified = result.verified
          caret = result.caret
        }
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err)
      }

      attempts.push({
        strategy,
        ok: inserted,
        reason,
        verified,
        ms: this.now() - startedAt
      })

      if (inserted) {
        return {
          inserted: true,
          strategyUsed: strategy,
          verified,
          caret,
          replacedText,
          reason: null,
          attempts
        }
      }

      lastReason = reason
      if (reason && STRUCTURAL.has(reason) && target && this.deps.remember !== false) {
        this.demote(target, strategy, reason)
      }
      if (reason && HARD_STOPS.has(reason)) break
    }

    return {
      inserted: false,
      strategyUsed: null,
      verified: null,
      caret: null,
      replacedText: null,
      reason: lastReason,
      attempts
    }
  }

  private demote(target: InsertionTarget, strategy: InsertionStrategy, reason: string): void {
    const set = this.demoted.get(target.bundleId) ?? new Set<InsertionStrategy>()
    if (set.has(strategy)) return
    set.add(strategy)
    this.demoted.set(target.bundleId, set)
    this.log('info', `insertion: ${target.name} does not support '${strategy}' (${reason})`, {
      bundleId: target.bundleId
    })
  }

  /** What the session has learned — logged at quit, useful for the matrix. */
  learned(): Array<{ bundleId: string; unsupported: InsertionStrategy[] }> {
    return [...this.demoted.entries()].map(([bundleId, set]) => ({
      bundleId,
      unsupported: [...set]
    }))
  }
}

/** Sidecar reason code -> something a person can act on. */
export function describeInsertionReason(reason: string | null): string {
  switch (reason) {
    case 'secure-input':
      return 'Secure input is on — Mull paused. Leave the password field and try again.'
    case 'no-accessibility':
      return 'Mull needs Accessibility access to place text. Grant it in System Settings → Privacy & Security → Accessibility, then restart Mull.'
    case 'no-focused-element':
      return 'No text field is focused — click where the text should go, then try again.'
    case 'refused-credential-app':
      return 'Mull doesn’t type into password managers.'
    case 'no-strategy-left':
      return 'Every way Mull knows to place text was refused by this app.'
    case 'ax-unsupported':
    case 'ax-verify-failed':
      return 'This app wouldn’t accept the text directly, and pasting didn’t work either.'
    case 'cgevent-post-failed':
      return 'macOS refused the keystroke. Check Accessibility permission, then try again.'
    default:
      return `Couldn’t insert the text${reason ? ` (${reason})` : ''}.`
  }
}
