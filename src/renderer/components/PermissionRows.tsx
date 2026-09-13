import type { JSX } from 'react'
import type { PermissionInfo } from '@shared/permissions'

/**
 * Permission rows, in the plan card's step shape (docs/DESIGN.md §6.4, §6.8).
 *
 * The state cell is the whole point: `·` not yet, `✓` granted — and the ✓ only
 * ever arrives from polling macOS, never from the user having clicked Grant.
 * Grant opens the right pane and nothing more, because that is all the button
 * can honestly do.
 *
 * Shared by the settings pane and onboarding page 3 so both tell the same
 * story about the same switches.
 *
 * One of them is optional, and is marked rather than hidden. A row that is
 * merely off must not read like a broken installation — but a permission
 * nobody can see is a permission nobody grants, which is exactly what happened
 * to Screen Recording: the screenshot half of `windowContext` was built,
 * shipped, and never once executed, because there was no row to grant it from.
 */
export function PermissionRows({
  permissions,
  onGrant
}: {
  permissions: PermissionInfo[]
  onGrant: (key: PermissionInfo['key']) => void
}): JSX.Element {
  return (
    <div className="perm-rows">
      {permissions.map((permission) => (
        <div key={permission.key} className={`perm-row ${permission.granted ? 'is-done' : ''}`}>
          <span className="st" aria-hidden="true">
            {permission.granted ? '✓' : '·'}
          </span>
          <div className="perm-text">
            <div className="perm-name">
              {permission.label}
              {permission.optional ? <span className="perm-optional">optional</span> : null}
              <span className="sr-only">
                {permission.granted ? ' — granted' : ' — not granted yet'}
              </span>
            </div>
            <p className="perm-reason">{permission.reason}</p>
          </div>
          {permission.granted ? (
            <span className="perm-granted">Granted</span>
          ) : (
            <button type="button" className="btn ghost" onClick={() => onGrant(permission.key)}>
              {/* Said on the button, because this is the one grant where
                  nothing visible happens until Mull is launched again — and a
                  row still showing `·` after the switch was flipped reads as a
                  failure rather than as a wait. */}
              {permission.needsRelaunch ? 'Grant, then relaunch' : 'Grant'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
