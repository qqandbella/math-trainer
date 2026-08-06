import { describe, expect, it } from 'vitest'
import {
  compactTombstones,
  isDeleted,
  makePurge,
  makeRecordTombstone,
  survivingAttempts,
  survivingSessions,
} from './tombstones'
import type { Attempt, SessionRecord, Tombstone } from './types'

const L1 = 'learner-1'
const L2 = 'learner-2'
const DEV = 'device-a'

function attempt(id: string, at: number, learnerId = L1): Attempt {
  return {
    id,
    learnerId,
    sessionId: 's',
    skillId: 'mul_3x2',
    prompt: '1',
    answer: 1,
    given: 1,
    correct: true,
    ms: 1000,
    at,
  }
}

function session(id: string, startedAt: number, learnerId = L1): SessionRecord {
  return {
    id,
    learnerId,
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

describe('tombstones', () => {
  it('a purge removes everything recorded up to its boundary', () => {
    const purge = makePurge(L1, DEV, 1000)
    const kept = survivingAttempts(
      [attempt('a', 500), attempt('b', 1000), attempt('c', 1500)],
      [purge],
    )
    expect(kept.map((a) => a.id)).toEqual(['c'])
  })

  it('work done after a purge survives it', () => {
    const purge = makePurge(L1, DEV, 1000)
    expect(survivingAttempts([attempt('later', 2000)], [purge])).toHaveLength(1)
  })

  it('is anchored past existing records, so a fast clock cannot strand data', () => {
    // Device clock says 1000, but a record already exists stamped 5000.
    const purge = makePurge(L1, DEV, 1000, 5000)
    expect(purge.kind === 'purge' && purge.before).toBe(5000)
    expect(survivingAttempts([attempt('ahead', 4000)], [purge])).toHaveLength(0)
  })

  it('does not touch another learner', () => {
    const purge = makePurge(L1, DEV, 10_000)
    const kept = survivingAttempts([attempt('mine', 500), attempt('theirs', 500, L2)], [purge])
    expect(kept.map((a) => a.id)).toEqual(['theirs'])
  })

  it('removes individually targeted records', () => {
    const t = makeRecordTombstone(L1, DEV, ['b'], 9999)
    const kept = survivingAttempts([attempt('a', 1), attempt('b', 2)], [t])
    expect(kept.map((a) => a.id)).toEqual(['a'])
  })

  it('judges sessions by when they started', () => {
    const purge = makePurge(L1, DEV, 1000)
    const kept = survivingSessions([session('s1', 500), session('s2', 1500)], [purge])
    expect(kept.map((s) => s.id)).toEqual(['s2'])
  })

  it('is idempotent: applying the same purge twice changes nothing', () => {
    const purge = makePurge(L1, DEV, 1000)
    const once = survivingAttempts([attempt('a', 500), attempt('c', 1500)], [purge])
    const twice = survivingAttempts(once, [purge])
    expect(twice).toEqual(once)
  })

  it('is order-independent: tombstones commute', () => {
    const p = makePurge(L1, DEV, 1000)
    const r = makeRecordTombstone(L1, DEV, ['late'], 2000)
    const records = [attempt('early', 500), attempt('late', 1500), attempt('kept', 1600)]
    expect(survivingAttempts(records, [p, r])).toEqual(survivingAttempts(records, [r, p]))
  })

  it('reports coverage for a single record', () => {
    const purge = makePurge(L1, DEV, 1000)
    expect(isDeleted(attempt('x', 999), [purge])).toBe(true)
    expect(isDeleted(attempt('x', 1001), [purge])).toBe(false)
    expect(isDeleted(attempt('x', 999), [])).toBe(false)
  })
})

describe('compaction', () => {
  it('keeps only the newest purge per learner', () => {
    const list: Tombstone[] = [
      makePurge(L1, DEV, 1000),
      makePurge(L1, DEV, 5000),
      makePurge(L2, DEV, 2000),
    ]
    const compacted = compactTombstones(list)
    expect(compacted).toHaveLength(2)
    const forL1 = compacted.find((t) => t.learnerId === L1)
    expect(forL1?.kind === 'purge' && forL1.before).toBe(5000)
  })

  it('drops record tombstones a later purge already covers', () => {
    const list: Tombstone[] = [
      makeRecordTombstone(L1, DEV, ['a'], 1000),
      makePurge(L1, DEV, 5000),
      makeRecordTombstone(L1, DEV, ['b'], 9000),
    ]
    const compacted = compactTombstones(list)
    expect(compacted).toHaveLength(2)
    expect(compacted.some((t) => t.kind === 'record' && t.targetIds.includes('b'))).toBe(true)
    expect(compacted.some((t) => t.kind === 'record' && t.targetIds.includes('a'))).toBe(false)
  })

  it('does not change what survives', () => {
    const list: Tombstone[] = [
      makeRecordTombstone(L1, DEV, ['a'], 1000),
      makePurge(L1, DEV, 5000),
      makeRecordTombstone(L1, DEV, ['keep-me'], 9000),
    ]
    const records = [
      attempt('a', 100),
      attempt('b', 6000),
      attempt('keep-me', 7000),
      attempt('c', 8000),
    ]
    expect(survivingAttempts(records, compactTombstones(list))).toEqual(
      survivingAttempts(records, list),
    )
  })
})
