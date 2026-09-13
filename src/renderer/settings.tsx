import React, { useCallback, useEffect, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { AboutInfo } from '@shared/about'
import type { ModelStatus } from '@shared/model'
import type { PermissionsSnapshot } from '@shared/permissions'
import type { Settings } from '@shared/settings'
import { PermissionRows } from './components/PermissionRows'
import { applyTheme } from './theme'
import './tokens.css'
import './hud.css'
import './windows.css'

/**
 * Settings (docs/DESIGN.md §6.8).
 *
 * Four panes, in the order someone actually needs them: the one that unsticks
 * a broken install first, the cosmetic one last. Permissions poll while this
 * window is open — granting happens in System Settings, out of our reach, and
 * the only honest way to know it landed is to keep asking.
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
        <p className="sub">Mull runs in the menu bar. Nothing here leaves this Mac.</p>
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
          <Row label="Hold to dictate" hint={`in use: ${hotkeyLive}`}>
            <select
              value={settings.hotkey}
              onChange={(event) => void update({ hotkey: event.target.value as Settings['hotkey'] })}
            >
              <option value="opt-space">⌥Space</option>
              <option value="fn">Fn (globe)</option>
            </select>
          </Row>
          {about?.hotkeyMode !== 'tap' && about?.hotkeyTapReason ? (
            <p className="warn-line">
              {about.hotkeyTapReason === 'no-input-monitoring'
                ? 'Mull is watching the key the older way because Input Monitoring isn’t granted. Grant it above, then quit and reopen Mull — the better path also removes the stray space ⌥Space types.'
                : `The event tap isn’t in use (${about.hotkeyTapReason}); Mull fell back to the older listener.`}
            </p>
          ) : null}
          {settings.hotkey === 'fn' && about?.hotkeyMode !== 'tap' ? (
            <p className="warn-line">
              Fn needs the event tap, so ⌥Space is what actually works right now.
            </p>
          ) : null}
          <p>
            ⌥Z undoes the last thing Mull did, wherever you are. Both chords are released the
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
                Transcription runs here, on this Mac. The audio and the transcript never cross the
                network.
              </p>
            </>
          ) : (
            <p>Checking…</p>
          )}
        </section>

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
