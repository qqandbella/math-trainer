import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Attempt, SessionMode, SessionRecord, Skill } from '../../core/types'
import { loadWorkings } from '../../storage/db'

const MODE_LABEL: Record<SessionMode, string> = {
  daily: 'Daily Practice',
  custom: 'Custom Practice',
  timed: 'Timed Challenge',
  mental: 'Mental Challenge',
  calibration: 'Calibration',
}

function when(ms: number): string {
  const date = new Date(ms)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Today ${time}`
  const yesterday = new Date(today.getTime() - 86400000)
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

interface Props {
  sessions: readonly SessionRecord[]
  attempts: readonly Attempt[]
  skills: readonly Skill[]
  /** Enables selection and reports which sessions are ticked. */
  selectable?: boolean
  selected?: ReadonlySet<string>
  onToggleSelected?: ((sessionId: string) => void) | undefined
}

/**
 * Sessions newest first, each expandable to the problems it contained.
 *
 * A daily total hides what actually happened: two sessions on one day can be a
 * mental challenge and a written practice, which are not comparable. This shows
 * them separately, and lets a session that should never have counted - a parent
 * trying the app - be removed rather than averaged into the learner's record.
 */
export function SessionHistory({
  sessions,
  attempts,
  skills,
  selectable = false,
  selected,
  onToggleSelected,
}: Props): ReactNode {
  const [openId, setOpenId] = useState<string | null>(null)
  const [workings, setWorkings] = useState<Map<string, string>>(new Map())
  const [showingWorking, setShowingWorking] = useState<string | null>(null)

  const skillsById = useMemo(() => new Map(skills.map((s) => [s.id, s])), [skills])

  const bySession = useMemo(() => {
    const map = new Map<string, Attempt[]>()
    for (const a of attempts) {
      const list = map.get(a.sessionId)
      if (list) list.push(a)
      else map.set(a.sessionId, [a])
    }
    return map
  }, [attempts])

  const ordered = useMemo(
    () => [...sessions].sort((a, b) => b.startedAt - a.startedAt),
    [sessions],
  )

  useEffect(() => {
    if (!openId) return
    const wrong = (bySession.get(openId) ?? [])
      .filter((a) => a.given !== null && !a.correct)
      .map((a) => a.id)
    void loadWorkings(wrong).then(setWorkings)
  }, [openId, bySession])

  if (ordered.length === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        No sessions yet.
      </p>
    )
  }

  return (
    <div className="session-list">
      {ordered.map((session) => {
        const list = bySession.get(session.id) ?? []
        const answered = list.filter((a) => a.given !== null)
        const correct = answered.filter((a) => a.correct).length
        const accuracy = answered.length > 0 ? Math.round((correct / answered.length) * 100) : 0
        const avgSec =
          answered.length > 0
            ? answered.reduce((sum, a) => sum + a.ms, 0) / answered.length / 1000
            : 0
        const open = openId === session.id
        const ticked = selected?.has(session.id) ?? false

        return (
          <div key={session.id} className={`session-row${ticked ? ' ticked' : ''}`}>
            <div className="session-row-head">
              {selectable && (
                <input
                  type="checkbox"
                  checked={ticked}
                  onChange={() => onToggleSelected?.(session.id)}
                  aria-label={`select ${MODE_LABEL[session.mode]} from ${when(session.startedAt)}`}
                />
              )}
              <button
                type="button"
                className="session-row-main"
                onClick={() => setOpenId(open ? null : session.id)}
              >
                <span className="session-row-title">
                  {MODE_LABEL[session.mode]}
                  {session.score !== undefined && (
                    <span className="pill good" style={{ marginLeft: 8 }}>
                      score {session.score}
                    </span>
                  )}
                </span>
                <span className="faint">{when(session.startedAt)}</span>
              </button>
              <span className="session-row-stats">
                <strong>
                  {correct}/{answered.length}
                </strong>
                <span className="faint">
                  {accuracy}% · {avgSec.toFixed(1)}s
                </span>
              </span>
            </div>

            {open && (
              <div className="session-detail">
                {list.length === 0 && <p className="faint">No problems recorded.</p>}
                {list.map((a) => (
                  <div key={a.id}>
                    <div className={`attempt-row${a.correct ? '' : ' wrong'}`}>
                      <span>{a.prompt} =</span>
                      <span>
                        {a.given === null ? (
                          <span className="faint">skipped</span>
                        ) : a.correct ? (
                          <span className="right">{a.given}</span>
                        ) : (
                          <>
                            <span className="given">{a.given}</span>{' '}
                            <span className="right">{a.answer}</span>
                          </>
                        )}
                      </span>
                      <span className="faint">{(a.ms / 1000).toFixed(1)}s</span>
                      <span className="faint">{skillsById.get(a.skillId)?.label ?? a.skillId}</span>
                      {workings.has(a.id) && (
                        <button
                          type="button"
                          className="pill"
                          onClick={() =>
                            setShowingWorking(showingWorking === a.id ? null : a.id)
                          }
                        >
                          {showingWorking === a.id ? 'hide' : 'working'}
                        </button>
                      )}
                    </div>
                    {showingWorking === a.id && (
                      <img className="working-image" src={workings.get(a.id)} alt="working out" />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
