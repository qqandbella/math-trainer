/**
 * Small seeded PRNG (mulberry32). Seeded so that worksheets are reproducible
 * and generator tests are deterministic.
 */
export interface Rng {
  next(): number
  /** Inclusive on both ends. */
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  bool(pTrue?: number): boolean
  shuffle<T>(items: T[]): T[]
}

export function createRng(seed: number = (Math.random() * 2 ** 32) >>> 0): Rng {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const int = (min: number, max: number): number => {
    if (max < min) throw new Error(`rng.int: empty range [${min}, ${max}]`)
    return min + Math.floor(next() * (max - min + 1))
  }

  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('rng.pick: empty array')
      return items[int(0, items.length - 1)] as T
    },
    bool(pTrue = 0.5): boolean {
      return next() < pTrue
    },
    shuffle<T>(items: T[]): T[] {
      const out = items.slice()
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i)
        const tmp = out[i] as T
        out[i] = out[j] as T
        out[j] = tmp
      }
      return out
    },
  }
}
