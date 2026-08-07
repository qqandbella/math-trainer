import { type ReactNode } from 'react'
import { useAppState } from '../../app/state'
import type { RouteName } from '../../app/router'

interface Props {
  navigate(route: RouteName): void
}

export function relativeTime(from: number | null, now = Date.now()): string {
  if (from === null) return 'not yet'
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * Sync deliberately sits outside parent mode.
 *
 * The Google sign-in *is* the authentication - a child cannot sync anywhere
 * without the account password - so putting a second, hidden gate in front of it
 * protects nothing and makes setting up each device unnecessarily awkward.
 */
export function SyncPage({ navigate }: Props): ReactNode {
  const { sync, signInToSync, signOutOfSyncing, runSync, attempts } = useAppState()

  return (
    <div className="stack">
      <div className="row-between">
        <h1>Sync</h1>
        <button type="button" className="btn btn-ghost" onClick={() => navigate('home')}>
          done
        </button>
      </div>

      <div className="card stack">
        {sync.account ? (
          <>
            <div className="row-between">
              <span className="muted">
                Signed in as <strong>{sync.account.email ?? sync.account.uid}</strong>
              </span>
              <span className={`pill${sync.busy ? '' : ' good'}`}>
                {sync.busy ? 'syncing…' : `synced ${relativeTime(sync.lastSyncedAt)}`}
              </span>
            </div>
            <p className="faint" style={{ margin: 0 }}>
              This device holds {attempts.length} attempts. Practice on any signed-in device
              and history converges on its own — after each session, when the app opens, and
              whenever a connection comes back.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={sync.busy}
              onClick={() => void runSync()}
            >
              {sync.busy ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              type="button"
              className="btn btn-block"
              onClick={() => void signOutOfSyncing()}
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <p className="muted" style={{ margin: 0 }}>
              Sign in with Google to keep every device in step. History is stored under your
              own account and is never shared.
            </p>
            <p className="faint" style={{ margin: 0 }}>
              Optional. Everything works offline without an account — signing in only adds
              sharing between devices, and never interrupts practice.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={sync.busy}
              onClick={() => void signInToSync()}
            >
              {sync.busy ? 'Opening…' : 'Sign in with Google'}
            </button>
          </>
        )}
        {sync.message && (
          <p className="faint" style={{ margin: 0 }}>
            {sync.message}
          </p>
        )}
      </div>
    </div>
  )
}
