/** Core domain types. Kept dependency-free so they can be used from tests and workers. */

export type Op = 'add' | 'sub' | 'mul' | 'div' | 'mixed'

/**
 * Structural properties a generated problem is guaranteed to exercise.
 * These are what make coverage uniform: instead of hoping random draws
 * happen to produce a borrow-across-zero, we ask for one directly.
 */
export type SkillFeature =
  | 'carry'
  | 'no_carry'
  | 'borrow'
  | 'borrow_zero'
  | 'exact'
  | 'remainder'
  | 'trailing_zeros'
  | 'precedence'
  | 'parens'
  | 'three_terms'

export type SkillGroup =
  | 'Addition'
  | 'Subtraction'
  | 'Multiplication'
  | 'Division'
  | 'Mixed'
  | 'Mental'

export interface Skill {
  /** Stable key. Never renamed without a data migration — it keys all history. */
  id: string
  op: Op
  group: SkillGroup
  /** Shown to the learner and in reports, e.g. "3-digit x 2-digit". */
  label: string
  digitsA: number
  digitsB: number
  /**
   * Pins the second operand to a constant, e.g. 11 for the "x11" trick.
   * When set, digitsB is ignored for generation.
   */
  fixedB?: number
  features: SkillFeature[]
  /**
   * Reference time in seconds for fluent execution. Mastery is scored
   * against this. Seeded with estimates; overwritten by a parent
   * calibration session.
   */
  targetSec: number
  /** Ladder rung. Used to introduce unseen skills in a sensible order. */
  tier: number
  /** Difficulty weight for mental-challenge scoring (1 = easiest). */
  weight: number
  /** Mental skills are drilled without scratch paper in short timed bursts. */
  mental: boolean
}

export interface Problem {
  id: string
  skillId: string
  op: Op
  /** Display string, e.g. "435 x 39". */
  prompt: string
  operands: number[]
  answer: number
  /**
   * Only set for division-with-remainder skills, where the learner must
   * supply both quotient and remainder.
   */
  remainder?: number
}

export interface Attempt {
  id: string
  sessionId: string
  skillId: string
  prompt: string
  /** Expected answer, denormalised so reports never need to regenerate problems. */
  answer: number
  remainder?: number
  /** null means skipped. */
  given: number | null
  givenRemainder?: number | null
  correct: boolean
  /** Milliseconds spent on this problem, excluding paused time. */
  ms: number
  at: number
}

export type SessionMode = 'daily' | 'custom' | 'timed' | 'mental' | 'calibration'

export interface SessionRecord {
  id: string
  mode: SessionMode
  startedAt: number
  endedAt: number
  problemCount: number
  attemptedCount: number
  correctCount: number
  /** Sum of per-problem times; excludes paused and idle time. */
  activeMs: number
  pausesUsed: number
  completed: boolean
  /** Mental challenge only: difficulty-weighted score with skip penalties. */
  score?: number
}

/** Rolling per-skill statistics, derived from attempts and cached for speed. */
export interface SkillStat {
  skillId: string
  attempts: number
  /** Exponentially weighted accuracy in [0,1]. */
  ewmaAccuracy: number
  /** Exponentially weighted response time in ms, correct attempts only. */
  ewmaMs: number
  lastPracticedAt: number
  /** Recent raw results, newest last. Used for the median and for sparklines. */
  recentMs: number[]
  recentCorrect: boolean[]
}

export interface MasteryResult {
  skillId: string
  /** 0-125ish. 100 means fluent-adult reference speed at full accuracy. */
  score: number
  accuracy: number
  medianMs: number
  attempts: number
  /** False until there is enough data to say anything honest. */
  rated: boolean
}
