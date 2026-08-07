import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Attempt, Skill } from '../../core/types'
import { useSession, type SessionSpec } from '../../app/useSession'
import { useAppState } from '../../app/state'
import { AnswerPad } from './AnswerPad'
import { scoreMentalSession, type MentalScore } from '../../core/mental'
import { curriculum } from '../../curriculum'
import { saveAttempts } from '../../storage/db'

interface Props {
  spec: SessionSpec
  onExit(): void
  onRestart?: (() => void) | undefined
  /** Mental mode reports a difficulty-weighted score instead of raw accuracy. */
  scoreAsMental?: boolean
  /**
   * Parent calibration runs through the same UI but must never be written to
   * the learner's history - the whole point is that a parent is answering.
   */
  persist?: boolean
  onComplete?: ((attempts: Attempt[]) => void) | undefined
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function SessionRunner({
  spec,
  onExit,
  onRestart,
  scoreAsMental = false,
  persist = true,
  onComplete,
}: Props): ReactNode {
  const { recordSession, settings, skills } = useAppState()
  const session = useSession(spec)
  const [flash, setFlash] = useState(false)
  const savedRef = useRef(false)
  const flushedRef = useRef(0)

  const skillsById = useMemo(() => new Map(skills.map((s) => [s.id, s])), [skills])

  const mentalScore = useMemo<MentalScore | null>(
    () =>
      scoreAsMental
        ? scoreMentalSession(
            session.attempts,
            skillsById,
            curriculum.presets.mental.skipPenaltyDivisor,
          )
        : null,
    [scoreAsMental, session.attempts, skillsById],
  )

  /**
   * Write each answer to disk as it happens, rather than only at the end.
   *
   * A backgrounded tab can be discarded at any moment - iOS is aggressive about
   * this, and a car ride is exactly when someone switches away - which would
   * otherwise throw away every problem completed so far. Attempts are immutable
   * and UUID-keyed, so re-saving them at the end is a harmless no-op.
   */
  useEffect(() => {
    if (!persist) return
    const pending = session.attempts.slice(flushedRef.current)
    if (pending.length === 0) return
    flushedRef.current = session.attempts.length
    void saveAttempts(pending, { enqueue: true })
  }, [session.attempts, persist])

  /**
   * Flush again the moment the page is hidden. iOS signals `pagehide` /
   * `visibilitychange` before it discards a backgrounded tab, so this is the
   * last reliable chance to get in-flight answers onto disk.
   */
  const attemptsRef = useRef(session.attempts)
  attemptsRef.current = session.attempts
  useEffect(() => {
    if (!persist) return
    const flush = (): void => {
      const pending = attemptsRef.current.slice(flushedRef.current)
      if (pending.length === 0) return
      flushedRef.current = attemptsRef.current.length
      void saveAttempts(pending, { enqueue: true })
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [persist])

  // Persist exactly once, when the session ends.
  useEffect(() => {
    if (session.phase !== 'finished' || savedRef.current) return
    savedRef.current = true
    if (!persist) {
      onComplete?.(session.attempts)
      return
    }
    const record = session.buildRecord()
    if (mentalScore) record.score = mentalScore.total
    void recordSession(record, session.attempts)
  }, [
    session.phase,
    session.attempts,
    session.buildRecord,
    mentalScore,
    recordSession,
    persist,
    onComplete,
  ])

  const handleSubmit = useCallback(
    (answer: number, remainder: number | null) => {
      const correct = session.submit(answer, remainder)
      if (correct) {
        setFlash(true)
        window.setTimeout(() => setFlash(false), 380)
      }
    },
    [session],
  )

  const handleRestart = useCallback(() => {
    savedRef.current = false
    flushedRef.current = 0
    session.restart()
    onRestart?.()
  }, [session, onRestart])

  if (session.phase === 'finished') {
    return (
      <SessionSummary
        attempts={session.attempts}
        skillsById={skillsById}
        mentalScore={mentalScore}
        onExit={onExit}
        onAgain={handleRestart}
      />
    )
  }

  const { current, secondsLeft } = session
  const progress =
    secondsLeft !== undefined && spec.durationSec
      ? 1 - secondsLeft / spec.durationSec
      : session.index / Math.max(1, spec.problems.length)

  return (
    <div className="session">
      <div className="session-top">
        <button type="button" className="btn btn-ghost" onClick={onExit}>
          ← exit
        </button>
        {secondsLeft !== undefined ? (
          <span className={`big-timer${secondsLeft <= 15 ? ' urgent' : ''}`}>
            {formatClock(secondsLeft)}
          </span>
        ) : (
          <span>
            {session.index + 1} / {spec.problems.length}
          </span>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={session.pause}
          disabled={session.pausesUsed >= session.pauseBudget}
        >
          pause {session.pauseBudget - session.pausesUsed}
        </button>
      </div>

      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.min(100, progress * 100)}%` }} />
      </div>

      <div className={`problem-area${flash ? ' flash-correct' : ''}`}>
        <div className="problem-prompt">{current ? `${current.prompt} =` : ''}</div>
        {current && (
          <AnswerPad
            problem={current}
            onSubmit={handleSubmit}
            onSkip={spec.allowSkip ? session.skip : undefined}
          />
        )}
      </div>

      {session.phase === 'paused' && (
        <div className="overlay">
          <div className="card center stack">
            <h2>Paused</h2>
            <p className="muted">
              The clock is stopped. {session.pauseBudget - session.pausesUsed} pause
              {session.pauseBudget - session.pausesUsed === 1 ? '' : 's'} left after this.
            </p>
            <button type="button" className="btn btn-primary btn-block" onClick={session.resume}>
              Resume
            </button>
            <button type="button" className="btn btn-ghost btn-block" onClick={session.finish}>
              End session now
            </button>
          </div>
        </div>
      )}

      {settings.revealAnswersDuringSession && session.attempts.length > 0 && (
        <div className="center faint">
          last:{' '}
          {(session.attempts[session.attempts.length - 1] as Attempt).correct
            ? 'correct'
            : `should be ${(session.attempts[session.attempts.length - 1] as Attempt).answer}`}
        </div>
      )}
    </div>
  )
}

interface SummaryProps {
  attempts: Attempt[]
  skillsById: Map<string, Skill>
  mentalScore: MentalScore | null
  onExit(): void
  onAgain(): void
}

function SessionSummary({
  attempts,
  skillsById,
  mentalScore,
  onExit,
  onAgain,
}: SummaryProps): ReactNode {
  const answered = attempts.filter((a) => a.given !== null)
  const correct = attempts.filter((a) => a.correct)
  const wrong = attempts.filter((a) => a.given !== null && !a.correct)
  const totalMs = attempts.reduce((sum, a) => sum + a.ms, 0)
  const accuracy = answered.length > 0 ? correct.length / answered.length : 0
  const avgSec = answered.length > 0 ? totalMs / answered.length / 1000 : 0

  const slowest = [...answered].sort((a, b) => b.ms - a.ms).slice(0, 3)

  return (
    <div className="stack">
      <h1>Session complete</h1>

      <div className="card">
        <div className="stat-row">
          {mentalScore ? (
            <div className="stat">
              <div className="value">{mentalScore.total}</div>
              <div className="label">score</div>
            </div>
          ) : null}
          <div className="stat">
            <div className="value">
              {correct.length}/{answered.length}
            </div>
            <div className="label">correct</div>
          </div>
          <div className="stat">
            <div className="value">{Math.round(accuracy * 100)}%</div>
            <div className="label">accuracy</div>
          </div>
          <div className="stat">
            <div className="value">{avgSec.toFixed(1)}s</div>
            <div className="label">avg / problem</div>
          </div>
          <div className="stat">
            <div className="value">{Math.round(totalMs / 1000 / 60)}m</div>
            <div className="label">working time</div>
          </div>
        </div>
        {mentalScore && (
          <p className="faint center" style={{ marginTop: 10, marginBottom: 0 }}>
            +{mentalScore.earned} earned − {mentalScore.penalty} skip penalty ·{' '}
            {mentalScore.skipped} skipped
          </p>
        )}
      </div>

      {wrong.length > 0 && (
        <div className="card">
          <h3>Worth a second look</h3>
          <p className="faint" style={{ marginTop: 2 }}>
            {wrong.length} to review. Redo these on paper before the next session.
          </p>
          <div className="review-list">
            {wrong.map((a) => (
              <div key={a.id} className="review-item">
                <span className="expr">{a.prompt} =</span>
                <span>
                  <span className="given">
                    {a.given}
                    {a.remainder !== undefined && a.givenRemainder != null
                      ? ` r${a.givenRemainder}`
                      : ''}
                  </span>{' '}
                  <span className="right">
                    {a.answer}
                    {a.remainder !== undefined ? ` r${a.remainder}` : ''}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {wrong.length === 0 && answered.length > 0 && (
        <div className="card center">
          <h3 style={{ color: 'var(--good)' }}>Everything correct</h3>
          <p className="muted" style={{ marginBottom: 0 }}>
            No mistakes in this session.
          </p>
        </div>
      )}

      {slowest.length > 0 && (
        <div className="card">
          <h3>Slowest problems</h3>
          <table className="data">
            <tbody>
              {slowest.map((a) => (
                <tr key={a.id}>
                  <td>{a.prompt}</td>
                  <td className="muted">{skillsById.get(a.skillId)?.label ?? a.skillId}</td>
                  <td style={{ textAlign: 'right', fontWeight: 650 }}>
                    {(a.ms / 1000).toFixed(1)}s
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row">
        <button type="button" className="btn btn-primary btn-block" onClick={onAgain}>
          Again
        </button>
        <button type="button" className="btn btn-block" onClick={onExit}>
          Done
        </button>
      </div>
    </div>
  )
}
