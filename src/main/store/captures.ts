import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CaptureRecord } from '@shared/types'
import type { ScreenContext } from '@shared/context'
import { renderContext } from '../engine/prompts'

/**
 * Keeping the evidence.
 *
 * "It says it can only see the sidebar" is not a claim anyone can settle from
 * the outside. Either the words were in front of the model or they were not,
 * and until this existed there was no way to find out which — the harvest
 * happened, went into a prompt, and was gone.
 *
 * So every context-carrying action keeps a receipt: the window transcript
 * **exactly as it was rendered into the prompt**, and the picture if there was
 * one. Not a fresh read and not a summary; re-reading the window later would
 * answer a different question, since by then the user has clicked something.
 *
 * The transcript goes in the journal row. The JPEG goes on disk, because a
 * couple of hundred kilobytes of base64 in a row is something every list query
 * would read to show a one-line summary.
 */

/**
 * How many pictures to keep.
 *
 * Small. This is a receipt you check after something looked wrong, not an
 * archive of everything you have ever looked at — and each one is a photograph
 * of the user's screen, so keeping fewer is the better default in both
 * directions.
 */
export const KEEP_CAPTURES = 25

export interface CaptureStoreOptions {
  dir: string
  keep?: number
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export class CaptureStore {
  private readonly keep: number

  constructor(private readonly options: CaptureStoreOptions) {
    this.keep = options.keep ?? KEEP_CAPTURES
  }

  /**
   * Write down what was seen, and return the row's share of it.
   *
   * Never throws: a receipt that fails to save must not take the action with
   * it. The worst case is a row that cannot explain itself, which is what every
   * row did before this.
   */
  save(entryId: string, context: ScreenContext | null | undefined): CaptureRecord | null {
    if (!context) return null

    const record: CaptureRecord = {
      // The rendered form, not the raw blocks — this has to be the same string
      // the model was given, or the receipt describes something that never
      // happened.
      text: renderContext(context),
      blocks: context.blocks.length,
      chars: context.chars,
      truncated: context.truncated,
      harvestMs: context.harvestMs,
      windowTitle: context.windowTitle,
      imageFile: null,
      // Carried through verbatim. "No screenshot was requested" and "screen
      // recording is not granted" look identical in a blank box and are not at
      // all the same thing — only one of them is the user's to fix.
      imageReason: context.imageReason,
      imageBytes: context.image?.bytes ?? null
    }

    if (context.image) {
      try {
        mkdirSync(this.options.dir, { recursive: true })
        const name = `${entryId}.jpg`
        writeFileSync(join(this.options.dir, name), Buffer.from(context.image.dataBase64, 'base64'))
        record.imageFile = name
        this.prune()
      } catch (err) {
        this.options.log?.('warn', 'captures: could not keep the picture', err)
        record.imageReason = 'could-not-save'
      }
    }

    return record
  }

  /** Absolute path of a kept picture, or null if it has been pruned away. */
  path(imageFile: string | null | undefined): string | null {
    if (!imageFile || imageFile.includes('/') || imageFile.includes('..')) return null
    const full = join(this.options.dir, imageFile)
    try {
      statSync(full)
      return full
    } catch {
      return null
    }
  }

  /** Oldest first out. A journal row whose picture is gone says so. */
  private prune(): void {
    try {
      const files = readdirSync(this.options.dir)
        .filter((name) => name.endsWith('.jpg'))
        .map((name) => ({ name, at: statSync(join(this.options.dir, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
      for (const stale of files.slice(this.keep)) {
        rmSync(join(this.options.dir, stale.name), { force: true })
      }
    } catch (err) {
      this.options.log?.('warn', 'captures: could not prune', err)
    }
  }
}
