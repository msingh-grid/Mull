import React, { useCallback, useEffect, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { AboutInfo } from '@shared/about'
import type { ModelStatus } from '@shared/model'
import type { PermissionsSnapshot } from '@shared/permissions'
import type { Settings } from '@shared/settings'
import { SETUP_TOKEN_COMMAND, type EngineStatus } from '@shared/engine'
import { PermissionRows } from './components/PermissionRows'
import { applyTheme } from './theme'
import './tokens.css'
import './hud.css'
import './windows.css'

/**
 * Settings (docs/DESIGN.md §6.8).
 *
 * Panes in the order someone actually needs them: the one that unsticks a
 * broken install first, the cosmetic one in the middle, the reference one
 * last. Permissions poll while this window is open — granting happens in
 * System Settings, out of our reach, and the only honest way to know it landed
 * is to keep asking. The engine pane follows the same rule with its Test
 * button, for the same reason.
 */

const POLL_MS = 1500

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="set-row">
      <div className="set-label">
        <span>{label}</span>
        {hint ? <span className="set-hint">{hint}</span> : null}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function humanBytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

/**
 * The engine pane.
 *
 * Leads with the subscription because that is the path that asks for nothing:
 * on a Mac already signed in to Claude Code there is no field to fill at all,
 * and saying so is the most useful sentence this window contains. The API key
 * sits underneath as the escape hatch.
 *
 * Nothing here can read a secret back. The fields write; the status line
 * reports "saved" and the model in use, and that is the whole of what a
 * renderer is told. Test is the only honest ✓ — the same rule the permission
 * rows follow, for the same reason: a credential that saved is not a
 * credential that works.
 */
function EnginePane({
  settings,
  update
}: {
  settings: Settings
  update: (patch: Partial<Settings>) => Promise<void>
}): JSX.Element {
  const bridge = window.mull
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [token, setToken] = useState('')
  const [key, setKey] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(() => {
    void bridge?.engine.status().then(setStatus)
  }, [bridge])

  useEffect(refresh, [refresh])

  const save = async (kind: 'subscription' | 'api-key', secret: string): Promise<void> => {
    if (!secret.trim()) return
    const result = await bridge?.engine.signIn(kind, secret)
    setMessage(result?.message ?? null)
    // The field is cleared whether or not it worked: there is no reason for a
    // secret to sit in a text input after it has been handed over.
    if (kind === 'subscription') setToken('')
    else setKey('')
    refresh()
  }

  const signOut = async (kind: 'subscription' | 'api-key'): Promise<void> => {
    await bridge?.engine.signOut(kind)
    setMessage(kind === 'api-key' ? 'API key removed.' : 'Token removed.')
    refresh()
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setMessage(null)
    const result = await bridge?.engine.test()
    setTesting(false)
    setMessage(result?.message ?? null)
    refresh()
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(SETUP_TOKEN_COMMAND)
      setCopied(true)
      setTimeout(() => setCopied(false), 1_600)
    } catch {
      // Clipboard denied: the command is on screen and selectable anyway.
      setMessage(`Copy this and run it in a terminal: ${SETUP_TOKEN_COMMAND}`)
    }
  }

  const live =
    status === null
      ? 'checking…'
      : status.state === 'ready'
        ? `${status.kind === 'agent' ? 'Claude subscription' : 'API key'} · ${status.model ?? '—'}`
        : status.state === 'signed-out'
          ? 'not connected'
          : `paused — ${status.reason ?? 'unavailable'}`

  return (
    <section className="section">
      <h2>Engine</h2>
      <p>
        Edits — “make this crisp”, “fix the grammar” — need a model. Dictation never does, and
        keeps working whatever this says.
      </p>

      <Row label="In use" hint={status?.detectedLogin ? 'Claude Code login found on this Mac' : undefined}>
        <span className="mono">{live}</span>
      </Row>

      <Row label="Deciding what you meant" hint="dictate, or edit what’s on screen">
        <select
          value={settings.routing}
          onChange={(event) => void update({ routing: event.target.value as Settings['routing'] })}
        >
          <option value="model">Ask the model</option>
          <option value="rules">Rules only — nothing leaves this Mac</option>
        </select>
      </Row>
      <p>
        {settings.routing === 'model'
          ? 'When something is selected, or the box you’re typing in already has text, Mull asks a model whether you meant to dictate or to edit — and sends it that text. Speaking into an empty box never asks anything and never leaves this Mac.'
          : 'Mull decides with a local list of phrasings. Nothing about what’s on your screen is sent anywhere — but the list is noticeably worse at ordinary sentences, so expect instructions to get typed sometimes.'}
      </p>

      <Row
        label="Which model decides"
        hint={settings.routing === 'model' ? 'you wait for this one' : 'rules only — unused'}
      >
        <select
          value={settings.classifierModel}
          disabled={settings.routing !== 'model'}
          onChange={(event) =>
            void update({ classifierModel: event.target.value as Settings['classifierModel'] })
          }
        >
          <option value="haiku">Fast — Haiku 4.5</option>
          <option value="sonnet">Careful — Sonnet 5</option>
          <option value="opus">Most careful — Opus 5</option>
        </select>
      </Row>
      <p>
        This is the one decision nothing downstream reconsiders, so getting it wrong costs the
        whole request — but you wait for it before anything happens, every time. Haiku is about a
        second quicker and enough if you mostly dictate and edit. Move up if Mull keeps
        misunderstanding what you asked for, and back down if the pause starts to show.
      </p>

      <Row label="Claude subscription" hint={status?.hasSubscription ? 'token saved' : undefined}>
        {status?.hasSubscription ? (
          <button type="button" className="btn ghost" onClick={() => void signOut('subscription')}>
            Sign out
          </button>
        ) : status?.detectedLogin ? (
          <span className="mono">already signed in</span>
        ) : (
          <button type="button" className="btn ghost" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy command'}
          </button>
        )}
      </Row>

      {!status?.hasSubscription && !status?.detectedLogin ? (
        <>
          <p>
            Run <code>{SETUP_TOKEN_COMMAND}</code> in a terminal and paste what it prints. It uses
            the Claude plan you already pay for; there is nothing extra to buy.
          </p>
          <Row label="Token">
            <input
              type="password"
              className="mono"
              value={token}
              placeholder="sk-ant-oat…"
              aria-label="Claude subscription token"
              onChange={(event) => setToken(event.target.value)}
            />
            <button
              type="button"
              className="btn primary"
              disabled={!token.trim()}
              onClick={() => void save('subscription', token)}
            >
              Save
            </button>
          </Row>
        </>
      ) : null}

      <Row label="API key" hint={status?.hasApiKey ? 'saved' : 'optional'}>
        {status?.hasApiKey ? (
          <button type="button" className="btn ghost" onClick={() => void signOut('api-key')}>
            Sign out
          </button>
        ) : (
          <>
            <input
              type="password"
              className="mono"
              value={key}
              placeholder="sk-ant-…"
              aria-label="Anthropic API key"
              onChange={(event) => setKey(event.target.value)}
            />
            <button
              type="button"
              className="btn ghost"
              disabled={!key.trim()}
              onClick={() => void save('api-key', key)}
            >
              Save
            </button>
          </>
        )}
      </Row>

      <Row label="Lane" hint="auto prefers your subscription">
        <select
          value={settings.engine}
          onChange={(event) => void update({ engine: event.target.value as Settings['engine'] })}
        >
          <option value="auto">Automatic</option>
          <option value="subscription">Claude subscription</option>
          <option value="api-key">API key</option>
        </select>
      </Row>

      <Row label="Edits" hint="npm run bench:engine measures both">
        <select
          value={settings.editModel}
          onChange={(event) =>
            void update({ editModel: event.target.value as Settings['editModel'] })
          }
        >
          <option value="sonnet">Careful — Sonnet 5</option>
          <option value="haiku">Fast — Haiku 4.5</option>
        </select>
      </Row>

      <Row label="Going and looking" hint="experimental — subscription lane only">
        <select
          value={settings.agentLoop ? 'loop' : 'steps'}
          onChange={(event) => void update({ agentLoop: event.target.value === 'loop' })}
        >
          <option value="steps">One step at a time</option>
          <option value="loop">Let the model drive</option>
        </select>
      </Row>
      <p>
        {settings.agentLoop
          ? 'Mull gives the model tools — look, find, press — and it decides what to do next after seeing what each one returns. It can take up to 40 turns instead of 6, so it can do more than fetch one thing. Escape stops it at the next action; what has already been pressed stays pressed. Needs the Claude subscription lane.'
          : 'Mull runs the loop and asks the model for one step at a time, up to six, re-reading the window before each one. Reliable for “open this conversation and tell me what it says”, and not much more — it remembers nothing between steps.'}
      </p>

      <Row
        label="Which model drives"
        hint={settings.agentLoop ? 'presses things in other apps' : 'unused while stepping'}
      >
        <select
          value={settings.agentModel}
          disabled={!settings.agentLoop}
          onChange={(event) =>
            void update({ agentModel: event.target.value as Settings['agentModel'] })
          }
        >
          <option value="opus">Most careful — Opus 5</option>
          <option value="sonnet">Careful — Sonnet 5</option>
          <option value="haiku">Fast — Haiku 4.5</option>
        </select>
      </Row>
      <p>
        Separate from the edit model on purpose: a rewrite waits in a card for your ⏎, and a press
        just happens. Cheaper is not simply faster here — every turn carries a fresh read of the
        window, so a model that needs three more turns can take longer overall than the one that
        costs more per turn. Which wins depends on the app being driven.
      </p>

      <Row label="Connection">
        <button type="button" className="btn ghost" disabled={testing} onClick={() => void test()}>
          {testing ? 'Testing…' : 'Test'}
        </button>
      </Row>

      {message ? <p className="warn-line">{message}</p> : null}
      <p>
        The model is sent your instruction and the text you selected, and returns a proposal. It
        has no tools, no file access, and one turn — every change still waits for your ⏎.
      </p>
    </section>
  )
}

