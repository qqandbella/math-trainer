import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Attempt, Learner, SessionRecord, Tombstone } from '../core/types'

export interface Settings {
  learnerName: string
  pauseBudget: number
  revealAnswersDuringSession: boolean
  /**
   * Lowest skill tier used for written practice. A learner already fluent in
   * single-digit tables gains nothing from drilling them, and those reps would
   * dilute the per-skill measurements.
   */
  minTier: number
  /** Parent-calibrated reference times, skillId -> seconds. Overrides curriculum. */
  targetOverrides: Record<string, number>
  /** Base32 TOTP secret for the parent gate. Generated on-device, never shipped. */
  parentTotpSecret: string | null
  /** Stable per-install id. Records which device wrote a tombstone. */
  deviceId: string
  /** Which learner new practice is recorded against. */
  activeLearnerId: string
  createdAt: number
}

export const DEFAULT_SETTINGS: Settings = {
  learnerName: '',
  pauseBudget: 3,
  revealAnswersDuringSession: false,
  minTier: 2,
  targetOverrides: {},
  parentTotpSecret: null,
  deviceId: '',
  activeLearnerId: '',
  createdAt: 0,
}

interface TrainerDB extends DBSchema {
  attempts: {
    key: string
    value: Attempt
    indexes: {
      'by-at': number
      'by-skill': string
      'by-session': string
      'by-learner': string
    }
  }
  sessions: {
    key: string
    value: SessionRecord
    indexes: { 'by-startedAt': number; 'by-learner': string }
  }
  settings: {
    key: string
    value: { key: string; value: unknown }
  }
  learners: {
    key: string
    value: Learner
  }
  tombstones: {
    key: string
    value: Tombstone
    indexes: { 'by-learner': string }
  }
}

const DB_NAME = 'math-trainer'
const DB_VERSION = 2

let dbPromise: Promise<IDBPDatabase<TrainerDB>> | null = null

function db(): Promise<IDBPDatabase<TrainerDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TrainerDB>(DB_NAME, DB_VERSION, {
      async upgrade(database, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const attempts = database.createObjectStore('attempts', { keyPath: 'id' })
          attempts.createIndex('by-at', 'at')
          attempts.createIndex('by-skill', 'skillId')
          attempts.createIndex('by-session', 'sessionId')

          const sessions = database.createObjectStore('sessions', { keyPath: 'id' })
          sessions.createIndex('by-startedAt', 'startedAt')

          database.createObjectStore('settings', { keyPath: 'key' })
        }

        if (oldVersion < 2) {
          // Practice history becomes learner-scoped, and deletions become
          // durable records rather than the absence of rows.
          const learners = database.createObjectStore('learners', { keyPath: 'id' })
          const tombstones = database.createObjectStore('tombstones', { keyPath: 'id' })
          tombstones.createIndex('by-learner', 'learnerId')

          const attempts = tx.objectStore('attempts')
          attempts.createIndex('by-learner', 'learnerId')
          const sessions = tx.objectStore('sessions')
          sessions.createIndex('by-learner', 'learnerId')

          const learnerId = crypto.randomUUID()
          const settingsStore = tx.objectStore('settings')
          const existingName = (await settingsStore.get('learnerName'))?.value
          await learners.add({
            id: learnerId,
            name: typeof existingName === 'string' ? existingName : '',
            createdAt: Date.now(),
          })
          await settingsStore.put({ key: 'activeLearnerId', value: learnerId })

          // Assign every pre-existing record to that learner. Losing this
          // backfill would orphan the entire practice history.
          for await (const cursor of attempts.iterate()) {
            if (!cursor.value.learnerId) {
              await cursor.update({ ...cursor.value, learnerId })
            }
          }
          for await (const cursor of sessions.iterate()) {
            if (!cursor.value.learnerId) {
              await cursor.update({ ...cursor.value, learnerId })
            }
          }
        }
      },
    })
  }
  return dbPromise
}

/** Test hook: forces the next call to reopen, so a fresh fake DB is picked up. */
export function resetConnectionForTests(): void {
  dbPromise = null
}

