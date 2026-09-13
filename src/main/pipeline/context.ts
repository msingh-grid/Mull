import { readFile, unlink } from 'node:fs/promises'
import type { ContextMode, ScreenContext } from '@shared/context'
import type { SidecarApi } from '@shared/sidecar-api'
import { insertionProfile } from '../services/insertion-table'

/**
 * Reading the window the user is looking at.
 *
 * This is the capability M5a exists for. Until now the engine saw an
 * instruction, a passage and an app name — which is why "reply to this" had no
 * *this*. The conversation above the composer, the thread, the window title:
 * none of it reached the model.
 *
 * Two halves, both taken, because they are good at different things. The
 * Accessibility harvest knows how a name is spelled and what order the messages
 * came in; the picture sees charts, canvases, PDFs and layout that have no
 * accessibility representation at all. Neither is a fallback for the other.
 *
 * **Three refusals, and they are the whole privacy story.** Off by setting;
 * never a credential app; never while secure input is on. Each returns null
 * rather than a partial read, because "Mull looked at your password manager but
 * only a bit" is not a thing anyone wants to hear.
 */

/**
 * Characters of window text kept for a prompt.
 *
 * Generous compared to the classifier's budget below, because the edit and
 * compose turns are the ones that need the conversation. Still finite: a long
 * Slack channel is unbounded and the model does not read better for being
 * handed all of it.
 */
export const CONTEXT_CHARS = 6_000

/**
 * Where the picture is taken and where it is not.
 *
 * Capturing is local and costs a few tens of milliseconds; *sending* costs
 * latency and tokens on a call the user is waiting through. So the picture is
 * taken speculatively during the hold and attached only to the turn that can
 * use it — never to the classifier, which is already p50 4.2 s on the
 * subscription lane and is the one call with nothing on screen to look at.
 */
export interface CaptureContextOptions {
  sidecar: SidecarApi
  mode: ContextMode
  /** Bundle ids the user has excluded in Settings. */
  excluded?: readonly string[]
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

/**
 * Read the frontmost window, or return null and say nothing was read.
 *
 * Called during the hold, off the critical path, so every failure here is
 * simply "there is no context" — an app that cannot be read is not an error,
 * it is a quieter Mull.
 */
export async function captureContext(
  options: CaptureContextOptions
): Promise<ScreenContext | null> {
  const { sidecar, mode, log } = options
  if (mode === 'off') return null

  // Which app, before reading a single thing from it. Two round trips instead
  // of one, and the first is ~2ms — cheap enough to be the price of never
  // harvesting a password manager by accident.
  const front = await sidecar.frontmostApp({}).catch((err: unknown) => {
    log?.('warn', 'context: frontmostApp failed', err)
    return null
  })
  const app = front?.app ? { bundleId: front.app.bundleId, name: front.app.name } : null
  if (!app) return null
  if (isExcluded(app.bundleId, options.excluded)) {
    log?.('info', 'context: refused', { app: app.bundleId })
    return null
  }

  const wantsImage = mode === 'text+screen'
  const read = await sidecar
    .windowContext({ maxChars: CONTEXT_CHARS, screenshot: wantsImage })
    .catch((err: unknown) => {
      log?.('warn', 'context: windowContext failed', err)
      return null
    })
  if (!read) return null

  // The sidecar refuses on its own grounds too, and says which. Secure input is
  // the one that matters: reading a password field is its own harm, quite apart
  // from typing into one.
  if (read.stoppedBy === 'secure-input' || read.stoppedBy === 'no-accessibility') {
    return null
  }

  const image = read.screenshot
    ? await loadImage(read.screenshot, log)
    : null

  const blocks = clampBlocks(read.blocks)
  return {
    app,
    windowTitle: read.windowTitle,
    blocks,
    truncated: read.truncated || blocks.length < read.blocks.length,
    image,
    imageReason: image ? null : (read.screenshotReason ?? 'not-requested'),
    chars: blocks.reduce((total, block) => total + block.text.length, 0),
    harvestMs: read.harvestMs
  }
}

/**
 * A password manager is never read, whatever the user's setting says.
 *
 * Reuses the same judgement `InsertionService` already makes about where Mull
 * will not write (`insertion-table.ts`). One list, one decision: an app Mull
 * refuses to type into is an app it has no business reading either.
 */
export function isExcluded(bundleId: string, excluded?: readonly string[]): boolean {
  if (insertionProfile(bundleId).refuse === 'credential-app') return true
  return (excluded ?? []).includes(bundleId)
}

/**
 * Read the JPEG in, then delete it.
 *
 * Always delete — including when the read failed. The sidecar wrote it into the
 * temp directory and nothing else is going to come back for it, and a folder
 * slowly filling with photographs of someone's screen is precisely the kind of
 * thing this app must not leave behind.
 */
async function loadImage(
  shot: { path: string; width: number; height: number; bytes: number },
  log?: CaptureContextOptions['log']
): Promise<ScreenContext['image']> {
  try {
    const data = await readFile(shot.path)
    return {
      mediaType: 'image/jpeg',
      dataBase64: data.toString('base64'),
      width: shot.width,
      height: shot.height,
      bytes: data.byteLength
    }
  } catch (err) {
    log?.('warn', 'context: could not read the capture', err)
    return null
  } finally {
    void unlink(shot.path).catch(() => {})
  }
}

/** Keep the end of the window: the newest messages, and the caret. */
function clampBlocks(blocks: ScreenContext['blocks']): ScreenContext['blocks'] {
  let total = 0
  const kept: ScreenContext['blocks'] = []
  // Backwards, because a conversation's last screenful is the part an
  // instruction is almost always about. The oldest lines are the ones to lose.
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]
    if (!block) continue
    if (total + block.text.length > CONTEXT_CHARS && kept.length > 0) break
    total += block.text.length
    kept.push(block)
  }
  return kept.reverse()
}
