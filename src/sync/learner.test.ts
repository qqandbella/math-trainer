import { describe, expect, it } from 'vitest'
import type { Learner } from '../core/types'
import { canonicalLearner } from './learner'

function learner(id: string, createdAt: number): Learner {
  return { id, name: 'Y', createdAt }
}

describe('agreeing on one learner across devices', () => {
  it('has nothing to choose from an empty account', () => {
    expect(canonicalLearner([])).toBeNull()
  })

  it('keeps the oldest learner, which is the one likely to hold history', () => {
    const chosen = canonicalLearner([learner('b', 200), learner('a', 100), learner('c', 300)])
    expect(chosen?.id).toBe('a')
  })

  it('reaches the same answer whatever order a device sees them in', () => {
    const all = [learner('b', 200), learner('a', 100), learner('c', 300)]
    // Devices list Firestore documents independently; the order is not
    // guaranteed, and a rule that depended on it would let two devices adopt
    // different ids and stay invisible to each other.
    const answers = new Set(
      [
        [0, 1, 2],
        [2, 1, 0],
        [1, 0, 2],
        [2, 0, 1],
      ].map((order) => canonicalLearner(order.map((i) => all[i] as Learner))?.id),
    )
    expect([...answers]).toEqual(['a'])
  })

  it('breaks a same-millisecond tie by id rather than arbitrarily', () => {
    expect(canonicalLearner([learner('z', 100), learner('a', 100)])?.id).toBe('a')
    expect(canonicalLearner([learner('a', 100), learner('z', 100)])?.id).toBe('a')
  })

  it('treats a learner document with no timestamp as the oldest', () => {
    // A document written by an older build carries no createdAt, and it is the
    // one with history - so it must not lose to a freshly minted id.
    expect(canonicalLearner([learner('new', 5_000), learner('old', 0)])?.id).toBe('old')
  })
})
