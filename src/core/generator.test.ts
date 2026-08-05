import { describe, expect, it } from 'vitest'
import { skills } from '../curriculum'
import { createRng } from './rng'
import { generateProblem, problemSatisfiesSkill } from './generator'
import { countCarries, hasBorrowAcrossZero } from './arith'

const SAMPLES = 400

describe('generator', () => {
  for (const skill of skills) {
    it(`${skill.id} always satisfies its own feature contract`, () => {
      const rng = createRng(0xc0ffee)
      const failures: string[] = []
      for (let i = 0; i < SAMPLES; i++) {
        const p = generateProblem(skill, rng)
        if (!problemSatisfiesSkill(p, skill)) failures.push(p.prompt)
      }
      expect(failures.slice(0, 5)).toEqual([])
    })
  }

  it('produces varied problems rather than repeating one shape', () => {
    const rng = createRng(7)
    const skill = skills.find((s) => s.id === 'mul_3x2')
    expect(skill).toBeDefined()
    const prompts = new Set<string>()
    for (let i = 0; i < 200; i++) prompts.add(generateProblem(skill!, rng).prompt)
    expect(prompts.size).toBeGreaterThan(190)
  })

  it('is deterministic for a given seed', () => {
    const skill = skills.find((s) => s.id === 'div_4x2_rem')!
    const a = createRng(42)
    const b = createRng(42)
    for (let i = 0; i < 50; i++) {
      expect(generateProblem(skill, a).prompt).toBe(generateProblem(skill, b).prompt)
    }
  })
})

describe('arith predicates', () => {
  it('counts carries', () => {
    expect(countCarries(12, 13)).toBe(0)
    expect(countCarries(19, 13)).toBe(1)
    expect(countCarries(99, 99)).toBe(2)
  })

  it('detects borrow across zero', () => {
    expect(hasBorrowAcrossZero(4002, 1897)).toBe(true)
    // 4102 also qualifies: the units borrow propagates through the tens zero.
    expect(hasBorrowAcrossZero(4102, 1897)).toBe(true)
    // No zero is ever borrowed through here, despite borrows in every column.
    expect(hasBorrowAcrossZero(4152, 1897)).toBe(false)
    expect(hasBorrowAcrossZero(987, 123)).toBe(false)
  })
})