function SettingsWindow(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [permissions, setPermissions] = useState<PermissionsSnapshot | null>(null)
  const [model, setModel] = useState<ModelStatus | null>(null)
  const [about, setAbout] = useState<AboutInfo | null>(null)

  const bridge = window.mull

  const refreshPermissions = useCallback(() => {
    void bridge?.permissions.get().then(setPermissions)
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    void bridge.settings.get().then((next) => {
      setSettings(next)
      applyTheme(next)
    })
    void bridge.model.status().then(setModel)
    void bridge.about().then(setAbout)
    refreshPermissions()

    // Poll only while this window is open — nothing here runs in the background.
    const timer = setInterval(refreshPermissions, POLL_MS)
    return () => clearInterval(timer)
  }, [bridge, refreshPermissions])

  const update = async (patch: Partial<Settings>): Promise<void> => {
    const next = await bridge?.settings.set(patch)
    if (next) {
      setSettings(next)
      applyTheme(next)
    }
  }

  if (!bridge || !settings) {
    return (
      <div className="win">
        <div className="win-head">
          <h1>Settings</h1>
        </div>
      </div>
    )
  }

  const hotkeyLive = about?.hotkeyMode ?? 'unknown'
  const inputMonitoring = permissions?.permissions.find((p) => p.key === 'inputMonitoring')
  // Granted, but this launch never got the capability: the classic macOS
  // gotcha, and worth saying rather than leaving the user staring at a switch
  // that is already on.
  const restartHint =
    inputMonitoring?.granted === true && (hotkeyLive === 'toggle' || hotkeyLive === 'unavailable')

  return (
    <div className="win">
      <div className="win-head">
        <h1>Settings</h1>
        <p className="sub">
          Mull runs in the menu bar. Your voice is transcribed here and never uploaded; text goes to
          a model only when you ask for an edit.
        </p>
      </div>

      <div className="win-body">
        <section className="section">
          <h2>Permissions</h2>
          <p>
            Each one is asked for separately by macOS, and a ✓ below comes from asking macOS —
            not from having pressed Grant.
          </p>
          {permissions ? (
            <PermissionRows
              permissions={permissions.permissions}
              onGrant={(key) => void bridge.permissions.open(key)}
            />
          ) : (
            <p>Checking…</p>
          )}
          {restartHint ? (
            <p className="warn-line">
              Input Monitoring is granted but this launch never picked it up — quit Mull and open
              it again.
            </p>
          ) : null}
          {permissions?.secureInput ? (
            <p className="warn-line">
              Secure input is on right now, so Mull is paused. That is a password field somewhere
              holding the keyboard.
            </p>
          ) : null}
        </section>

        <section className="section">
          <h2>Hotkey</h2>
          {/*
            Two keys, two verbs — not a preference. Mull used to guess which one
            you meant from the words ("tighten", "reply", "summarise"), and the
            guess was wrong for every phrasing nobody had listed. The key is the
            answer now, so there is nothing here to choose.
          */}
          <Row label="Hold to dictate" hint={`in use: ${hotkeyLive}`}>
            <span className="fixed-key">⌥Space</span>
          </Row>
          <Row label="Hold to ask" hint={about?.canInstruct ? 'ready' : 'unavailable'}>
            <span className="fixed-key">Fn (globe)</span>
          </Row>
          <p>
            ⌥Space types what you say, instantly, with nothing sent anywhere. Fn asks Mull to
            act on it — “summarise this thread”, “make this less apologetic”, “reply saying I’ll
            have it by five” — and shows you a card before anything changes.
          </p>
          {about?.hotkeyMode !== 'tap' && about?.hotkeyTapReason ? (
            <p className="warn-line">
              {about.hotkeyTapReason === 'no-input-monitoring'
                ? 'Mull is watching the key the older way because Input Monitoring isn’t granted, and that path can’t see Fn at all — so dictation works and asking doesn’t. Grant it above, then quit and reopen Mull.'
                : `The event tap isn’t in use (${about.hotkeyTapReason}), so Fn can’t be watched; ⌥Space still dictates.`}
            </p>
          ) : null}
          {about?.canInstruct ? (
            <p className="warn-line">
              macOS also acts on the globe key and won’t let Mull stop it. Set System Settings →
              Keyboard → “Press 🌐 to” → <strong>Do Nothing</strong>, or Fn will open the emoji
              picker every time you ask Mull for something.
            </p>
          ) : null}
          <p>
            ⌥Z undoes the last thing Mull did, wherever you are. Every chord is released the
            moment Mull quits.
          </p>
        </section>

        <section className="section">
          <h2>Appearance</h2>
          <Row label="Windows">
            <select
              value={settings.theme}
              onChange={(event) => void update({ theme: event.target.value as Settings['theme'] })}
            >
              <option value="system">Follow system</option>
              <option value="light">Paper</option>
              <option value="dark">Lamplit</option>
            </select>
          </Row>
          <Row label="HUD position" hint="drag the panel anywhere to move it">
            <button
              type="button"
              className="btn ghost"
              onClick={() => void bridge.hud.resetPosition()}
            >
              Reset to bottom centre
            </button>
          </Row>
          <Row label="HUD" hint="a page in the dark">
            <select
              value={settings.hudTheme}
              onChange={(event) =>
                void update({ hudTheme: event.target.value as Settings['hudTheme'] })
              }
            >
              <option value="follow">Match windows</option>
              <option value="paper">Always paper-light</option>
            </select>
          </Row>
        </section>

        <section className="section">
          <h2>Speech model</h2>
          {model ? (
            <>
              <Row label="Model" hint={model.path}>
                <span className="mono">
                  {model.installed ? `${model.file} · ${humanBytes(model.bytes)}` : 'not installed'}
                </span>
              </Row>
              <Row label="whisper-cli" hint={model.whisperCli}>
                <span className="mono">{model.whisperInstalled ? 'found' : 'not found'}</span>
              </Row>
              {!model.whisperInstalled ? (
                <p className="warn-line">
                  Install it with <code>brew install whisper-cpp</code>, then reopen Mull.
                </p>
              ) : null}
              <p>
                Transcription runs here, on this Mac. Your audio never crosses the network, and
                neither does dictation into an empty field. Asking Mull to change text is what
                sends that text to a model — see Engine, above.
              </p>
            </>
          ) : (
            <p>Checking…</p>
          )}
        </section>

        <EnginePane settings={settings} update={update} />

        <section className="section">
          <h2>About</h2>
          <Row label="Onboarding">
            <button
              type="button"
              className="btn ghost"
              onClick={() => void bridge.windows.open('onboarding')}
            >
              Run it again
            </button>
          </Row>
          {about ? (
            <div className="about-grid">
              <span>Mull</span>
              <span className="mono">{about.appVersion}</span>
              <span>Electron</span>
              <span className="mono">{about.electron}</span>
              <span>Sidecar</span>
              <span className="mono">
                {about.sidecarVersion ?? 'not running'}
                {about.sidecarProtocol !== null ? ` · protocol ${about.sidecarProtocol}` : ''}
              </span>
              <span>Speech</span>
              <span className="mono">{about.asrProvider}</span>
              <span>Journal</span>
              <span className="mono">{about.paths.journal}</span>
              <span>Settings</span>
              <span className="mono">{about.paths.settings}</span>
              <span>Logs</span>
              <span className="mono">{about.paths.logs}</span>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('settings: #root element missing')
createRoot(container).render(
  <React.StrictMode>
    <SettingsWindow />
  </React.StrictMode>
)
