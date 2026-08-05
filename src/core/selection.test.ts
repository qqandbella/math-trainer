import { describe, expect, it } from 'vitest'
import { curriculum, practiceSkills, requireSkill } from '../curriculum'
import { createRng } from './rng'
import { selectByMix, selectSkills, type SelectionContext } from './selection'
import { applyAttempts, computeMastery, emptyStat, updateStat } from './mastery'
import type { Attempt, SkillStat } from './types'

const scoring = curriculum.scoring
const NOW = 1_800_000_000_000

function attempt(skillId: string, correct: boolean, ms: number, at = NOW): Attempt {
  return {
    id: `${skillId}-${at}-${ms}`,
    sessionId: 's1',
    skillId,
    prompt: 'x',
    answer: 1,
    given: correct ? 1 : 2,
    correct,
    ms,
    at,
  }
}

function ctx(stats: Map<string, SkillStat>, seed = 1): SelectionContext {
  return {
    stats,
    now: NOW,
    rng: createRng(seed),
    selection: curriculum.selection,
    scoring,
  }
}

describe('mastery', () => {
  it('scores 100 when accuracy is perfect and speed matches the reference', () => {
    const skill = requireSkill('mul_3x2')
    let stat = emptyStat(skill.id)
    for (let i = 0; i < 12; i++) {
      stat = updateStat(stat, attempt(skill.id, true, skill.targetSec * 1000), scoring)
    }
    const m = computeMastery(stat, skill, scoring)
    expect(m.rated).toBe(true)
    expect(m.score).toBeCloseTo(100, 1)
  })

  it('caps the speed bonus so racing cannot offset errors', () => {
    const skill = requireSkill('mul_3x2')
    let fast = emptyStat(skill.id)
    for (let i = 0; i < 12; i++) {
      fast = updateStat(fast, attempt(skill.id, true, 100), scoring)
    }
    expect(computeMastery(fast, skill, scoring).score).toBeCloseTo(
      100 * scoring.speedCap,
      1,
    )
  })

  it('penalises inaccuracy super-linearly', () => {
    const skill = requireSkill('mul_3x2')
    let stat = emptyStat(skill.id)
    // Alternate 9 correct / 1 wrong repeatedly, at reference speed.
    for (let i = 0; i < 40; i++) {
      stat = updateStat(stat, attempt(skill.id, i % 10 !== 0, skill.targetSec * 1000), scoring)
    }
    const m = computeMastery(stat, skill, scoring)
    expect(m.score).toBeLessThan(100)
    expect(m.score).toBeGreaterThan(50)
  })

  it('stays unrated until there is enough evidence', () => {
    const skill = requireSkill('mul_3x2')
    let stat = emptyStat(skill.id)
    for (let i = 0; i < 3; i++) {
      stat = updateStat(stat, attempt(skill.id, true, 1000), scoring)
    }
    expect(computeMastery(stat, skill, scoring).rated).toBe(false)
  })

  it('ignores time from wrong answers when measuring speed', () => {
    const skill = requireSkill('mul_3x2')
    let stat = emptyStat(skill.id)
    for (let i = 0; i < 10; i++) {
      stat = updateStat(stat, attempt(skill.id, true, 5000), scoring)
    }
    stat = updateStat(stat, attempt(skill.id, false, 1), scoring)
    expect(computeMastery(stat, skill, scoring).medianMs).toBe(5000)
  })
})

describe('selection', () => {
  it('returns exactly the requested number of problems', () => {
    for (const count of [10, 30, 60, 61]) {
      const picked = selectSkills(practiceSkills, count, ctx(new Map()))
      expect(picked).toHaveLength(count)
    }
  })

  it('honours the daily operation mix', () => {
    const { problemCount, mix } = curriculum.presets.daily
    const picked = selectByMix(practiceSkills, mix, problemCount, ctx(new Map()))
    expect(picked).toHaveLength(problemCount)

    const byOp = new Map<string, number>()
    for (const s of picked) byOp.set(s.op, (byOp.get(s.op) ?? 0) + 1)
    for (const [op, want] of Object.entries(mix)) {
      expect(byOp.get(op) ?? 0).toBe(want)
    }
  })

  it('caps how much of a session any single skill can take', () => {
    const picked = selectSkills(practiceSkills, 60, ctx(new Map()))
    const counts = new Map<string, number>()
    for (const s of picked) counts.set(s.id, (counts.get(s.id) ?? 0) + 1)
    const cap = Math.round(60 * curriculum.selection.maxShareOfSessionPerSkill)
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(cap)
  })

  it('concentrates practice on the weakest skills', () => {
    // Everything is fluent except one skill, which is slow and error-prone.
    const weakId = 'mul_4x2'
    const attempts: Attempt[] = []
    for (const skill of practiceSkills) {
      const isWeak = skill.id === weakId
      for (let i = 0; i < 12; i++) {
        attempts.push(
          attempt(
            skill.id,
            isWeak ? i % 3 !== 0 : true,
            isWeak ? skill.targetSec * 4000 : skill.targetSec * 1000,
            NOW - 1000,
          ),
        )
      }
    }
    const stats = applyAttempts(new Map(), attempts, scoring)
    const picked = selectSkills(practiceSkills, 60, ctx(stats, 99))
    const weakCount = picked.filter((s) => s.id === weakId).length
    const averageCount = 60 / practiceSkills.length
    expect(weakCount).toBeGreaterThan(averageCount * 2)
  })

  it('does not run the same skill three times in a row', () => {
    const picked = selectSkills(practiceSkills, 60, ctx(new Map(), 5))
    let worstRun = 1
    let run = 1
    for (let i = 1; i < picked.length; i++) {
      run = (picked[i] as { id: string }).id === (picked[i - 1] as { id: string }).id ? run + 1 : 1
      worstRun = Math.max(worstRun, run)
    }
    expect(worstRun).toBeLessThanOrEqual(2)
  })
})
