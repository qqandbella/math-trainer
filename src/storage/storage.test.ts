import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  erasePracticeData,
  loadAttempts,
  loadLearners,
  loadSessions,
  loadSettings,
  loadTombstones,
  resetConnectionForTests,
  saveAttempts,
  saveSession,
} from './db'
import { buildExport, mergeBundle, parseBundle } from './transfer'
import type { Attempt, SessionRecord } from '../core/types'

beforeEach(() => {
  // A brand-new IndexedDB per test; otherwise state leaks between them.
  globalThis.indexedDB = new IDBFactory()
  resetConnectionForTests()
})

const T0 = 1_800_000_000_000

function attempt(id: string, learnerId: string, at = T0): Attempt {
  return {
    id,
    learnerId,
    sessionId: 'sess-1',
    skillId: 'mul_3x2',
    prompt: '437 x 28',
    answer: 12236,
    given: 12236,
    correct: true,
    ms: 18000,
    at,
  }
}

function session(id: string, learnerId: string, startedAt = T0): SessionRecord {
  return {
    id,
    learnerId,
    mode: 'daily',
    startedAt,
    endedAt: startedAt + 60000,
    problemCount: 1,
    attemptedCount: 1,
    correctCount: 1,
    activeMs: 18000,
    pausesUsed: 0,
    completed: true,
  }
}

/** Recreates the v1 schema exactly as shipped, then seeds pre-migration rows. */
async function seedLegacyV1Database(): Promise<void> {
  const legacy = await openDB('math-trainer', 1, {
    upgrade(db) {
      const attempts = db.createObjectStore('attempts', { keyPath: 'id' })
      attempts.createIndex('by-at', 'at')
      attempts.createIndex('by-skill', 'skillId')
      attempts.createIndex('by-session', 'sessionId')
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' })
      sessions.createIndex('by-startedAt', 'startedAt')
      db.createObjectStore('settings', { keyPath: 'key' })
    },
  })
  // Deliberately without learnerId - that field did not exist in v1.
  await legacy.put('attempts', {
    id: 'legacy-1',
    sessionId: 's',
    skillId: 'mul_3x2',
    prompt: '12 x 12',
    answer: 144,
    given: 144,
    correct: true,
    ms: 4000,
    at: T0,
  })
  await legacy.put('attempts', {
    id: 'legacy-2',
    sessionId: 's',
    skillId: 'add_3x3',
    prompt: '111 + 222',
    answer: 333,
    given: 999,
    correct: false,
    ms: 3000,
    at: T0 + 1,
  })
  await legacy.put('sessions', {
    id: 's',
    mode: 'daily',
    startedAt: T0,
    endedAt: T0 + 1000,
    problemCount: 2,
    attemptedCount: 2,
    correctCount: 1,
    activeMs: 7000,
    pausesUsed: 0,
    completed: true,
  })
  await legacy.put('settings', { key: 'learnerName', value: 'Existing Name' })
  legacy.close()
}

describe('migration from v1', () => {
  it('adopts existing practice history into a default learner', async () => {
    await seedLegacyV1Database()

    const attempts = await loadAttempts()
    expect(attempts).toHaveLength(2)

    const learners = await loadLearners()
    expect(learners).toHaveLength(1)
    const learnerId = learners[0]?.id
    expect(learnerId).toBeTruthy()

    // The whole point: no record is orphaned by the schema change.
    for (const a of attempts) expect(a.learnerId).toBe(learnerId)
    for (const s of await loadSessions()) expect(s.learnerId).toBe(learnerId)

    expect(learners[0]?.name).toBe('Existing Name')
    const settings = await loadSettings()
    expect(settings.activeLearnerId).toBe(learnerId)
    expect(settings.deviceId).toBeTruthy()
  })

  it('preserves the contents of migrated records', async () => {
    await seedLegacyV1Database()
    const attempts = await loadAttempts()
    const wrong = attempts.find((a) => a.id === 'legacy-2')
    expect(wrong?.correct).toBe(false)
    expect(wrong?.given).toBe(999)
    expect(wrong?.answer).toBe(333)
  })

  it('is a no-op on a database that is already current', async () => {
    await seedLegacyV1Database()
    const first = await loadLearners()
    resetConnectionForTests()
    const second = await loadLearners()
    expect(second).toEqual(first)
    expect(await loadAttempts()).toHaveLength(2)
  })
})

