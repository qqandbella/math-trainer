import type { Attempt, Skill } from './types'

export interface MentalScore {
  total: number
  earned: number
  penalty: number
  correct: number
  wrong: number
  skipped: number
}

/**
 * Difficulty-weighted scoring for the mental challenge.
 *
 *   correct -> + the skill's weight
 *   wrong   -> 0
 *   skipped -> a penalty that is LARGER for easier problems
 *
 * The inverted skip penalty is the point: ducking a 7x8 should cost more than
 * ducking a 2-digit multiplication, so the incentive is to attempt everything
 * rather than cherry-pick.
 */
export function scoreMentalSession(
  attempts: readonly Attempt[],
  skillsById: Map<string, Skill>,
  skipPenaltyDivisor: number,
): MentalScore {
  const weights = [...skillsById.values()].map((s) => s.weight)
  const maxWeight = weights.length > 0 ? Math.max(...weights) : 1

  let earned = 0
  let penalty = 0
  let correct = 0
  let wrong = 0
  let skipped = 0

  for (const attempt of attempts) {
    const weight = skillsById.get(attempt.skillId)?.weight ?? 1
    if (attempt.given === null) {
      skipped++
      penalty += Math.max(1, Math.round((maxWeight + 1 - weight) / skipPenaltyDivisor))
    } else if (attempt.correct) {
      correct++
      earned += weight
    } else {
      wrong++
    }
  }

  return { total: earned - penalty, earned, penalty, correct, wrong, skipped }
}
