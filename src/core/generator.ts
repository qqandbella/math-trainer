import type { Problem, Skill } from './types'
import type { Rng } from './rng'
import {
  countBorrows,
  countCarries,
  digitCount,
  digits,
  fromDigits,
  hasBorrowAcrossZero,
} from './arith'

export const TIMES = '×'
export const DIVIDE = '÷'
export const MINUS = '−'

function randWithDigits(n: number, rng: Rng, minLeading = 1): number {
  if (n === 1) return rng.int(minLeading, 9)
  const ds: number[] = []
  for (let i = 0; i < n - 1; i++) ds.push(rng.int(0, 9))
  ds.push(rng.int(minLeading, 9))
  return fromDigits(ds)
}

/**
 * Multipliers avoid 0 digits: a zero in the multiplier collapses a whole
 * partial-product row and makes an "n x m digit" problem quietly easier than
 * its label claims. Trailing zeros get their own skill instead.
 */
function randMultiplier(n: number, rng: Rng): number {
  if (n === 1) return rng.int(2, 9)
  const ds: number[] = []
  for (let i = 0; i < n - 1; i++) ds.push(rng.int(1, 9))
  ds.push(rng.int(2, 9))
  return fromDigits(ds)
}

function genAddOperands(skill: Skill, rng: Rng): number[] {
  const nA = skill.digitsA
  const nB = skill.digitsB
  const wantCarry = !skill.features.includes('no_carry')

  if (skill.features.includes('three_terms')) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const ops = [
        randWithDigits(nA, rng),
        randWithDigits(nB, rng),
        randWithDigits(nB, rng),
      ]
      if (countCarries(...ops) > 0 === wantCarry) return ops
    }
    const [a, b] = forceUnitsCarry(randWithDigits(nA, rng), randWithDigits(nB, rng), rng) as [
      number,
      number,
    ]
    return [a, b, randWithDigits(nB, rng)]
  }

  if (!wantCarry) return genAddNoCarry(nA, nB, rng)

  for (let attempt = 0; attempt < 200; attempt++) {
    const a = randWithDigits(nA, rng)
    const b = randWithDigits(nB, rng)
    if (countCarries(a, b) > 0) return [a, b]
  }
  return forceUnitsCarry(randWithDigits(nA, rng), randWithDigits(nB, rng), rng)
}

function genAddNoCarry(nA: number, nB: number, rng: Rng): number[] {
  const nWide = Math.max(nA, nB)
  const nNarrow = Math.min(nA, nB)
  const aD: number[] = []
  for (let i = 0; i < nWide; i++) {
    aD.push(i === nWide - 1 ? rng.int(1, 9) : rng.int(0, 9))
  }
  // Leave headroom in every column the narrow operand occupies.
  for (let i = 0; i < nNarrow; i++) {
    const maxA = i === nNarrow - 1 ? 8 : 9
    if ((aD[i] as number) > maxA) {
      aD[i] = i === nWide - 1 ? rng.int(1, maxA) : rng.int(0, maxA)
    }
  }
  const bD: number[] = []
  for (let i = 0; i < nNarrow; i++) {
    const lo = i === nNarrow - 1 ? 1 : 0
    bD.push(rng.int(lo, 9 - (aD[i] as number)))
  }
  const wide = fromDigits(aD)
  const narrow = fromDigits(bD)
  return nA >= nB ? [wide, narrow] : [narrow, wide]
}

function forceUnitsCarry(a: number, b: number, rng: Rng): number[] {
  const aD = digits(a)
  const bD = digits(b)
  const au = rng.int(1, 9)
  aD[0] = au
  bD[0] = rng.int(10 - au, 9)
  return [fromDigits(aD), fromDigits(bD)]
}

