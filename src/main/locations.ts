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

/**
 * The speech model, English-only, ~466 MB.
 *
 * Was `ggml-base.en.bin` (~148 MB) through M1-M5. Measured on an M4 Pro,
 * base.en decodes a short utterance in ~294 ms and small.en in ~674 ms, so the
 * swap costs roughly 380 ms of the dictation lane's ~700 ms budget and buys
 * robustness on real room audio, which is where mistranscriptions actually
 * happen. `settings.speechModel` is the way back down for a slower Mac.
 *
 * Worth knowing before touching this: on *clean* audio base.en is already
 * correct, and `--prompt` biasing (see `asr/whisper-cli.ts`) fixed a proper
 * noun that small.en got wrong without it. The model size is the smallest of
 * the levers here, not the largest.
 */
export const DEFAULT_MODEL_FILE = 'ggml-small.en.bin'

export function defaultModelPath(): string {
  return join(modelsDir(), DEFAULT_MODEL_FILE)
}

/**
 * Silero VAD, ~900 KB, used by `whisper-cli --vad` to trim the non-speech
 * either side of an utterance. Optional by construction: every caller checks
 * `existsSync` and simply omits the flag, because a missing 900 KB file must
 * never be the reason speech stops working.
 */
export const VAD_MODEL_FILE = 'ggml-silero-v5.1.2.bin'

export function vadModelPath(): string {
  return join(modelsDir(), VAD_MODEL_FILE)
}

export function benchPath(): string {
  return join(userDataDir(), 'bench.jsonl')
}

/** The journal database: every action Mull took, and whether it was undone. */
export function journalPath(): string {
  return join(userDataDir(), 'journal.db')
}

/**
 * Screenshots kept as evidence for journal rows.
 *
 * On disk rather than in the database on purpose: a JPEG is a couple of hundred
 * kilobytes, and every list query would read it. Pruned to the most recent few
 * — this is a receipt you check after the fact, not an archive.
 */
export function capturesDir(): string {
  return join(userDataDir(), 'captures')
}

/** User settings. Small, hand-editable, and never required to exist. */
export function settingsPath(): string {
  return join(userDataDir(), 'settings.json')
}

/**
 * Engine credentials, encrypted by `safeStorage` (src/main/store/credentials.ts).
 * Beside settings.json rather than inside it: one file is hand-editable and the
 * other must never be, and keeping them apart makes that obvious on disk.
 */
export function credentialsPath(): string {
  return join(userDataDir(), 'credentials.json')
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

/**
 * The `claude` CLI binary the Agent SDK spawns as a subprocess for every
 * lane. Left unset in dev: `@anthropic-ai/claude-agent-sdk` resolves its own
 * optional platform package (`@anthropic-ai/claude-agent-sdk-darwin-arm64`)
 * against `node_modules` correctly there.
 *
 * A packaged app cannot rely on that resolution, and the failure is silent
 * until an utterance is spoken: `files` in `electron-builder.yml` packs
 * `node_modules` into `app.asar`, so the 200 MB native binary the SDK finds
 * ends up addressed as `…/app.asar/node_modules/…/claude` — a real path
 * component *inside* a single-file archive. `fs.existsSync`, which the SDK's
 * resolution uses to confirm the binary is there, is patched by Electron to
 * see straight through that (it returns true), so the SDK is never told its
 * default failed. `child_process.spawn`, which fires next, is not patched:
 * it hands the string straight to the OS, `app.asar` is a file rather than a
 * directory on the real filesystem, and the spawn fails with `ENOTDIR` — a
 * generic-looking error that gives no hint the binary was ever found.
 *
 * `asarUnpack` in `electron-builder.yml` puts a real copy of the binary next
 * to the archive, at the mirrored path under `app.asar.unpacked`. This
 * function is what points the SDK there instead of at its own default, via
 * `pathToClaudeCodeExecutable` — the escape hatch the SDK documents for
 * exactly this "packaged, non-Node-resolvable" case.
 */
export function resolveClaudeCliPath(opts: { resourcesPath?: string; packaged?: boolean }): string | undefined {
  const fromEnv = process.env['MULL_CLAUDE_CLI_PATH']
  if (fromEnv) return fromEnv
  if (!opts.packaged || !opts.resourcesPath) return undefined
  return join(
    opts.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai/claude-agent-sdk-darwin-arm64',
    'claude'
  )
}
