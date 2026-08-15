import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'
import { loadAttempts, loadTombstones, resetConnectionForTests, saveAttempts } from './db'
import type { Attempt } from '../core/types'

/**
 * The upgrade that changes what a deletion means.
 *
 * Deletions used to be stored either as a list of record ids or as a time
 * window. A window deletes whatever falls inside it - including practice from
 * other devices that the person deleting had never seen - so once history
 * merged into one shared pool, an old window would erase the household's
 * earlier history. This runs against a real (fake-backed) IndexedDB upgrade,
 * because that is where the user's actual data goes through.
 */

const L = 'learner-1'

function attempt(id: string, sessionId: string, at: number): Attempt {
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

/** Builds the schema as version 4 left it, with deletions in the old shapes. */
async function seedVersion4(tombstones: unknown[]): Promise<void> {
  const db = await openDB('math-trainer', 4, {
    upgrade(database) {
      const attempts = database.createObjectStore('attempts', { keyPath: 'id' })
      attempts.createIndex('by-learner', 'learnerId')
      attempts.createIndex('by-at', 'at')
      database.createObjectStore('sessions', { keyPath: 'id' }).createIndex(
        'by-learner',
        'learnerId',
      )
      database.createObjectStore('settings', { keyPath: 'key' })
      database.createObjectStore('learners', { keyPath: 'id' })
      database.createObjectStore('tombstones', { keyPath: 'id' }).createIndex(
        'by-learner',
        'learnerId',
      )
      database.createObjectStore('outbox', { keyPath: 'id' })
      database.createObjectStore('syncState', { keyPath: 'key' })
      database.createObjectStore('workings', { keyPath: 'attemptId' }).createIndex(
        'by-learner',
        'learnerId',
      )
    },
  })
  const tx = db.transaction('tombstones', 'readwrite')
  for (const tombstone of tombstones) await tx.store.put(tombstone)
  await tx.done
  db.close()
}

describe('upgrading deletions to session scope', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetConnectionForTests()
  })

  it('discards a time-window deletion', async () => {
    await seedVersion4([
      { id: 't1', kind: 'purge', before: 9_000_000, learnerId: L, at: 9_000_000, deviceId: 'd' },
    ])
    expect(await loadTombstones()).toHaveLength(0)
  })

  it('stops that window from erasing history it never covered', async () => {
    await seedVersion4([
      { id: 't1', kind: 'purge', before: 9_000_000, learnerId: L, at: 9_000_000, deviceId: 'd' },
    ])
    // Practice from another device, older than the window, arriving after the
    // upgrade. Under the old rule every one of these disappeared.
    await saveAttempts([attempt('from-phone', 'sess-phone', 1000)])
    expect((await loadAttempts()).map((a) => a.id)).toEqual(['from-phone'])
  })

  it('keeps a deletion that named its records', async () => {
    await seedVersion4([
      {
        id: 't2',
        kind: 'record',
        targetIds: ['sess-mine', 'att-1'],
        learnerId: L,
        at: 5000,
        deviceId: 'd',
      },
    ])
    const kept = await loadTombstones()
    expect(kept).toHaveLength(1)
    expect(kept[0]?.sessionIds).toEqual(['sess-mine', 'att-1'])

    // Still deletes exactly what it did before, and nothing else.
    await saveAttempts([attempt('a', 'sess-mine', 1), attempt('b', 'sess-other', 2)])
    const { survivingAttempts } = await import('../core/tombstones')
    expect(survivingAttempts(await loadAttempts(), kept).map((a) => a.id)).toEqual(['b'])
  })

  it('handles a database holding both shapes at once', async () => {
    await seedVersion4([
      { id: 'p', kind: 'purge', before: 9_000_000, learnerId: L, at: 9_000_000, deviceId: 'd' },
      { id: 'r', kind: 'record', targetIds: ['s1'], learnerId: L, at: 100, deviceId: 'd' },
    ])
    const kept = await loadTombstones()
    expect(kept.map((t) => t.id)).toEqual(['r'])
  })
})
