import { describe, expect, it } from 'vitest'
import {
  attemptIsDeleted,
  compactTombstones,
  deletedSessionIds,
  makeTombstones,
  sessionIsDeleted,
  survivingAttempts,
  survivingSessions,
} from './tombstones'
import type { Attempt, SessionRecord, Tombstone } from './types'

const L1 = 'learner-1'
const DEV = 'device-a'

function attempt(id: string, sessionId: string, at = 1000): Attempt {
  return {
    id,
    learnerId: L1,
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

function session(id: string, startedAt = 1000): SessionRecord {
  return {
    id,
    learnerId: L1,
    mode: 'daily',
    startedAt,
    endedAt: startedAt + 1000,
    problemCount: 1,
    attemptedCount: 1,
    correctCount: 1,
    activeMs: 1000,
    pausesUsed: 0,
    completed: true,
  }
}

describe('deleting a session', () => {
  it('removes the session and everything recorded in it', () => {
    const [t] = makeTombstones(['s1'], L1, DEV, 5000)
    const attempts = [attempt('a', 's1'), attempt('b', 's1'), attempt('c', 's2')]
    expect(survivingAttempts(attempts, [t as Tombstone]).map((a) => a.id)).toEqual(['c'])
    expect(survivingSessions([session('s1'), session('s2')], [t as Tombstone])).toHaveLength(1)
  })

  it('makes one tombstone per session, so a deletion merges piece by piece', () => {
    const stones = makeTombstones(['s1', 's2', 's3'], L1, DEV, 5000)
    expect(stones).toHaveLength(3)
    expect(stones.map((t) => t.sessionIds)).toEqual([['s1'], ['s2'], ['s3']])
  })

  it('covers attempts from that session which this device has never seen', () => {
    // This is the property a time window is reached for, and the reason it is
    // not needed: a session names its own contents, whenever they arrive.
    const [t] = makeTombstones(['s1'], L1, DEV, 1000)
    const arrivingLater = attempt('from-another-device', 's1', 9_999_999)
    expect(attemptIsDeleted(arrivingLater, [t as Tombstone])).toBe(true)
  })

  it('never touches practice from a session it does not name', () => {
    // The failure a time window caused: a reset on one device deleted history
    // from every other device that happened to be older.
    const [t] = makeTombstones(['mine'], L1, DEV, 9_000_000)
    const somebodyElses = attempt('older', 'hers', 1)
    expect(attemptIsDeleted(somebodyElses, [t as Tombstone])).toBe(false)
    expect(sessionIsDeleted(session('hers', 1), [t as Tombstone])).toBe(false)
  })

  it('is idempotent, and order-independent', () => {
    const a = makeTombstones(['s1'], L1, DEV, 1000)[0] as Tombstone
    const b = makeTombstones(['s2'], L1, DEV, 2000)[0] as Tombstone
    const records = [attempt('x', 's1'), attempt('y', 's2'), attempt('z', 's3')]
    const once = survivingAttempts(records, [a, b])
    expect(survivingAttempts(once, [a, b])).toEqual(once)
    expect(survivingAttempts(records, [b, a])).toEqual(once)
  })

  it('reports the full set of deleted sessions', () => {
    const stones = makeTombstones(['s1', 's2'], L1, DEV, 1000)
    expect([...deletedSessionIds(stones)].sort()).toEqual(['s1', 's2'])
    expect(deletedSessionIds([]).size).toBe(0)
  })
})

describe('resetting everything', () => {
  it('is a tombstone per stored session, not a rule about time', () => {
    const stored = ['s1', 's2', 's3']
    const stones = makeTombstones(stored, L1, DEV, 5000)
    const records = stored.map((id, i) => attempt(`a${i}`, id))
    expect(survivingAttempts(records, stones)).toEqual([])
  })

  it('leaves a session that arrives afterwards from an offline device', () => {
    // A reset clears the history that exists. Practice done elsewhere before
    // the reset, but synced after it, is not swallowed - which is exactly what
    // "everything before now" got wrong.
    const stones = makeTombstones(['s1'], L1, DEV, 5000)
    const late = attempt('late', 's-offline', 10)
    expect(survivingAttempts([late], stones)).toHaveLength(1)
  })
})

describe('compaction', () => {
  it('drops tombstones that name nothing new', () => {
    const list = [
      ...makeTombstones(['s1'], L1, DEV, 1000),
      ...makeTombstones(['s1'], L1, DEV, 2000),
      ...makeTombstones(['s2'], L1, DEV, 3000),
    ]
    expect(compactTombstones(list)).toHaveLength(2)
  })

  it('does not change what survives', () => {
    const list = [
      ...makeTombstones(['s1'], L1, DEV, 1000),
      ...makeTombstones(['s1'], L1, DEV, 2000),
      ...makeTombstones(['s2'], L1, DEV, 3000),
    ]
    const records = [attempt('a', 's1'), attempt('b', 's2'), attempt('c', 's3')]
    expect(survivingAttempts(records, compactTombstones(list))).toEqual(
      survivingAttempts(records, list),
    )
  })
})
