import type { SidecarApi } from '@shared/sidecar-api'
import type { JournalDraft, JournalEntry } from '@shared/types'
import type { SendChord } from './send-table'

/**
 * Pressing send in someone else's window, and then going to look.
 *
 * The first thing Mull does that ⌥Z cannot take back, so it lives on its own
 * rather than inside whichever lane happens to want it. Two lanes do:
 * `SculptLane` after an Apply & send, and the bare-send card for "send the
 * message". One implementation, because the read-back discipline is the part
 * that must not vary between them.
 *
 * What it does, in order, and each step is a refusal waiting to happen:
 *
 *  1. **Is this still the app we were told about?** Between the card opening
 *     and the keystroke the user can switch windows, and a Return pressed into
 *     the wrong app is precisely the harm.
 *  2. **Post the chord.** From `send-table.ts`, which has no default: an app
 *     Mull has not been told about never gets here at all.
 *  3. **Wait, then read the composer back.** `keyChord` returns the moment the
 *     window server accepts the event, which says nothing whatsoever about
 *     whether the app did anything with it. Nothing in macOS will tell us. So
 *     Mull looks.
 *
 * And it answers in three states rather than two, which is the part worth
 * defending: `unknown` is a real outcome. Mail's ⌘⇧D closes the compose window,
 * so there is frequently nothing left to read. Claiming success there would be
 * a guess; claiming failure would send someone back to press Return on a
 * message that had already gone. Both mistakes cost a duplicate message or a
 * missing one, and neither is recoverable from inside this app.
 */

/** How long to let the app act on the chord before reading the box back. */
export const SEND_SETTLE_MS = 320

export type SendOutcome =
  | { sent: true }
  | { sent: false; reason: 'different-app' | 'chord-refused'; detail: string | null }
  /** The chord went in and the composer did not empty. Probably nothing happened. */
  | { sent: false; reason: 'unchanged'; detail: null }
  /** Mull could not read the box afterwards, so it will not claim either way. */
  | { sent: 'unknown' }

export interface SendRequest {
  app: { bundleId: string; name: string } | null
  chord: SendChord
  /** What is expected to leave, so the read-back can tell if it is still there. */
  text: string
  /** The user's words, for the journal row. */
  transcript: string
}

export interface SenderDeps {
  sidecar: SidecarApi
  /** Journalling must never be why a send fails; the keystroke already went. */
  journal?: { append(draft: JournalDraft): JournalEntry }
  onJournalChanged?: () => void
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  sleep?: (ms: number) => Promise<void>
}

export class Sender {
  private readonly log: NonNullable<SenderDeps['log']>
  private readonly sleep: NonNullable<SenderDeps['sleep']>

  constructor(private readonly deps: SenderDeps) {
    this.log = deps.log ?? ((): void => {})
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /** Press it, look, and write down what happened either way. */
  async send(request: SendRequest): Promise<SendOutcome> {
    const outcome = await this.press(request)
    const ok = outcome.sent === true
    const name = request.app?.name ?? 'this app'

    this.journal({
      // A whitelisted verb with a fixed argument list — the same shape M5's
      // command table will use, and deliberately not an `edit`. Someone
      // scanning the journal for "what did Mull actually do out there" should
      // find this as its own event, not as an adjective on the row above it.
      intent: {
        kind: 'command',
        verb: 'send',
        args: { app: request.app?.bundleId ?? null, chord: request.chord.hint },
        transcript: request.transcript
      },
      app: request.app,
      before: null,
      after: null,
      strategyUsed: null,
      status: ok ? 'applied' : outcome.sent === 'unknown' ? 'applied' : 'failed',
      summary: ok
        ? `Sent · ${name}`
        : outcome.sent === 'unknown'
          ? `Sent · ${name} — unconfirmed`
          : `Send failed · ${name} · ${outcome.reason}`,
      verified: outcome.sent === 'unknown' ? null : ok,
      caret: null,
      // Not a claim about how well it went. There is no keystroke that unsends
      // a message, so there is nothing for ⌥Z to offer and it must not pretend
      // otherwise — `UndoService` refuses this row by name.
      undoable: false
    })

    this.log(ok ? 'info' : 'warn', 'send', {
      app: request.app?.bundleId ?? null,
      chord: request.chord.hint,
      sent: outcome.sent,
      reason: outcome.sent === true || outcome.sent === 'unknown' ? null : outcome.reason
    })
    return outcome
  }

  /** The mechanics, so `send` can be about the record and this about the keys. */
  private async press(request: SendRequest): Promise<SendOutcome> {
    if (request.app) {
      const front = await this.deps.sidecar.frontmostApp({}).catch(() => null)
      if (front?.app && front.app.bundleId !== request.app.bundleId) {
        return { sent: false, reason: 'different-app', detail: front.app.name }
      }
    }

    const pressed = await this.deps.sidecar
      .keyChord({ key: request.chord.key, modifiers: request.chord.modifiers })
      .catch((err: unknown) => {
        this.log('error', 'send: keyChord threw', err)
        return { sent: false, reason: 'failed' as string | null }
      })
    if (!pressed.sent) return { sent: false, reason: 'chord-refused', detail: pressed.reason }

    await this.sleep(SEND_SETTLE_MS)

    const composer = await this.deps.sidecar
      .focusedElement({ contextBytes: 4_096 })
      .catch(() => null)
    if (!composer?.element) return { sent: 'unknown' }

    const remaining = composer.element.text
    if (!remaining.trim()) return { sent: true }
    const expected = request.text.trim()
    // A composer that still holds the message is a composer that did not send
    // it. Containment rather than equality, because some apps keep a trailing
    // newline or a quoted header around whatever was typed.
    if (expected && remaining.includes(expected)) {
      return { sent: false, reason: 'unchanged', detail: null }
    }
    return { sent: true }
  }

  private journal(draft: JournalDraft): void {
    if (!this.deps.journal) return
    try {
      this.deps.journal.append(draft)
      this.deps.onJournalChanged?.()
    } catch (err) {
      this.log('error', 'send: journal write failed', err)
    }
  }
}

/**
 * What to tell the user, in one sentence.
 *
 * Three outcomes, three sentences, and the middle one is why this exists: Mull
 * must never say "sent" about something it did not watch leave, and must never
 * say "failed" about something that may well have gone.
 */
export function describeSend(outcome: SendOutcome, appName: string | null): string {
  const where = appName ? ` in ${appName}` : ''
  if (outcome.sent === true) return `Sent${where}.`
  if (outcome.sent === 'unknown') {
    return `Mull couldn’t confirm the send${where}. Check the window.`
  }
  switch (outcome.reason) {
    case 'different-app':
      return 'You’ve switched apps since Mull read that — nothing was sent.'
    case 'chord-refused':
      return `Mull couldn’t press send${outcome.detail ? ` (${outcome.detail})` : ''}.`
    case 'unchanged':
      return `It didn’t send${where} — press send yourself.`
    default:
      return 'Nothing was sent.'
  }
}
