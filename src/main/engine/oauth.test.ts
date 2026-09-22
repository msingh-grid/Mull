import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  authorizeUrl,
  CLAUDE_OAUTH,
  exchangeBody,
  newState,
  pkcePair,
  readCallback,
  redirectUri,
  signInWithBrowser
} from './oauth'

describe('pkcePair', () => {
  it('derives the challenge as the S256 of the verifier', () => {
    const { verifier, challenge } = pkcePair()
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('is url-safe and different every time', () => {
    const first = pkcePair()
    const second = pkcePair()
    expect(first.verifier).not.toBe(second.verifier)
    expect(`${first.verifier}${first.challenge}${newState()}`).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

/**
 * The request `claude setup-token` actually sends, captured from the CLI with
 * its browser opener stubbed out. Mull's URL has to match this shape exactly —
 * the one field that did not (a 22-character `state`) was answered with
 * "Invalid request format" by the authorize page.
 */
const FROM_THE_CLI =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A50532%2Fcallback&scope=user%3Ainference' +
  '&code_challenge=USI5lQKPyTwaIrHovROxxZgQafos3Z983t86e9_XWHE&code_challenge_method=S256' +
  '&state=89aaBWIhF_TEdhe6zWBSYuHbCa0kB0gJbf705DPw5_Q'

describe('the request the CLI sends', () => {
  it('is the request Mull sends — same params, same order, same shapes', () => {
    const theirs = new URL(FROM_THE_CLI)
    const ours = new URL(
      authorizeUrl({ challenge: pkcePair().challenge, state: newState(), port: 50532 })
    )

    expect(`${ours.origin}${ours.pathname}`).toBe(`${theirs.origin}${theirs.pathname}`)
    expect([...ours.searchParams.keys()]).toEqual([...theirs.searchParams.keys()])

    for (const [key, value] of theirs.searchParams) {
      const mine = ours.searchParams.get(key) as string
      // The three that are random differ in value and must not differ in size.
      if (key === 'state' || key === 'code_challenge') expect(mine).toHaveLength(value.length)
      else expect(mine).toBe(value)
    }
  })
})

describe('authorizeUrl', () => {
  it('asks for an inference-only code, bound to the loopback port', () => {
    const url = new URL(authorizeUrl({ challenge: 'chal', state: 'st', port: 51234 }))

    expect(`${url.origin}${url.pathname}`).toBe(CLAUDE_OAUTH.authorizeUrl)
    expect(url.searchParams.get('client_id')).toBe(CLAUDE_OAUTH.clientId)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:51234/callback')
    expect(url.searchParams.get('scope')).toBe('user:inference')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st')
  })
})

describe('exchangeBody', () => {
  it('carries the verifier and asks for a long-lived token', () => {
    const body = exchangeBody({ code: 'c', state: 's', verifier: 'v', port: 7 })

    expect(body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'c',
      state: 's',
      code_verifier: 'v',
      client_id: CLAUDE_OAUTH.clientId,
      redirect_uri: redirectUri(7),
      expires_in: CLAUDE_OAUTH.expiresIn
    })
    // A year. Anything shorter would sign the user out while they slept.
    expect(CLAUDE_OAUTH.expiresIn).toBe(31_536_000)
  })
})

describe('readCallback', () => {
  it('takes a code whose state matches', () => {
    expect(readCallback('/callback?code=abc&state=xyz', 'xyz')).toEqual({ ok: true, code: 'abc' })
  })

  // The whole point of `state`: a code Mull did not ask for is not a code.
  it('refuses a code whose state does not match', () => {
    const result = readCallback('/callback?code=abc&state=someone-else', 'xyz')
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('reports the error the authorize page sent back', () => {
    const result = readCallback('/callback?error=access_denied&error_description=No', 'xyz')
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(result.ok === false && result.message).toContain('access_denied')
  })

  it('ignores anything that is not the callback path', () => {
    expect(readCallback('/favicon.ico', 'xyz')).toMatchObject({ ok: false, status: 404 })
  })

  it('refuses a callback with no code at all', () => {
    expect(readCallback('/callback?state=xyz', 'xyz')).toMatchObject({ ok: false, status: 400 })
  })
})

describe('signInWithBrowser', () => {
  /** Drive the real loopback server by fetching the URL the browser would. */
  function browser(respond: (url: URL) => Promise<unknown>) {
    return async (raw: string): Promise<void> => {
      const url = new URL(raw)
      await respond(url)
    }
  }

  it('opens the browser, takes the redirect, and returns the token', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ access_token: 'sk-ant-oat-test' }), { status: 200 })
    )

    const token = await signInWithBrowser({
      fetch: fetchImpl as unknown as typeof fetch,
      openUrl: browser(async (url) => {
        const redirect = new URL(url.searchParams.get('redirect_uri') as string)
        redirect.searchParams.set('code', 'the-code')
        redirect.searchParams.set('state', url.searchParams.get('state') as string)
        // `manual: 'never'` would follow the 302 out to the real success page.
        await fetch(redirect, { redirect: 'manual' })
      })
    })

    expect(token).toBe('sk-ant-oat-test')
    const init = fetchImpl.mock.calls[0]?.[1]
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>
    expect(sent['code']).toBe('the-code')
    expect(sent['grant_type']).toBe('authorization_code')
  })

  it('gives up when the browser never comes back', async () => {
    await expect(
      signInWithBrowser({ openUrl: () => undefined, timeoutMs: 20 })
    ).rejects.toThrow(/browser/i)
  })

  it('stops when the user cancels', async () => {
    const abort = new AbortController()
    const promise = signInWithBrowser({
      openUrl: () => abort.abort(),
      signal: abort.signal
    })
    await expect(promise).rejects.toThrow(/cancelled/i)
  })

  it('says so when the exchange is refused', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('nope', { status: 401 }))

    await expect(
      signInWithBrowser({
        fetch: fetchImpl as unknown as typeof fetch,
        openUrl: browser(async (url) => {
          const redirect = new URL(url.searchParams.get('redirect_uri') as string)
          redirect.searchParams.set('code', 'stale')
          redirect.searchParams.set('state', url.searchParams.get('state') as string)
          await fetch(redirect, { redirect: 'manual' })
        })
      })
    ).rejects.toThrow(/refused/i)
  })
})
