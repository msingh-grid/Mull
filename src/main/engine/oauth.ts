import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Signing in with the Claude subscription, through the browser.
 *
 * This is the flow `claude setup-token` runs, performed by Mull instead of by
 * a terminal: open the system browser at Claude's authorize page, listen on a
 * loopback port for the redirect, trade the code for a token. What comes back
 * is the same long-lived, inference-only token the command prints — the one
 * `CLAUDE_CODE_OAUTH_TOKEN` names and `AgentEngine` already knows how to use —
 * so nothing downstream of `CredentialsStore` learns that a second way of
 * getting one exists.
 *
 * **Why it is worth doing rather than telling people to run a command.** The
 * paste path asks someone to open a terminal, run a command they have not seen
 * before, and carry a secret back by clipboard. Every one of those steps is a
 * place to give up, and the last one is the only time Mull ever asks a person
 * to handle a credential by hand. A button that opens a browser is what signing
 * in looks like everywhere else.
 *
 * **What this depends on, stated plainly.** The client id, endpoints and scope
 * below are Claude Code's own, and the token is spent driving the Claude Agent
 * SDK — which is Claude Code. That is the same bargain the paste path already
 * makes; it is not a new grant of anything. But these values live in someone
 * else's product and can change without notice, so:
 *
 *   - nothing here is load-bearing for dictation, which never needs an engine;
 *   - every failure is reported as a sentence, never as a stack trace; and
 *   - the paste field stays in Settings as the fallback, because a flow that
 *     breaks with no way around it is worse than one extra field.
 *
 * The verifier never leaves this process, the redirect is `127.0.0.1` on an
 * ephemeral port, and `state` is checked before a code is accepted — a page in
 * another tab cannot hand Mull a code it did not ask for.
 */

export const CLAUDE_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  /** The claude.ai side, which is where a subscription signs in. */
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  /**
   * Inference and nothing else. Mull asks a model for sentences; it has no
   * business reading a profile, listing sessions, or minting API keys, and a
   * token that cannot do those things cannot be made to.
   */
  scope: 'user:inference',
  /** A year, in seconds — what makes this a token rather than a session. */
  expiresIn: 31_536_000,
  /** Where the browser lands once the code is in hand. */
  successUrl: 'https://platform.claude.com/oauth/code/success?app=claude-code'
} as const

/** Five minutes: long enough to find a password, short enough to give up on. */
const DEFAULT_TIMEOUT_MS = 300_000

