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
  /**
   * The account's parent secret, cached here so parent mode opens offline.
   * The authority is the household document; this is only a copy.
   */
  accountTotpSecret: string | null
  /** Legacy per-device secret, kept only so an existing device can adopt it. */
  parentTotpSecret: string | null
  /** Stable per-install id. Records which device wrote a tombstone. */
  deviceId: string
  /** How many problems a daily session asks for. 0 follows the curriculum. */
  dailyProblemCount: number
  /** Which learner new practice is recorded against. */
  activeLearnerId: string
  /** Set once this device's records have left the retired per-device layout. */
  legacyLayoutMoved: boolean
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
  accountTotpSecret: null,
  parentTotpSecret: null,
  deviceId: '',
  activeLearnerId: '',
  legacyLayoutMoved: false,
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
  /**
   * A picture of the working out for an answer that came out wrong.
   *
   * Deliberately local: these are drawings by a child, they are only useful
   * next to the session that produced them, and syncing them would mean image
   * storage, upload cost and a new class of security rule for no real gain.
   */
  workings: {
    key: string
    value: { attemptId: string; learnerId: string; image: string; at: number }
    indexes: { 'by-learner': string }
  }
}

const DB_NAME = 'math-trainer'
const DB_VERSION = 5

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

        if (oldVersion < 4) {
          const workings = database.createObjectStore('workings', { keyPath: 'attemptId' })
          workings.createIndex('by-learner', 'learnerId')
        }

        if (oldVersion < 5) {
          // Deletion becomes session-scoped. The old shapes were a list of
          // record ids, and a time window.
          const store = tx.objectStore('tombstones')
          for await (const cursor of store.iterate()) {
            const old = cursor.value as unknown as {
              id: string
              kind?: string
              targetIds?: string[]
              learnerId: string
              at: number
              deviceId: string
            }
            if (old.kind === 'purge') {
              // A window deletes whatever falls inside it, including practice
              // from other devices that the person deleting never saw. There is
              // no faithful translation, and keeping it would silently erase
              // the rest of the household's history the moment it merged.
              await cursor.delete()
              continue
            }
            if (Array.isArray(old.targetIds)) {
              // The old list held session ids alongside their attempt ids.
              // Carrying all of them across is exact: an attempt id can never
              // match a session id, so the extras cover nothing.
              await cursor.update({
                id: old.id,
                sessionIds: old.targetIds,
                learnerId: old.learnerId,
                at: old.at,
                deviceId: old.deviceId,
              })
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

export async function saveWorking(
  attemptId: string,
  learnerId: string,
  image: string,
): Promise<void> {
  await (await db()).put('workings', { attemptId, learnerId, image, at: Date.now() })
}

export async function loadWorkings(attemptIds: readonly string[]): Promise<Map<string, string>> {
  if (attemptIds.length === 0) return new Map()
  const database = await db()
  const tx = database.transaction('workings', 'readonly')
  const found = new Map<string, string>()
  await Promise.all(
    attemptIds.map(async (id) => {
      const row = await tx.store.get(id)
      if (row) found.set(id, row.image)
    }),
  )
  await tx.done
  return found
}

export async function deleteWorkings(attemptIds: readonly string[]): Promise<void> {
  if (attemptIds.length === 0) return
  const database = await db()
  const tx = database.transaction('workings', 'readwrite')
  await Promise.all(attemptIds.map((id) => tx.store.delete(id)))
  await tx.done
}

/** Bytes held by stored working-out, so the cost is visible rather than hidden. */
export async function workingsSize(): Promise<{ count: number; bytes: number }> {
  const rows = await (await db()).getAll('workings')
  return {
    count: rows.length,
    bytes: rows.reduce((sum, r) => sum + r.image.length, 0),
  }
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
  const { deletedSessionIds } = await import('../core/tombstones')
  const gone = deletedSessionIds(tombstones)
  const database = await db()

  let attemptsRemoved = 0
  const attemptTx = database.transaction('attempts', 'readwrite')
  for await (const cursor of attemptTx.store.iterate()) {
    if (gone.has(cursor.value.sessionId)) {
      await cursor.delete()
      attemptsRemoved++
    }
  }
  await attemptTx.done

  let sessionsRemoved = 0
  const sessionTx = database.transaction('sessions', 'readwrite')
  for await (const cursor of sessionTx.store.iterate()) {
    if (gone.has(cursor.value.id)) {
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
 * Removes specific sessions and everything recorded in them.
 *
 * Uses the same tombstone mechanism as a full erase, so a deleted session stays
 * deleted: it will not come back from an older export, and it propagates to
 * other devices rather than being quietly re-added by the next merge.
 */
export async function deleteSessions(
  sessionIds: readonly string[],
  learnerId: string,
  deviceId: string,
): Promise<{ attemptsRemoved: number; sessionsRemoved: number }> {
  if (sessionIds.length === 0) return { attemptsRemoved: 0, sessionsRemoved: 0 }
  const { makeTombstones } = await import('../core/tombstones')

  const attempts = await loadAttempts()
  const doomed = new Set(sessionIds)
  const attemptIds = attempts.filter((a) => doomed.has(a.sessionId)).map((a) => a.id)

  // Attempts are not listed: a tombstone names the session, and an attempt
  // belongs to one. That way a deletion also covers attempts from that session
  // which this device has never seen, without naming a time span.
  const tombstones = makeTombstones(sessionIds, learnerId, deviceId, Date.now())
  await saveTombstones(tombstones, { enqueue: true })
  const removed = await applyTombstonesLocally(tombstones)
  await deleteWorkings(attemptIds)
  return removed
}

/**
 * Erases practice history, durably.
 *
 * A reset is not its own kind of deletion - it is a tombstone for every session
 * currently stored. That keeps it bounded to history that exists: a device that
 * was offline during the reset contributes its sessions afterwards rather than
 * having them swallowed by a rule about time.
 */
export async function erasePracticeData(
  learnerId: string,
  deviceId: string,
): Promise<{ tombstones: Tombstone[]; attemptsRemoved: number; sessionsRemoved: number }> {
  const { makeTombstones } = await import('../core/tombstones')
  // Sessions an attempt refers to are included even when the session record
  // itself is missing, so a reset cannot leave orphaned practice behind.
  const [sessions, attempts] = await Promise.all([loadSessions(), loadAttempts()])
  const sessionIds = [
    ...new Set([...sessions.map((s) => s.id), ...attempts.map((a) => a.sessionId)]),
  ]
  const tombstones = makeTombstones(sessionIds, learnerId, deviceId, Date.now())
  await saveTombstones(tombstones, { enqueue: true })
  const removed = await applyTombstonesLocally(tombstones)
  // Working-out belongs to the attempts being erased; leaving it would keep
  // pictures of work whose record is gone.
  const database = await db()
  const stale = await database.getAllFromIndex('workings', 'by-learner', learnerId)
  await deleteWorkings(stale.map((r) => r.attemptId))
  return { tombstones, ...removed }
}
