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
  /** How many problems a daily session asks for. 0 follows the curriculum. */
  dailyProblemCount: number
  /** Which learner new practice is recorded against. */
  activeLearnerId: string
  /** The account this device last synced with, to detect a switch. */
  syncAccountUid: string
  /**
   * Whether this device has ever signed in to sync. Gates loading the Firebase
   * SDK at all, so a device that never syncs never downloads it.
   */
  syncEnabled: boolean
  createdAt: number
}

export const DEFAULT_SETTINGS: Settings = {
  learnerName: '',
  pauseBudget: 3,
  revealAnswersDuringSession: false,
  minTier: 2,
  dailyProblemCount: 0,
  targetOverrides: {},
  parentTotpSecret: null,
  deviceId: '',
  activeLearnerId: '',
  syncAccountUid: '',
  syncEnabled: false,
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
  /** Ids awaiting publication to the shared backend. */
  outbox: {
    key: string
    value: { id: string; learnerId: string; queuedAt: number }
    indexes: { 'by-learner': string }
  }
  syncState: {
    key: string
    value: { learnerId: string; cursor: number }
  }
}

const DB_NAME = 'math-trainer'
const DB_VERSION = 3

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

        if (oldVersion < 3) {
          const outbox = database.createObjectStore('outbox', { keyPath: 'id' })
          outbox.createIndex('by-learner', 'learnerId')
          database.createObjectStore('syncState', { keyPath: 'learnerId' })

          // Queue everything already on this device, so the first sync after
          // signing in publishes the existing history rather than only future
          // practice.
          const queuedAt = Date.now()
          const attempts = tx.objectStore('attempts')
          for await (const cursor of attempts.iterate()) {
            await outbox.put({ id: cursor.value.id, learnerId: cursor.value.learnerId, queuedAt })
          }
          const sessions = tx.objectStore('sessions')
          for await (const cursor of sessions.iterate()) {
            await outbox.put({ id: cursor.value.id, learnerId: cursor.value.learnerId, queuedAt })
          }
          const tombstones = tx.objectStore('tombstones')
          for await (const cursor of tombstones.iterate()) {
            await outbox.put({ id: cursor.value.id, learnerId: cursor.value.learnerId, queuedAt })
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

/**
 * `enqueue` marks records for publication. It must stay false for records
 * arriving *from* sync, or every device would echo back everything it received.
 */
export async function saveAttempts(
  attempts: readonly Attempt[],
  { enqueue = false }: { enqueue?: boolean } = {},
): Promise<void> {
  if (attempts.length === 0) return
  const database = await db()
  const tx = database.transaction('attempts', 'readwrite')
  await Promise.all(attempts.map((a) => tx.store.put(a)))
  await tx.done
  if (enqueue) {
    await enqueueForSync(attempts.map((a) => ({ id: a.id, learnerId: a.learnerId })))
  }
}

export async function enqueueForSync(
  records: readonly { id: string; learnerId: string }[],
): Promise<void> {
  if (records.length === 0) return
  const database = await db()
  const tx = database.transaction('outbox', 'readwrite')
  const queuedAt = Date.now()
  await Promise.all(records.map((r) => tx.store.put({ ...r, queuedAt })))
  await tx.done
}

export async function outboxIds(learnerId: string): Promise<string[]> {
  const rows = await (await db()).getAllFromIndex('outbox', 'by-learner', learnerId)
  return rows.sort((a, b) => a.queuedAt - b.queuedAt).map((r) => r.id)
}

export async function clearOutbox(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const database = await db()
  const tx = database.transaction('outbox', 'readwrite')
  await Promise.all(ids.map((id) => tx.store.delete(id)))
  await tx.done
}

/**
 * Cursors are per account AND per learner.
 *
 * A cursor is a position in one account's server timeline. Reusing it against a
 * different account would ask for "everything after a point that account never
 * reached", silently skipping that account's entire history.
 */
function cursorKey(accountUid: string, learnerId: string): string {
  return `${accountUid}:${learnerId}`
}

export async function getSyncCursor(accountUid: string, learnerId: string): Promise<number> {
  return (await (await db()).get('syncState', cursorKey(accountUid, learnerId)))?.cursor ?? 0
}

export async function setSyncCursor(
  accountUid: string,
  learnerId: string,
  cursor: number,
): Promise<void> {
  await (await db()).put('syncState', {
    learnerId: cursorKey(accountUid, learnerId),
    cursor,
  })
}

/**
 * Queues every local record for publication.
 *
 * Used when this device starts syncing with a different account: the outbox was
 * emptied when the data went to the previous one, so without this the new
 * account would never receive anything this device already holds.
 */
export async function requeueEverything(learnerId: string): Promise<number> {
  const [attempts, sessions, tombstones] = await Promise.all([
    loadAttempts(),
    loadSessions(),
    loadTombstones(),
  ])
  const records = [
    ...attempts.filter((a) => a.learnerId === learnerId).map((a) => ({ id: a.id, learnerId })),
    ...sessions.filter((s) => s.learnerId === learnerId).map((s) => ({ id: s.id, learnerId })),
    ...tombstones.filter((t) => t.learnerId === learnerId).map((t) => ({ id: t.id, learnerId })),
  ]
  await enqueueForSync(records)
  return records.length
}

export async function loadAttempts(): Promise<Attempt[]> {
  return (await db()).getAllFromIndex('attempts', 'by-at')
}

export async function saveSession(
  session: SessionRecord,
  { enqueue = false }: { enqueue?: boolean } = {},
): Promise<void> {
  await (await db()).put('sessions', session)
  if (enqueue) await enqueueForSync([{ id: session.id, learnerId: session.learnerId }])
}

export async function saveSessions(
  sessions: readonly SessionRecord[],
  { enqueue = false }: { enqueue?: boolean } = {},
): Promise<void> {
  for (const session of sessions) await saveSession(session, { enqueue })
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

export async function saveTombstones(
  tombstones: readonly Tombstone[],
  { enqueue = false }: { enqueue?: boolean } = {},
): Promise<void> {
  if (tombstones.length === 0) return
  const database = await db()
  const tx = database.transaction('tombstones', 'readwrite')
  await Promise.all(tombstones.map((t) => tx.store.put(t)))
  await tx.done
  if (enqueue) {
    await enqueueForSync(tombstones.map((t) => ({ id: t.id, learnerId: t.learnerId })))
  }
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
  await saveTombstones([tombstone], { enqueue: true })
  const removed = await applyTombstonesLocally([tombstone])
  return { tombstone, ...removed }
}
