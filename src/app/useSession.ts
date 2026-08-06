import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attempt, Problem, SessionMode, SessionRecord } from '../core/types'

export interface SessionSpec {
  mode: SessionMode
  /** Whose history this session is recorded against. */
  learnerId: string
  problems: Problem[]
  /** Timed and mental modes end on the clock rather than on problem count. */
  durationSec?: number
  pauseBudget: number
  /** Mental mode allows an explicit skip, which is scored as a penalty. */
  allowSkip: boolean
}

export type SessionPhase = 'running' | 'paused' | 'finished'

export interface SessionApi {
  phase: SessionPhase
  index: number
  total: number
  current: Problem | undefined
  attempts: Attempt[]
  pausesUsed: number
  pauseBudget: number
  /** Seconds left in timed modes, undefined for fixed-length sessions. */
  secondsLeft: number | undefined
  submit(given: number, givenRemainder?: number | null): boolean
  skip(): void
  pause(): void
  resume(): void
  finish(): void
  restart(): void
  buildRecord(): SessionRecord
}

function newId(): string {
  return crypto.randomUUID()
}

/**
 * Drives one practice session and produces the attempt log.
 *
 * Per-problem timing starts when a problem is shown and stops on submit, with
 * paused time subtracted - the clock must measure thinking, not the
 * interruption that made the learner put the device down.
 */
export function useSession(spec: SessionSpec, onFinish?: () => void): SessionApi {
  const [sessionId, setSessionId] = useState(newId)
  const [index, setIndex] = useState(0)
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [phase, setPhase] = useState<SessionPhase>('running')
  const [pausesUsed, setPausesUsed] = useState(0)
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  const problemShownAt = useRef<number>(Date.now())
  const pausedAt = useRef<number | null>(null)
  const pausedMsThisProblem = useRef(0)
  const pausedMsTotal = useRef(0)

  // Reset the per-problem clock whenever a new problem comes up.
  useEffect(() => {
    problemShownAt.current = Date.now()
    pausedMsThisProblem.current = 0
  }, [index, sessionId])

  const isTimed = spec.durationSec !== undefined

  useEffect(() => {
    if (phase !== 'running' || !isTimed) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [phase, isTimed])

  const secondsLeft = useMemo(() => {
    if (spec.durationSec === undefined) return undefined
    const elapsed = (now - startedAt - pausedMsTotal.current) / 1000
    return Math.max(0, Math.ceil(spec.durationSec - elapsed))
  }, [now, startedAt, spec.durationSec])

  const finish = useCallback(() => {
    setPhase('finished')
    onFinish?.()
  }, [onFinish])

  useEffect(() => {
    if (isTimed && phase === 'running' && secondsLeft === 0) finish()
  }, [isTimed, phase, secondsLeft, finish])

  const current = spec.problems[index]

  const record = useCallback(
    (problem: Problem, given: number | null, givenRemainder: number | null | undefined) => {
      const ms = Math.max(
        0,
        Date.now() - problemShownAt.current - pausedMsThisProblem.current,
      )
      const correct =
        given !== null &&
        given === problem.answer &&
        (problem.remainder === undefined || (givenRemainder ?? null) === problem.remainder)

      const attempt: Attempt = {
        id: newId(),
        learnerId: spec.learnerId,
        sessionId,
        skillId: problem.skillId,
        prompt: problem.prompt,
        answer: problem.answer,
        given,
        correct,
        ms,
        at: Date.now(),
      }
      if (problem.remainder !== undefined) {
        attempt.remainder = problem.remainder
        attempt.givenRemainder = givenRemainder ?? null
      }
      setAttempts((prev) => [...prev, attempt])
      return correct
    },
    [sessionId, spec.learnerId],
  )

  const advance = useCallback(() => {
    setIndex((prev) => {
      const next = prev + 1
      // Fixed-length sessions end when the list runs out. Timed sessions are
      // over-provisioned with problems and end on the clock instead.
      if (next >= spec.problems.length) {
        finish()
        return prev
      }
      return next
    })
  }, [spec.problems.length, finish])

  const submit = useCallback(
    (given: number, givenRemainder?: number | null): boolean => {
      if (!current || phase !== 'running') return false
      const correct = record(current, given, givenRemainder)
      advance()
      return correct
    },
    [current, phase, record, advance],
  )

  const skip = useCallback(() => {
    if (!current || phase !== 'running' || !spec.allowSkip) return
    record(current, null, null)
    advance()
  }, [current, phase, spec.allowSkip, record, advance])

  const pause = useCallback(() => {
    if (phase !== 'running' || pausesUsed >= spec.pauseBudget) return
    pausedAt.current = Date.now()
    setPausesUsed((n) => n + 1)
    setPhase('paused')
  }, [phase, pausesUsed, spec.pauseBudget])

  const resume = useCallback(() => {
    if (phase !== 'paused' || pausedAt.current === null) return
    const delta = Date.now() - pausedAt.current
    pausedMsThisProblem.current += delta
    pausedMsTotal.current += delta
    pausedAt.current = null
    setNow(Date.now())
    setPhase('running')
  }, [phase])

  const restart = useCallback(() => {
    setSessionId(newId())
    setIndex(0)
    setAttempts([])
    setPausesUsed(0)
    setPhase('running')
    pausedAt.current = null
    pausedMsThisProblem.current = 0
    pausedMsTotal.current = 0
    problemShownAt.current = Date.now()
  }, [])

  const buildRecord = useCallback((): SessionRecord => {
    const correctCount = attempts.filter((a) => a.correct).length
    const activeMs = attempts.reduce((sum, a) => sum + a.ms, 0)
    return {
      id: sessionId,
      learnerId: spec.learnerId,
      mode: spec.mode,
      startedAt,
      endedAt: Date.now(),
      problemCount: isTimed ? attempts.length : spec.problems.length,
      attemptedCount: attempts.length,
      correctCount,
      activeMs,
      pausesUsed,
      completed: isTimed ? true : attempts.length >= spec.problems.length,
    }
  }, [
    attempts,
    sessionId,
    spec.mode,
    spec.learnerId,
    spec.problems.length,
    startedAt,
    pausesUsed,
    isTimed,
  ])

  return {
    phase,
    index,
    total: isTimed ? attempts.length : spec.problems.length,
    current,
    attempts,
    pausesUsed,
    pauseBudget: spec.pauseBudget,
    secondsLeft,
    submit,
    skip,
    pause,
    resume,
    finish,
    restart,
    buildRecord,
  }
}
