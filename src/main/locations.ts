import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where Mull's on-disk things live.
 *
 * Deliberately free of `electron` imports so `scripts/` (plain node via tsx)
 * resolves the exact same paths the app does. Electron derives userData from
 * package.json `name`, so the literal below must stay in step with it.
 */

export const APP_DIR_NAME = 'mull'

/** Mirrors Electron's `app.getPath('userData')` on macOS. */
export function userDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', APP_DIR_NAME)
}

export function modelsDir(): string {
  return join(userDataDir(), 'models')
}

/** The model M1 targets: multilingual base, ~148 MB, good latency/accuracy trade. */
export const DEFAULT_MODEL_FILE = 'ggml-base.en.bin'

export function defaultModelPath(): string {
  return join(modelsDir(), DEFAULT_MODEL_FILE)
}

export function benchPath(): string {
  return join(userDataDir(), 'bench.jsonl')
}

/** Places whisper.cpp's CLI lands, in preference order. */
const WHISPER_CLI_CANDIDATES = [
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
  '/opt/homebrew/bin/whisper-cpp',
  '/usr/local/bin/whisper-cpp'
]

export function resolveWhisperCli(): string {
  const fromEnv = process.env['MULL_WHISPER_CLI']
  if (fromEnv) return fromEnv
  for (const candidate of WHISPER_CLI_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return WHISPER_CLI_CANDIDATES[0] as string
}

/**
 * The Swift sidecar binary. In dev it is whatever `npm run build:sidecar`
 * produced; in a packaged app it is copied next to the app resources.
 */
export function resolveSidecarPath(opts: { resourcesPath?: string; packaged?: boolean; repoRoot?: string }): string {
  const fromEnv = process.env['MULL_SIDECAR_PATH']
  if (fromEnv) return fromEnv
  if (opts.packaged && opts.resourcesPath) {
    return join(opts.resourcesPath, 'mull-mac')
  }
  const root = opts.repoRoot ?? process.cwd()
  // SwiftPM writes into an arch-specific directory and symlinks `.build/release`.
  return join(root, 'mull-mac', '.build', 'release', 'mull-mac')
}