describe('erase and import', () => {
  it('an erase is not undone by importing an older backup', async () => {
    const { activeLearnerId, deviceId } = await loadSettings()
    await saveAttempts([
      attempt('a1', activeLearnerId),
      attempt('a2', activeLearnerId),
      attempt('a3', activeLearnerId),
    ])
    await saveSession(session('sess-1', activeLearnerId))

    // Backup taken BEFORE the erase - the exact file that used to resurrect data.
    const backup = JSON.stringify(await buildExport('laptop'))

    await erasePracticeData(activeLearnerId, deviceId)
    expect(await loadAttempts()).toHaveLength(0)

    const report = await mergeBundle(parseBundle(backup, activeLearnerId))
    expect(await loadAttempts()).toHaveLength(0)
    expect(report.attemptsBlockedByErase).toBe(3)
    expect(report.attemptsAdded).toBe(0)
  })

  it('can restore erased data when explicitly asked', async () => {
    const { activeLearnerId, deviceId } = await loadSettings()
    await saveAttempts([attempt('a1', activeLearnerId), attempt('a2', activeLearnerId)])
    const backup = JSON.stringify(await buildExport('laptop'))
    await erasePracticeData(activeLearnerId, deviceId)

    const report = await mergeBundle(parseBundle(backup, activeLearnerId), {
      overrideErasures: true,
    })
    expect(report.attemptsAdded).toBe(2)
    expect(await loadAttempts()).toHaveLength(2)
  })

  it('once restored, the data stays restored', async () => {
    const { activeLearnerId, deviceId } = await loadSettings()
    await saveAttempts([attempt('a1', activeLearnerId)])
    const backup = JSON.stringify(await buildExport('laptop'))
    await erasePracticeData(activeLearnerId, deviceId)
    await mergeBundle(parseBundle(backup, activeLearnerId), { overrideErasures: true })

    // A second ordinary import must not re-apply the discarded tombstone.
    await mergeBundle(parseBundle(backup, activeLearnerId))
    expect(await loadAttempts()).toHaveLength(1)
  })

  it('propagates an erase performed on another device', async () => {
    // Device A erases; its export carries the tombstone to device B.
    const { activeLearnerId, deviceId } = await loadSettings()
    await saveAttempts([attempt('shared-1', activeLearnerId)])
    await erasePracticeData(activeLearnerId, deviceId)
    const fromDeviceA = JSON.stringify(await buildExport('deviceA'))

    // Device B: fresh storage that still holds the record.
    globalThis.indexedDB = new IDBFactory()
    resetConnectionForTests()
    const b = await loadSettings()
    await saveAttempts([attempt('shared-1', b.activeLearnerId, T0)])
    expect(await loadAttempts()).toHaveLength(1)

    const report = await mergeBundle(parseBundle(fromDeviceA, b.activeLearnerId))
    expect(await loadAttempts()).toHaveLength(0)
    expect(report.removedByImportedTombstones).toBe(1)
  })

  it('keeps work done after the erase', async () => {
    const { activeLearnerId, deviceId } = await loadSettings()
    await saveAttempts([attempt('old', activeLearnerId, T0)])
    await erasePracticeData(activeLearnerId, deviceId)

    // A new session, which no existing deletion names.
    const after = { ...attempt('new', activeLearnerId, Date.now() + 60_000), sessionId: 'sess-2' }
    await saveAttempts([after])
    const tombstones = await loadTombstones()
    expect(tombstones).toHaveLength(1)

    const bundle = parseBundle(JSON.stringify(await buildExport('x')), activeLearnerId)
    await mergeBundle(bundle)
    expect((await loadAttempts()).map((a) => a.id)).toEqual(['new'])
  })
})