export interface PkcePair {
  verifier: string
  challenge: string
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

export function pkcePair(random: (size: number) => Buffer = randomBytes): PkcePair {
  const verifier = base64url(random(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/**
 * 32 bytes, because that is what the CLI sends.
 *
 * It was 16 — plenty of entropy for a nonce, and the only thing in Mull's
 * authorize URL that did not match `claude setup-token` byte for byte. The
 * authorize page answered "Invalid request format", which is what a server
 * validating the shape of a parameter says about a parameter of the wrong
 * shape. Guessing which fields are checked is a poor use of anyone's evening:
 * the request is now identical to the one that is known to work.
 */
export function newState(random: (size: number) => Buffer = randomBytes): string {
  return base64url(random(32))
}

export function redirectUri(port: number): string {
  return `http://localhost:${port}/callback`
}

export function authorizeUrl(options: {
  challenge: string
  state: string
  port: number
}): string {
  const url = new URL(CLAUDE_OAUTH.authorizeUrl)
  url.searchParams.append('code', 'true')
  url.searchParams.append('client_id', CLAUDE_OAUTH.clientId)
  url.searchParams.append('response_type', 'code')
  url.searchParams.append('redirect_uri', redirectUri(options.port))
  url.searchParams.append('scope', CLAUDE_OAUTH.scope)
  url.searchParams.append('code_challenge', options.challenge)
  url.searchParams.append('code_challenge_method', 'S256')
  url.searchParams.append('state', options.state)
  return url.toString()
}

export function exchangeBody(options: {
  code: string
  state: string
  verifier: string
  port: number
}): Record<string, string | number> {
  return {
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: redirectUri(options.port),
    client_id: CLAUDE_OAUTH.clientId,
    code_verifier: options.verifier,
    state: options.state,
    expires_in: CLAUDE_OAUTH.expiresIn
  }
}

/**
 * The code the browser hands back, or the reason it did not.
 *
 * A mismatched `state` is refused rather than reported: the request did not
 * come from the browser Mull opened, and the only safe thing to do with it is
 * nothing.
 */
export function readCallback(
  rawUrl: string,
  expectedState: string
): { ok: true; code: string } | { ok: false; status: number; message: string } {
  const url = new URL(rawUrl, 'http://localhost')
  if (url.pathname !== '/callback') return { ok: false, status: 404, message: 'Not found' }

  const error = url.searchParams.get('error')
  if (error) {
    const detail = url.searchParams.get('error_description')
    return { ok: false, status: 400, message: detail ? `${error}: ${detail}` : error }
  }

  const code = url.searchParams.get('code')
  if (!code) return { ok: false, status: 400, message: 'No authorization code came back.' }
  if (url.searchParams.get('state') !== expectedState) {
    return { ok: false, status: 400, message: 'That sign-in did not start here.' }
  }
  return { ok: true, code }
}

export interface TokenResponse {
  access_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

export interface BrowserSignInDeps {
  /** Hand the URL to the system browser. */
  openUrl: (url: string) => Promise<void> | void
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  signal?: AbortSignal
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

/**
 * Run the whole thing. Resolves to the token; throws with a sentence.
 *
 * The loopback server exists only for the seconds between opening the browser
 * and the redirect arriving, and is closed in a `finally` — including when the
 * user closes the tab and the wait times out.
 */
export async function signInWithBrowser(deps: BrowserSignInDeps): Promise<string> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const log = deps.log ?? ((): void => {})
  const { verifier, challenge } = pkcePair()
  const state = newState()

  const server = createServer()
  const port = await listen(server)

  try {
    const waiting = waitForCode(server, state, {
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: deps.signal
    })
    const url = authorizeUrl({ challenge, state, port })
    // The URL itself, because the only way to diagnose a refusal from the
    // authorize page is to compare the request with one that works. It carries
    // no secret: the verifier stays in this process and the challenge is a
    // hash the whole point of which is being public.
    log('info', 'oauth: opening the browser', { port, url })
    await deps.openUrl(url)

    const code = await waiting

    const response = await fetchImpl(CLAUDE_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exchangeBody({ code, state, verifier, port }))
    })
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? 'Claude refused that sign-in. Try again.'
          : `Claude answered ${response.status} when exchanging the code.`
      )
    }

    const token = ((await response.json()) as TokenResponse).access_token
    if (!token) throw new Error('Claude returned no token.')
    return token
  } finally {
    server.close()
    server.closeAllConnections?.()
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(err))
    // Port 0: the OS picks a free one, so two Macs — or two Mulls — never
    // argue over a hardcoded number.
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

function waitForCode(
  server: Server,
  expectedState: string,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Nothing came back from the browser. Try again.'))
    }, options.timeoutMs)

    const settle = (fn: () => void): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    function onAbort(): void {
      settle(() => reject(new Error('Sign-in cancelled.')))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    server.on('request', (request: IncomingMessage, response: ServerResponse) => {
      const result = readCallback(request.url ?? '', expectedState)
      if (!result.ok) {
        response.writeHead(result.status)
        response.end(result.message)
        // A 404 is a stray request — a favicon, a probe — and is not the
        // answer to anything. Only a bad /callback ends the wait.
        if (result.status !== 404) settle(() => reject(new Error(result.message)))
        return
      }
      // The browser is sent somewhere that says it worked, rather than left
      // on a blank page served by a port that is about to close.
      response.writeHead(302, { Location: CLAUDE_OAUTH.successUrl })
      response.end()
      settle(() => resolve(result.code))
    })
  })
}