function genSubOperands(skill: Skill, rng: Rng): number[] {
  const nA = skill.digitsA
  const nB = skill.digitsB
  const sameWidth = nA === nB

  // Construct so that a > b by fixing the leading digits first.
  const aD: number[] = []
  for (let i = 0; i < nA; i++) {
    aD.push(i === nA - 1 ? rng.int(sameWidth ? 2 : 1, 9) : rng.int(0, 9))
  }
  const bD: number[] = []
  for (let i = 0; i < nB; i++) {
    if (i === nB - 1) {
      bD.push(sameWidth ? rng.int(1, (aD[nA - 1] as number) - 1) : rng.int(1, 9))
    } else {
      bD.push(rng.int(0, 9))
    }
  }

  if (skill.features.includes('borrow_zero')) {
    // Put a 0 in an interior column of a, and force the column below it to
    // borrow, so the borrow has to propagate through the zero.
    const p = rng.int(1, Math.min(nA - 2, nB))
    aD[p] = 0
    aD[p - 1] = rng.int(0, 8)
    bD[p - 1] = rng.int((aD[p - 1] as number) + 1, 9)
  } else if (skill.features.includes('borrow')) {
    if (countBorrows(fromDigits(aD), fromDigits(bD)) === 0) {
      aD[0] = rng.int(0, 8)
      bD[0] = rng.int((aD[0] as number) + 1, 9)
    }
  } else {
    for (let i = 0; i < nB; i++) {
      if ((bD[i] as number) > (aD[i] as number)) {
        bD[i] = rng.int(i === nB - 1 ? 1 : 0, aD[i] as number)
      }
    }
  }

  return [fromDigits(aD), fromDigits(bD)]
}

function genMulOperands(skill: Skill, rng: Rng): number[] {
  // Single-digit multiplication skips 0 and 1 on both sides: "1 x 7" is not
  // times-table practice.
  const a = skill.digitsA === 1 ? rng.int(2, 9) : randWithDigits(skill.digitsA, rng)
  let b: number
  if (skill.fixedB !== undefined) {
    b = skill.fixedB
  } else if (skill.features.includes('trailing_zeros')) {
    b = randWithDigits(skill.digitsB - 1, rng) * 10
  } else {
    b = randMultiplier(skill.digitsB, rng)
  }
  return [a, b]
}

interface DivParts {
  dividend: number
  divisor: number
  quotient: number
  remainder: number
}

function genDiv(skill: Skill, rng: Rng): DivParts {
  const nA = skill.digitsA
  const nB = skill.digitsB
  const divisor = nB === 1 ? rng.int(2, 9) : randWithDigits(nB, rng)
  const lo = 10 ** (nA - 1)
  const hi = 10 ** nA - 1
  const remainder = skill.features.includes('remainder') ? rng.int(1, divisor - 1) : 0

  const qLo = Math.max(2, Math.ceil((lo - remainder) / divisor))
  const qHi = Math.floor((hi - remainder) / divisor)
  if (qHi < qLo) {
    throw new Error(
      `skill "${skill.id}": no ${nA}-digit dividend exists for divisor ${divisor}`,
    )
  }
  const quotient = rng.int(qLo, qHi)
  return { dividend: divisor * quotient + remainder, divisor, quotient, remainder }
}

interface MixedShape {
  prompt: string
  operands: number[]
  answer: number
}

function genMixed(skill: Skill, rng: Rng): MixedShape {
  const n = skill.digitsA
  const big = (): number => randWithDigits(n, rng)
  const small = (): number => rng.int(2, 9)

  if (skill.features.includes('parens')) {
    const a = big()
    const b = big()
    const c = small()
    if (rng.bool()) {
      return { prompt: `(${a} + ${b}) ${TIMES} ${c}`, operands: [a, b, c], answer: (a + b) * c }
    }
    const [hi, loOperand] = a >= b ? [a, b] : [b, a]
    return {
      prompt: `(${hi} ${MINUS} ${loOperand}) ${TIMES} ${c}`,
      operands: [hi, loOperand, c],
      answer: (hi - loOperand) * c,
    }
  }

  if (skill.features.includes('three_terms')) {
    const a = big()
    const b = small()
    const c = big()
    const d = small()
    return {
      prompt: `${a} ${TIMES} ${b} + ${c} ${TIMES} ${d}`,
      operands: [a, b, c, d],
      answer: a * b + c * d,
    }
  }

  const a = big()
  const c = small()
  if (rng.bool()) {
    const b = big()
    return { prompt: `${a} + ${b} ${TIMES} ${c}`, operands: [a, b, c], answer: a + b * c }
  }
  // a x c - b. Draw b only after the product is known, so the result is
  // always positive without rejection-sampling.
  const product = a * c
  const b = rng.int(10 ** (n - 1), Math.min(product - 1, 10 ** n - 1))
  return {
    prompt: `${a} ${TIMES} ${c} ${MINUS} ${b}`,
    operands: [a, c, b],
    answer: product - b,
  }
}

let problemCounter = 0