describe('import compatibility', () => {
  it('reads a v1 export that predates learners and tombstones', async () => {
    const { activeLearnerId } = await loadSettings()
    const legacyBundle = JSON.stringify({
      app: 'math-trainer',
      formatVersion: 1,
      exportedAt: T0,
      deviceLabel: 'old-laptop',
      attempts: [
        {
          id: 'v1-a',
          sessionId: 's',
          skillId: 'mul_3x2',
          prompt: '1 x 1',
          answer: 1,
          given: 1,
          correct: true,
          ms: 1000,
          at: T0,
        },
      ],
      sessions: [],
      settings: { learnerName: 'x', targetOverrides: {}, pauseBudget: 3 },
    })

    const report = await mergeBundle(parseBundle(legacyBundle, activeLearnerId))
    expect(report.attemptsAdded).toBe(1)
    const stored = await loadAttempts()
    expect(stored[0]?.learnerId).toBe(activeLearnerId)
  })

  it('refuses a file from a newer app version rather than mangling it', async () => {
    const { activeLearnerId } = await loadSettings()
    const future = JSON.stringify({
      app: 'math-trainer',
      formatVersion: 99,
      exportedAt: T0,
      deviceLabel: 'x',
      attempts: [],
      sessions: [],
    })
    expect(() => parseBundle(future, activeLearnerId)).toThrow(/newer version/)
  })

  it('re-importing the same file changes nothing', async () => {
    const { activeLearnerId } = await loadSettings()
    await saveAttempts([attempt('a1', activeLearnerId)])
    const bundle = JSON.stringify(await buildExport('x'))
    const second = await mergeBundle(parseBundle(bundle, activeLearnerId))
    expect(second.attemptsAdded).toBe(0)
    expect(second.attemptsSkipped).toBe(1)
    expect(await loadAttempts()).toHaveLength(1)
  })
})

describe('switching sync account', () => {
  it('keeps cursors separate per account', async () => {
    const { getSyncCursor, setSyncCursor } = await import('./db')
    await setSyncCursor('accountA', 'L1', 5000)
    expect(await getSyncCursor('accountA', 'L1')).toBe(5000)
    // A position from A's timeline must not be applied to B, or B's older
    // records would be skipped entirely.
    expect(await getSyncCursor('accountB', 'L1')).toBe(0)
  })

  it('re-queues everything so a new account receives this device history', async () => {
    const { requeueEverything, outboxIds, clearOutbox } = await import('./db')
    const { activeLearnerId } = await loadSettings()
    await saveAttempts([attempt('a1', activeLearnerId), attempt('a2', activeLearnerId)])
    await saveSession(session('s1', activeLearnerId))

    // Simulate a completed push to the first account.
    await clearOutbox(await outboxIds(activeLearnerId))
    expect(await outboxIds(activeLearnerId)).toHaveLength(0)

    const queued = await requeueEverything(activeLearnerId)
    expect(queued).toBe(3)
    expect((await outboxIds(activeLearnerId)).sort()).toEqual(['a1', 'a2', 's1'])
  })
})

describe('working-out images', () => {
  it('stores and reads back a picture for an attempt', async () => {
    const { saveWorking, loadWorkings } = await import('./db')
    const { activeLearnerId } = await loadSettings()
    await saveWorking('a1', activeLearnerId, 'data:image/png;base64,AAA')
    await saveWorking('a2', activeLearnerId, 'data:image/png;base64,BBB')

    const found = await loadWorkings(['a1', 'a2', 'missing'])
    expect(found.get('a1')).toBe('data:image/png;base64,AAA')
    expect(found.get('a2')).toBe('data:image/png;base64,BBB')
    expect(found.has('missing')).toBe(false)
  })

  it('reports how much space the pictures take', async () => {
    const { saveWorking, workingsSize } = await import('./db')
    const { activeLearnerId } = await loadSettings()
    expect((await workingsSize()).count).toBe(0)
    await saveWorking('a1', activeLearnerId, 'x'.repeat(5000))
    const size = await workingsSize()
    expect(size.count).toBe(1)
    expect(size.bytes).toBeGreaterThanOrEqual(5000)
  })

  it('erasing practice data removes the pictures too', async () => {
    const { saveWorking, loadWorkings } = await import('./db')
    const { activeLearnerId, deviceId } = await loadSettings()
    await saveAttempts([attempt('a1', activeLearnerId)])
    await saveWorking('a1', activeLearnerId, 'data:image/png;base64,AAA')

    await erasePracticeData(activeLearnerId, deviceId)
    // Keeping a picture of working whose attempt no longer exists would be a
    // quiet leak of erased data.
    expect((await loadWorkings(['a1'])).size).toBe(0)
  })

  it('is not carried in an export, because it never leaves the device', async () => {
    const { saveWorking } = await import('./db')
    const { activeLearnerId } = await loadSettings()
    await saveAttempts([attempt('a1', activeLearnerId)])
    await saveWorking('a1', activeLearnerId, 'data:image/png;base64,AAA')
    const bundle = JSON.stringify(await buildExport('laptop'))
    expect(bundle).not.toContain('data:image/png')
  })
})

