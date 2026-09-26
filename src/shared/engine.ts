/**
 * The engine, as the settings window sees it.
 *
 * Note what is *not* here: the secrets. `EngineCredentials` is main-process
 * only (src/main/store/credentials.ts); what crosses the preload bridge is
 * `EngineStatus`, which can tell you a token is saved and cannot tell you what
 * it is. A renderer that could read the token would be a renderer worth
 * attacking.
 */

/** Main-process only. Never send this over IPC. */
export interface EngineCredentials {
  /** From `claude setup-token`, or an inherited Claude Code login. */
  oauthToken: string | null
  apiKey: string | null
}

export type EngineKind = 'agent' | 'api-key' | 'codex' | 'signed-out' | 'fake'

export interface EngineStatus {
  /** Which implementation is serving edits right now. */
  kind: EngineKind
  /** 'ready' | 'local-only' | 'signed-out', mirroring EngineState. */
  state: 'ready' | 'local-only' | 'signed-out'
  /** Why it is degraded, when it is. One sentence, already user-facing. */
  reason: string | null
  model: string | null
  hasSubscription: boolean
  hasApiKey: boolean
  /**
   * True when a Claude Code login was found on this Mac, so the subscription
   * lane works with nothing pasted at all.
   */
  detectedLogin: boolean
  /** Whether a Codex CLI executable was found in a GUI-safe search path. */
  codexCliFound: boolean
  /** Whether that CLI exposes every flag Mull needs for an isolated run. */
  codexCliCompatible: boolean
  /** True only for ChatGPT subscription auth, never API-key auth. */
  codexLoggedIn: boolean
  /** Redacted CLI version string, useful when a required flag is missing. */
  codexVersion: string | null
}

/** What `engineTest` reports: proof the credential works, not that it saved. */
export interface EngineTestResult {
  ok: boolean
  message: string
  /** Round trip to the first streamed token, when there was one. */
  firstTokenMs: number | null
}

/**
 * The command that mints a subscription token, shown with a copy button.
 *
 * The fallback now rather than the path: Settings runs the same OAuth flow in
 * the browser (`src/main/engine/oauth.ts`) and ends up with the same token.
 * This stays for the Mac where the browser cannot redirect back.
 */
export const SETUP_TOKEN_COMMAND = 'claude setup-token'

/** Mull never handles the Codex token; the CLI owns this login end to end. */
export const CODEX_LOGIN_COMMAND = 'codex login'