/**
 * Asks the browser to exempt this origin from storage eviction.
 *
 * iOS Safari clears site data after roughly a week of inactivity, which would
 * silently erase months of practice history. Installing to the home screen
 * makes eviction far less likely; this makes it explicit either way. Best
 * effort - Safari may grant it without prompting, or refuse.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

export async function saveAttempts(attempts: readonly Attempt[]): Promise<void> {
  if (attempts.length === 0) return
  const database = await db()
  const tx = database.transaction('attempts', 'readwrite')
  await Promise.all(attempts.map((a) => tx.store.put(a)))
  await tx.done
}

export async function loadAttempts(): Promise<Attempt[]> {
  return (await db()).getAllFromIndex('attempts', 'by-at')
}

export async function saveSession(session: SessionRecord): Promise<void> {
  await (await db()).put('sessions', session)
}

export async function loadSessions(): Promise<SessionRecord[]> {
  return (await db()).getAllFromIndex('sessions', 'by-startedAt')
}

export async function loadLearners(): Promise<Learner[]> {
  return (await db()).getAll('learners')
}

export async function saveLearner(learner: Learner): Promise<void> {
  await (await db()).put('learners', learner)
}

export async function loadTombstones(): Promise<Tombstone[]> {
  return (await db()).getAll('tombstones')
}

export async function saveTombstones(tombstones: readonly Tombstone[]): Promise<void> {
  if (tombstones.length === 0) return
  const database = await db()
  const tx = database.transaction('tombstones', 'readwrite')
  await Promise.all(tombstones.map((t) => tx.store.put(t)))
  await tx.done
}

/** Only used to undo an erase during an explicit restore. */
export async function deleteTombstones(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const database = await db()
  const tx = database.transaction('tombstones', 'readwrite')
  await Promise.all(ids.map((id) => tx.store.delete(id)))
  await tx.done
}

/**
 * Physically removes what the given tombstones cover.
 *
 * The tombstone is what makes the deletion durable; this just reclaims the
 * space. Reads stay cheap because they never have to filter.
 */
export async function applyTombstonesLocally(
  tombstones: readonly Tombstone[],
): Promise<{ attemptsRemoved: number; sessionsRemoved: number }> {
  if (tombstones.length === 0) return { attemptsRemoved: 0, sessionsRemoved: 0 }
  const { isDeleted } = await import('../core/tombstones')
  const database = await db()

  let attemptsRemoved = 0
  const attemptTx = database.transaction('attempts', 'readwrite')
  for await (const cursor of attemptTx.store.iterate()) {
    if (isDeleted(cursor.value, tombstones)) {
      await cursor.delete()
      attemptsRemoved++
    }
  }
  await attemptTx.done

  let sessionsRemoved = 0
  const sessionTx = database.transaction('sessions', 'readwrite')
  for await (const cursor of sessionTx.store.iterate()) {
    const s = cursor.value
    if (isDeleted({ id: s.id, learnerId: s.learnerId, at: s.startedAt }, tombstones)) {
      await cursor.delete()
      sessionsRemoved++
    }
  }
  await sessionTx.done

  return { attemptsRemoved, sessionsRemoved }
}

export async function loadSettings(): Promise<Settings> {
  const database = await db()
  const rows = await database.getAll('settings')
  const merged: Settings = { ...DEFAULT_SETTINGS }
  for (const row of rows) {
    if (row.key in merged) {
      ;(merged as unknown as Record<string, unknown>)[row.key] = row.value
    }
  }
  if (!merged.createdAt) merged.createdAt = Date.now()

  // Both of these must exist before any practice is recorded, and both are
  // generated rather than configured, so fill them in on first read.
  const patch: Partial<Settings> = {}
  if (!merged.deviceId) {
    merged.deviceId = crypto.randomUUID()
    patch.deviceId = merged.deviceId
  }
  if (!merged.activeLearnerId) {
    const learners = await database.getAll('learners')
    const first = learners[0]
    if (first) {
      merged.activeLearnerId = first.id
    } else {
      const learner: Learner = {
        id: crypto.randomUUID(),
        name: merged.learnerName,
        createdAt: Date.now(),
      }
      await database.put('learners', learner)
      merged.activeLearnerId = learner.id
    }
    patch.activeLearnerId = merged.activeLearnerId
  }
  if (Object.keys(patch).length > 0) await saveSettings(patch)

  return merged
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const database = await db()
  const tx = database.transaction('settings', 'readwrite')
  await Promise.all(
    Object.entries(patch).map(([key, value]) => tx.store.put({ key, value })),
  )
  await tx.done
}

/**
 * Erases practice history for a learner, durably.
 *
 * Writes a purge tombstone first, then drops the rows. The tombstone is the
 * part that matters: without it, importing any older export would silently
 * restore everything this call removed.
 */
export async function erasePracticeData(
  learnerId: string,
  deviceId: string,
): Promise<{ tombstone: Tombstone; attemptsRemoved: number; sessionsRemoved: number }> {
  const { makePurge } = await import('../core/tombstones')
  const attempts = await loadAttempts()
  const latestKnownAt = attempts.reduce((max, a) => Math.max(max, a.at), 0)
  const tombstone = makePurge(learnerId, deviceId, Date.now(), latestKnownAt)
  await saveTombstones([tombstone])
  const removed = await applyTombstonesLocally([tombstone])
  return { tombstone, ...removed }
}
