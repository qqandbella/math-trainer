import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useAppState } from '../../app/state'
import type { RouteName } from '../../app/router'
import { curriculum } from '../../curriculum'
import { relativeTime } from './SyncPage'

interface Props {
  navigate(route: RouteName): void
}

const DAY_MS = 24 * 60 * 60 * 1000
const SECRET_HOLD_MS = 3000

function dayKey(ms: number): string {
  return new Date(ms).toDateString()
}

/** Consecutive days ending today (or yesterday) with at least one session. */
function computeStreak(sessionDays: Set<string>): number {
  let streak = 0
  const today = Date.now()
  if (!sessionDays.has(dayKey(today)) && !sessionDays.has(dayKey(today - DAY_MS))) return 0
  for (let offset = sessionDays.has(dayKey(today)) ? 0 : 1; ; offset++) {
    if (!sessionDays.has(dayKey(today - offset * DAY_MS))) break
    streak++
  }
  return streak
}

export function Dashboard({ navigate }: Props): ReactNode {
  const { sessions, attempts, settings, sync } = useAppState()
  const holdTimer = useRef<number | null>(null)
  const [holding, setHolding] = useState(false)

  const summary = useMemo(() => {
    const days = new Set(sessions.map((s) => dayKey(s.startedAt)))
    const weekAgo = Date.now() - 7 * DAY_MS
    const recent = attempts.filter((a) => a.at >= weekAgo && a.given !== null)
    const correct = recent.filter((a) => a.correct).length
    const todays = sessions.filter((s) => dayKey(s.startedAt) === dayKey(Date.now()))
    return {
      streak: computeStreak(days),
      weekAccuracy: recent.length > 0 ? Math.round((correct / recent.length) * 100) : null,
      weekProblems: recent.length,
      todaySessions: todays.length,
    }
  }, [sessions, attempts])

  /**
   * Hidden entry to parent mode: press and hold the title. There is no visible
   * affordance, and the TOTP gate behind it is what actually enforces access.
   *
   * The pointer is captured for the duration so that a few pixels of drift -
   * unavoidable when holding a finger on a tablet - cannot fire pointerleave
   * and silently reset the timer. While held, the title fades slowly, which is
   * enough feedback to tell a parent the press registered without advertising
   * to a child that anything is there.
   */
  const startHold = useCallback(
    (event: ReactPointerEvent<HTMLHeadingElement>) => {
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setHolding(true)
      holdTimer.current = window.setTimeout(() => {
        setHolding(false)
        navigate('parent')
      }, SECRET_HOLD_MS)
    },
    [navigate],
  )

  const cancelHold = useCallback(() => {
    setHolding(false)
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }, [])

  const name = settings.learnerName.trim()

  return (
    <div className="stack">
      <div className="app-header">
        <h1
          className={`app-title${holding ? ' holding' : ''}`}
          onPointerDown={startHold}
          onPointerUp={cancelHold}
          onPointerCancel={cancelHold}
          onContextMenu={(e) => e.preventDefault()}
        >
          Math Trainer
        </h1>
        <div className="row" style={{ gap: 8 }}>
          {name && <span className="muted">{name}</span>}
          <button
            type="button"
            className={`pill${sync.account ? ' good' : ''}`}
            onClick={() => navigate('sync')}
          >
            {sync.busy
              ? 'syncing…'
              : sync.account
                ? `synced ${relativeTime(sync.lastSyncedAt)}`
                : 'sign in to sync'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="stat-row">
          <div className="stat">
            <div className="value">{summary.streak}</div>
            <div className="label">day streak</div>
          </div>
          <div className="stat">
            <div className="value">{summary.todaySessions}</div>
            <div className="label">today</div>
          </div>
          <div className="stat">
            <div className="value">
              {summary.weekAccuracy === null ? '—' : `${summary.weekAccuracy}%`}
            </div>
            <div className="label">7-day accuracy</div>
          </div>
          <div className="stat">
            <div className="value">{summary.weekProblems}</div>
            <div className="label">7-day problems</div>
          </div>
        </div>
      </div>

      <div className="mode-grid">
        <button type="button" className="mode-card primary" onClick={() => navigate('daily')}>
          <span className="title">Daily Practice</span>
          <span className="muted">
            {curriculum.presets.daily.problemCount} problems, picked for what needs work
          </span>
        </button>

        <button type="button" className="mode-card" onClick={() => navigate('mental')}>
          <span className="title">Mental Challenge</span>
          <span className="muted">
            {Math.round(curriculum.presets.mental.durationSec / 60)} minutes, no paper — score
            as many as you can
          </span>
        </button>

        <button type="button" className="mode-card" onClick={() => navigate('timed')}>
          <span className="title">Timed Challenge</span>
          <span className="muted">
            {Math.round(curriculum.presets.timed.durationSec / 60)} minutes against the clock
          </span>
        </button>

        <button type="button" className="mode-card" onClick={() => navigate('custom')}>
          <span className="title">Custom Practice</span>
          <span className="muted">Choose the operations and how many</span>
        </button>

        <button type="button" className="mode-card" onClick={() => navigate('reports')}>
          <span className="title">Progress</span>
          <span className="muted">Charts, per-skill mastery, personal bests</span>
        </button>
      </div>
    </div>
  )
}
