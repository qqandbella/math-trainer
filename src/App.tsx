import { type ReactNode } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useRoute } from './app/router'
import { useAppState } from './app/state'
import { Dashboard } from './ui/pages/Dashboard'
import { PracticePage } from './ui/pages/PracticePage'
import { Reports } from './ui/pages/Reports'
import { Parent } from './ui/pages/Parent'

/**
 * A cached service worker will happily serve a stale build forever, which on a
 * device that is only opened in the car means fixes silently never land. The
 * banner makes the update explicit and one tap away.
 */
function UpdateBanner(): ReactNode {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh) return null
  return (
    <div className="banner no-print">
      <span>A new version is ready.</span>
      <div className="row">
        <button type="button" className="btn" onClick={() => void updateServiceWorker(true)}>
          Reload
        </button>
        <button type="button" className="btn" onClick={() => setNeedRefresh(false)}>
          Later
        </button>
      </div>
    </div>
  )
}

export function App(): ReactNode {
  const [route, navigate] = useRoute()
  const { ready } = useAppState()

  if (!ready) {
    return (
      <div className="app">
        <p className="muted center" style={{ marginTop: 60 }}>
          Loading…
        </p>
      </div>
    )
  }

  return (
    <div className="app">
      {route === 'home' && <Dashboard navigate={navigate} />}
      {(route === 'daily' || route === 'custom' || route === 'timed' || route === 'mental') && (
        <PracticePage mode={route} navigate={navigate} />
      )}
      {route === 'reports' && <Reports navigate={navigate} />}
      {route === 'parent' && <Parent navigate={navigate} />}
      <UpdateBanner />
    </div>
  )
}
