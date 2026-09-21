import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { DEFAULT_MODEL_FILE, VAD_MODEL_FILE, modelsDir, resolveWhisperCli } from '../locations'
import { existsSync } from 'node:fs'
import type { DownloadProgress, ModelStatus } from '@shared/model'

/**
 * The local speech model: where it is, whether it is here, and fetching it.
 *
 * Shared by `scripts/fetch-model.ts` and onboarding page 4 so there is one
 * implementation of "download the model" rather than two that drift. The two
 * properties that matter for both:
 *
 *  - **Nothing downloads silently.** Every path through this file is started
 *    by an explicit user action; there is no background fetch.
 *  - **A partial download is never mistaken for a model.** Bytes land in a
 *    `.part` file and are renamed into place only after the stream completes,
 *    so an interrupted download leaves whisper with nothing rather than
 *    something truncated.
 */

const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

/** Silero ships from a different repo than the whisper weights. */
const VAD_BASE_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main'

export const KNOWN_MODELS: Record<string, string> = {
  'tiny.en': 'ggml-tiny.en.bin',
  'base.en': 'ggml-base.en.bin',
  'small.en': 'ggml-small.en.bin',
  base: 'ggml-base.bin',
  small: 'ggml-small.bin',
  vad: VAD_MODEL_FILE
}

/**
 * Fallback order when the preferred model is not on disk.
 *
 * Exists because the default moved from base.en to small.en after M5: an
 * install that predates the change has only `ggml-base.en.bin`, and reporting
 * "not installed" would drop that user onto `FakeAsrProvider` — speech
 * silently replaced by a canned sentence — over an upgrade they never asked
 * for. Best first, so a fresh install that has both still gets small.en.
 */
const FALLBACK_ORDER = ['small.en', 'base.en', 'tiny.en', 'small', 'base'] as const

function isUsable(file: string): boolean {
  const path = join(modelsDir(), file)
  if (!existsSync(path)) return false
  try {
    return statSync(path).size > MIN_MODEL_BYTES
  } catch {
    return false
  }
}

/**
 * The model that will actually be loaded: the requested one when it is on
 * disk, otherwise the best installed alternative, otherwise the requested one
 * so the caller reports it as the thing to download.
 */
export function resolveInstalledModelFile(preferred = 'small.en'): string {
  const wanted = modelFileFor(preferred)
  if (isUsable(wanted)) return wanted
  for (const name of FALLBACK_ORDER) {
    const file = modelFileFor(name)
    if (isUsable(file)) return file
  }
  return wanted
}

/** Absolute path to whichever model `resolveInstalledModelFile` picked. */
export function resolveModelPath(preferred = 'small.en'): string {
  return join(modelsDir(), resolveInstalledModelFile(preferred))
}

/** Below this a file is a stub or a failed download, not a model. */
const MIN_MODEL_BYTES = 1_000_000

export function modelFileFor(name: string): string {
  return KNOWN_MODELS[name] ?? (name.endsWith('.bin') ? name : DEFAULT_MODEL_FILE)
}

export async function modelStatus(name = 'small.en'): Promise<ModelStatus> {
  const file = modelFileFor(name)
  const path = join(modelsDir(), file)
  const info = await stat(path).catch(() => null)
  const cli = resolveWhisperCli()
  return {
    file,
    path,
    installed: info !== null && info.size > MIN_MODEL_BYTES,
    bytes: info?.size ?? 0,
    whisperCli: cli,
    whisperInstalled: existsSync(cli)
  }
}

/**
 * Fetch a model. Resolves to the final path.
 *
 * `onProgress` is called at most every ~200ms — a progress bar updated per
 * chunk spends more time rendering than downloading.
 */
export async function downloadModel(
  name = 'small.en',
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  const file = modelFileFor(name)
  const dir = modelsDir()
  const target = join(dir, file)
  const partial = `${target}.part`

  const existing = await stat(target).catch(() => null)
  if (existing && existing.size > MIN_MODEL_BYTES) return target

  await mkdir(dir, { recursive: true })

  const base = file === VAD_MODEL_FILE ? VAD_BASE_URL : BASE_URL
  const response = await fetch(`${base}/${file}`, { signal })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`)
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  let lastReport = 0

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    const now = Date.now()
    if (onProgress && (now - lastReport > 200 || received === total)) {
      lastReport = now
      onProgress({ received, total })
    }
  })

  try {
    await pipeline(source, createWriteStream(partial))
  } catch (err) {
    await unlink(partial).catch(() => undefined)
    throw err
  }

  await rename(partial, target)
  onProgress?.({ received, total: total || received })
  return target
}

export function humanBytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}