export function generateProblem(skill: Skill, rng: Rng): Problem {
  const id = `p${(problemCounter++).toString(36)}_${rng.int(0, 0xffffff).toString(36)}`

  switch (skill.op) {
    case 'add': {
      const operands = genAddOperands(skill, rng)
      return {
        id,
        skillId: skill.id,
        op: 'add',
        prompt: operands.join(' + '),
        operands,
        answer: operands.reduce((sum, x) => sum + x, 0),
      }
    }
    case 'sub': {
      const [a, b] = genSubOperands(skill, rng) as [number, number]
      return {
        id,
        skillId: skill.id,
        op: 'sub',
        prompt: `${a} ${MINUS} ${b}`,
        operands: [a, b],
        answer: a - b,
      }
    }
    case 'mul': {
      const [a, b] = genMulOperands(skill, rng) as [number, number]
      return {
        id,
        skillId: skill.id,
        op: 'mul',
        prompt: `${a} ${TIMES} ${b}`,
        operands: [a, b],
        answer: a * b,
      }
    }
    case 'div': {
      const { dividend, divisor, quotient, remainder } = genDiv(skill, rng)
      const problem: Problem = {
        id,
        skillId: skill.id,
        op: 'div',
        prompt: `${dividend} ${DIVIDE} ${divisor}`,
        operands: [dividend, divisor],
        answer: quotient,
      }
      if (skill.features.includes('remainder')) problem.remainder = remainder
      return problem
    }
    case 'mixed': {
      const shape = genMixed(skill, rng)
      return {
        id,
        skillId: skill.id,
        op: 'mixed',
        prompt: shape.prompt,
        operands: shape.operands,
        answer: shape.answer,
      }
    }
  }
}

/**
 * Generates one problem per entry in skillOrder, avoiding repeated prompts
 * within the batch (a session that asks 47 + 28 twice looks broken).
 */
export function generateBatch(skillOrder: readonly Skill[], rng: Rng): Problem[] {
  const seen = new Set<string>()
  const out: Problem[] = []
  for (const skill of skillOrder) {
    let problem = generateProblem(skill, rng)
    for (let attempt = 0; attempt < 12 && seen.has(problem.prompt); attempt++) {
      problem = generateProblem(skill, rng)
    }
    seen.add(problem.prompt)
    out.push(problem)
  }
  return out
}

/**
 * Exposed for tests: asserts a problem really exercises its skill's features
 * AND that its operands have the digit widths the skill's label promises.
 * A "4-digit x 2-digit" skill that sometimes emits 3-digit operands would
 * silently corrupt every per-skill timing comparison.
 */
export function problemSatisfiesSkill(problem: Problem, skill: Skill): boolean {
  const f = skill.features
  if (problem.skillId !== skill.id) return false

  switch (skill.op) {
    case 'add': {
      const carries = countCarries(...problem.operands)
      if (f.includes('carry') && carries === 0) return false
      if (f.includes('no_carry') && carries > 0) return false
      if (f.includes('three_terms')) {
        if (problem.operands.length !== 3) return false
      } else if (problem.operands.length !== 2) {
        return false
      }
      if (digitCount(problem.operands[0] as number) !== skill.digitsA) return false
      if (digitCount(problem.operands[1] as number) !== skill.digitsB) return false
      return problem.operands.reduce((s, x) => s + x, 0) === problem.answer
    }
    case 'sub': {
      const [a, b] = problem.operands as [number, number]
      if (a <= b) return false
      if (digitCount(a) !== skill.digitsA || digitCount(b) !== skill.digitsB) return false
      if (f.includes('borrow') && countBorrows(a, b) === 0) return false
      if (f.includes('borrow_zero') && !hasBorrowAcrossZero(a, b)) return false
      return a - b === problem.answer
    }
    case 'mul': {
      const [a, b] = problem.operands as [number, number]
      if (digitCount(a) !== skill.digitsA) return false
      if (skill.fixedB !== undefined) {
        if (b !== skill.fixedB) return false
      } else {
        if (digitCount(b) !== skill.digitsB) return false
        if (f.includes('trailing_zeros')) {
          if (b % 10 !== 0) return false
        } else if (digits(b).some((d) => d === 0)) {
          return false
        }
      }
      return a * b === problem.answer
    }
    case 'div': {
      const [dividend, divisor] = problem.operands as [number, number]
      const r = problem.remainder ?? 0
      if (digitCount(dividend) !== skill.digitsA) return false
      if (digitCount(divisor) !== skill.digitsB) return false
      if (f.includes('exact') && r !== 0) return false
      if (f.includes('remainder') && (r < 1 || r >= divisor)) return false
      return divisor * problem.answer + r === dividend
    }
    case 'mixed':
      return problem.answer >= 0 && problem.operands.length >= 3
  }
}
