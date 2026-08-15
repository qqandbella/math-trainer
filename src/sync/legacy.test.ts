import { describe, expect, it } from 'vitest'
import { convertLegacyTombstone } from './legacy'
import { survivingAttempts } from '../core/tombstones'
import type { Attempt } from '../core/types'

const L = 'learner-here'

function attempt(id: string, sessionId: string, at = 1000): Attempt {
  return {
    id,
    learnerId: L,
    sessionId,
    skillId: 'mul_3x2',
    prompt: '1',
    answer: 1,
    given: 1,
    correct: true,
    ms: 1000,
    at,
  }
}

describe('carrying old deletions across', () => {
  it('drops a time-window deletion rather than translating it', () => {
    // A window deletes whatever falls inside it, including practice from
    // devices the person deleting had never seen. Carried into a shared pool it
    // erases the household's earlier history - which is what it did.
    const converted = convertLegacyTombstone(
      { id: 't1', kind: 'purge', learnerId: 'old', at: 5000, deviceId: 'd' },
      L,
    )
    expect(converted).toBeNull()
  })

  it('keeps a deletion that named its records, unchanged in effect', () => {
    const converted = convertLegacyTombstone(
      {
        id: 't2',
        kind: 'record',
        targetIds: ['sess-1', 'att-a', 'att-b'],
        learnerId: 'old',
        at: 5000,
        deviceId: 'd',
      },
      L,
    )
    expect(converted).not.toBeNull()
    // The old list held a session id alongside its attempt ids. Carrying all of
    // them across is exact: an attempt id can never match a session id.
    const records = [attempt('att-a', 'sess-1'), attempt('other', 'sess-2')]
    expect(survivingAttempts(records, [converted!]).map((a) => a.id)).toEqual(['other'])
  })

  it('keeps the tombstone id, so the same deletion is not stored twice', () => {
    const converted = convertLegacyTombstone(
      { id: 'stable-id', targetIds: ['s1'], learnerId: 'old', at: 1, deviceId: 'd' },
      L,
    )
    expect(converted?.id).toBe('stable-id')
  })

  it('re-stamps the learner so local queries reach it', () => {
    const converted = convertLegacyTombstone(
      { id: 't3', targetIds: ['s1'], learnerId: 'some-other-device', at: 1, deviceId: 'd' },
      L,
    )
    expect(converted?.learnerId).toBe(L)
  })

  it('ignores a deletion that names nothing', () => {
    expect(
      convertLegacyTombstone({ id: 't4', targetIds: [], learnerId: 'x', at: 1, deviceId: 'd' }, L),
    ).toBeNull()
  })
})
