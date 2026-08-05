/** Column-arithmetic predicates. These define what a skill's feature flags mean. */

/** Digits units-first: 1024 -> [4, 2, 0, 1] */
export function digits(n: number): number[] {
  if (n === 0) return [0]
  const out: number[] = []
  let x = Math.abs(n)
  while (x > 0) {
    out.push(x % 10)
    x = Math.floor(x / 10)
  }
  return out
}

export function fromDigits(ds: readonly number[]): number {
  let n = 0
  for (let i = ds.length - 1; i >= 0; i--) n = n * 10 + (ds[i] as number)
  return n
}

export function digitCount(n: number): number {
  return digits(n).length
}

/** Number of columns that generate a carry when adding the operands. */
export function countCarries(...operands: number[]): number {
  const ds = operands.map(digits)
  const width = Math.max(...ds.map((d) => d.length))
  let carry = 0
  let count = 0
  for (let i = 0; i < width || carry > 0; i++) {
    let sum = carry
    for (const d of ds) sum += d[i] ?? 0
    if (sum >= 10) {
      count++
      carry = 1
    } else {
      carry = 0
    }
    if (i >= width && carry === 0) break
  }
  return count
}

/** Number of columns that require a borrow in a - b. */
export function countBorrows(a: number, b: number): number {
  const da = digits(a)
  const db = digits(b)
  let borrow = 0
  let count = 0
  for (let i = 0; i < da.length; i++) {
    const top = (da[i] as number) - borrow
    const bottom = db[i] ?? 0
    if (top < bottom) {
      count++
      borrow = 1
    } else {
      borrow = 0
    }
  }
  return count
}

/**
 * True when subtracting b from a forces a borrow to propagate through a zero
 * digit of a - the classic 4002 - 1897 shape that trips kids up.
 */
export function hasBorrowAcrossZero(a: number, b: number): boolean {
  const da = digits(a)
  const db = digits(b)
  let borrow = 0
  for (let i = 0; i < da.length; i++) {
    const digitA = da[i] as number
    if (borrow === 1 && digitA === 0) return true
    const top = digitA - borrow
    const bottom = db[i] ?? 0
    borrow = top < bottom ? 1 : 0
  }
  return false
}