describe('deleting individual sessions', () => {
  it('removes only the chosen session and its attempts', async () => {
    const { deleteSessions } = await import('./db')
    const { activeLearnerId, deviceId } = await loadSettings()

    const mine = { ...session('parent-run', activeLearnerId), id: 'parent-run' }
    const hers = { ...session('her-run', activeLearnerId), id: 'her-run' }
    await saveSession(mine)
    await saveSession(hers)
    await saveAttempts([
      { ...attempt('m1', activeLearnerId), sessionId: 'parent-run' },
      { ...attempt('m2', activeLearnerId), sessionId: 'parent-run' },
      { ...attempt('h1', activeLearnerId), sessionId: 'her-run' },
    ])

    const removed = await deleteSessions(['parent-run'], activeLearnerId, deviceId)
    expect(removed.sessionsRemoved).toBe(1)
    expect(removed.attemptsRemoved).toBe(2)
    expect((await loadSessions()).map((s) => s.id)).toEqual(['her-run'])
    expect((await loadAttempts()).map((a) => a.id)).toEqual(['h1'])
  })

  it('a deleted session does not return from an older export', async () => {
    const { deleteSessions } = await import('./db')
    const { activeLearnerId, deviceId } = await loadSettings()
    await saveSession({ ...session('s1', activeLearnerId), id: 's1' })
    await saveAttempts([{ ...attempt('a1', activeLearnerId), sessionId: 's1' }])

    const backup = JSON.stringify(await buildExport('laptop'))
    await deleteSessions(['s1'], activeLearnerId, deviceId)

    const report = await mergeBundle(parseBundle(backup, activeLearnerId))
    expect(await loadSessions()).toHaveLength(0)
    expect(await loadAttempts()).toHaveLength(0)
    expect(report.attemptsBlockedByErase).toBe(1)
  })

  it('takes the working-out pictures with it', async () => {
    const { deleteSessions, saveWorking, loadWorkings } = await import('./db')
    const { activeLearnerId, deviceId } = await loadSettings()
    await saveSession({ ...session('s1', activeLearnerId), id: 's1' })
    await saveAttempts([{ ...attempt('a1', activeLearnerId), sessionId: 's1' }])
    await saveWorking('a1', activeLearnerId, 'data:image/png;base64,AAA')

    await deleteSessions(['s1'], activeLearnerId, deviceId)
    expect((await loadWorkings(['a1'])).size).toBe(0)
  })

  it('leaves other sessions untouched when several are deleted', async () => {
    const { deleteSessions } = await import('./db')
    const { activeLearnerId, deviceId } = await loadSettings()
    for (const id of ['a', 'b', 'c']) {
      await saveSession({ ...session(id, activeLearnerId), id })
      await saveAttempts([{ ...attempt(`${id}-1`, activeLearnerId), sessionId: id }])
    }
    await deleteSessions(['a', 'c'], activeLearnerId, deviceId)
    expect((await loadSessions()).map((s) => s.id)).toEqual(['b'])
    expect((await loadAttempts()).map((a) => a.id)).toEqual(['b-1'])
  })
})

