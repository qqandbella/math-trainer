import { describe, expect, it } from 'vitest'
import { scoreMentalSession } from './mental'
import { mentalSkills } from '../curriculum'
import type { Attempt, Skill } from './types'

const skillsById = new Map<string, Skill>(mentalSkills.map((s) => [s.id, s]))

function attempt(skillId: string, outcome: 'correct' | 'wrong' | 'skip'): Attempt {
  return {
    id: `${skillId}-${outcome}-${Math.random()}`,
    sessionId: 's',
    skillId,
    prompt: 'x',
    answer: 10,
    given: outcome === 'skip' ? null : outcome === 'correct' ? 10 : 11,
    correct: outcome === 'correct',
    ms: 2000,
    at: 0,
  }
}

const easy = mentalSkills.reduce((a, b) => (a.weight <= b.weight ? a : b))
const hard = mentalSkills.reduce((a, b) => (a.weight >= b.weight ? a : b))

describe('mental scoring', () => {
  it('awards the skill weight for a correct answer', () => {
    const score = scoreMentalSession([attempt(hard.id, 'correct')], skillsById, 2)
    expect(score.earned).toBe(hard.weight)
    expect(score.total).toBe(hard.weight)
  })

  it('gives zero, but no penalty, for a wrong answer', () => {
    const score = scoreMentalSession([attempt(hard.id, 'wrong')], skillsById, 2)
    expect(score.earned).toBe(0)
    expect(score.penalty).toBe(0)
    expect(score.total).toBe(0)
  })

  it('penalises skipping an easy problem MORE than a hard one', () => {
    const skipEasy = scoreMentalSession([attempt(easy.id, 'skip')], skillsById, 2)
    const skipHard = scoreMentalSession([attempt(hard.id, 'skip')], skillsById, 2)
    expect(skipEasy.penalty).toBeGreaterThan(skipHard.penalty)
    expect(skipEasy.total).toBeLessThan(skipHard.total)
  })

  it('makes skipping strictly worse than attempting and failing', () => {
    const wrong = scoreMentalSession([attempt(easy.id, 'wrong')], skillsById, 2)
    const skipped = scoreMentalSession([attempt(easy.id, 'skip')], skillsById, 2)
    expect(skipped.total).toBeLessThan(wrong.total)
  })

  it('tallies a mixed session', () => {
    const score = scoreMentalSession(
      [
        attempt(hard.id, 'correct'),
        attempt(easy.id, 'correct'),
        attempt(hard.id, 'wrong'),
        attempt(easy.id, 'skip'),
      ],
      skillsById,
      2,
    )
    expect(score.correct).toBe(2)
    expect(score.wrong).toBe(1)
    expect(score.skipped).toBe(1)
    expect(score.total).toBe(score.earned - score.penalty)
  })
})
