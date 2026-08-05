import type { Attempt, MasteryResult, Skill, SkillStat } from './types'
import type { ScoringConfig } from '../curriculum'

export function emptyStat(skillId: string): SkillStat {
  return {
    skillId,
    attempts: 0,
    ewmaAccuracy: 0,
    ewmaMs: 0,
    lastPracticedAt: 0,
    recentMs: [],
    recentCorrect: [],
  }
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/**
 * Folds one attempt into a skill's rolling stats. Pure - returns a new object.
 *
 * Timing only accumulates from correct attempts: the time spent producing a
 * wrong answer says nothing about how fast she can do the skill, and letting
 * it in would make a bad session look like a fast one.
 */
export function updateStat(
  prev: SkillStat,
  attempt: Attempt,
  cfg: ScoringConfig,
): SkillStat {
  const alpha = cfg.ewmaAlpha
  const correctness = attempt.correct ? 1 : 0
  const ewmaAccuracy =
    prev.attempts === 0
      ? correctness
      : alpha * correctness + (1 - alpha) * prev.ewmaAccuracy

  let ewmaMs = prev.ewmaMs
  const recentMs = prev.recentMs.slice()
  if (attempt.correct) {
    ewmaMs = ewmaMs === 0 ? attempt.ms : alpha * attempt.ms + (1 - alpha) * ewmaMs
    recentMs.push(attempt.ms)
    if (recentMs.length > cfg.recentWindow) recentMs.shift()
  }

  const recentCorrect = prev.recentCorrect.concat(attempt.correct)
  if (recentCorrect.length > cfg.recentWindow) recentCorrect.shift()

  return {
    skillId: prev.skillId,
    attempts: prev.attempts + 1,
    ewmaAccuracy,
    ewmaMs,
    lastPracticedAt: Math.max(prev.lastPracticedAt, attempt.at),
    recentMs,
    recentCorrect,
  }
}

/**
 * mastery = 100 * accuracy^e * clamp(target / actual, 0, cap)
 *
 * Accuracy is super-linear so that 90% reads visibly below 100%, and the speed
 * term is capped so racing past the reference time cannot offset errors.
 * 100 means "at the calibrated fluent-adult time, with no mistakes".
 */
export function computeMastery(
  stat: SkillStat | undefined,
  skill: Skill,
  cfg: ScoringConfig,
): MasteryResult {
  if (!stat || stat.attempts === 0) {
    return {
      skillId: skill.id,
      score: 0,
      accuracy: 0,
      medianMs: 0,
      attempts: 0,
      rated: false,
    }
  }

  const medianMs = median(stat.recentMs)
  const rated = stat.attempts >= cfg.minAttemptsToRate && stat.recentMs.length >= 3
  const targetMs = skill.targetSec * 1000
  const speedRatio = medianMs > 0 ? Math.min(cfg.speedCap, targetMs / medianMs) : 0
  const score = 100 * Math.pow(stat.ewmaAccuracy, cfg.accuracyExponent) * speedRatio

  return {
    skillId: skill.id,
    score: Math.round(score * 10) / 10,
    accuracy: stat.ewmaAccuracy,
    medianMs,
    attempts: stat.attempts,
    rated,
  }
}

export function applyAttempts(
  stats: Map<string, SkillStat>,
  attempts: readonly Attempt[],
  cfg: ScoringConfig,
): Map<string, SkillStat> {
  const next = new Map(stats)
  for (const attempt of attempts) {
    const prev = next.get(attempt.skillId) ?? emptyStat(attempt.skillId)
    next.set(attempt.skillId, updateStat(prev, attempt, cfg))
  }
  return next
}

/** Rebuilds all stats from the raw attempt log - used after an import merge. */
export function rebuildStats(
  attempts: readonly Attempt[],
  cfg: ScoringConfig,
): Map<string, SkillStat> {
  const ordered = attempts.slice().sort((a, b) => a.at - b.at)
  return applyAttempts(new Map(), ordered, cfg)
}
