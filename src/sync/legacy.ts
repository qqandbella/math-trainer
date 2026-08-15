import type { Attempt, SessionRecord, Tombstone } from '../core/types'

/**
 * Moves history out of the retired per-device layout.
 *
 * Records used to be stored under `learners/{learnerId}`, where the learner id
 * was generated per device. That gave every device a private namespace, so
 * devices on one account synced nothing to each other. History now lives in one
 * pool per household, and this carries the old records across.
 *
 * Everything is written locally and queued, so the ordinary push republishes it
 * into the shared pool. Nothing is deleted from the old location: it is left
 * intact so a device that has not yet upgraded still works.
 */

interface LegacyTombstone {
  id: string
  kind?: string
  targetIds?: string[]
  sessionIds?: string[]
  learnerId: string
  at: number
  deviceId: string
}

/**
 * Old shapes were a list of record ids, and a time window.
 *
 * A window is dropped rather than translated. It deletes whatever falls inside
 * it, including practice from devices the person deleting had never seen -
 * carrying one into a shared pool would erase the household's earlier history.
 * A list of ids is exact, and survives as-is.
 */
export function convertLegacyTombstone(
  legacy: LegacyTombstone,
  learnerId: string,
): Tombstone | null {
  if (legacy.kind === 'purge') return null
  const sessionIds = legacy.sessionIds ?? legacy.targetIds
  if (!sessionIds || sessionIds.length === 0) return null
  return {
    id: legacy.id,
    sessionIds,
    learnerId,
    at: legacy.at,
    deviceId: legacy.deviceId,
  }
}

export async function pullLegacyLayout(learnerId: string): Promise<number> {
  const [{ getFirebase }, { fetchAccountLearners }, storage] = await Promise.all([
    import('./auth'),
    import('./account'),
    import('../storage/db'),
  ])
  const { collection, getDocs } = await import('firebase/firestore')
  const { auth, db } = await getFirebase()
  const user = auth.currentUser
  if (!user) return 0

  // Only learners with a published document are reachable: a subcollection
  // cannot be listed from a client. Every device publishes on sign-in, so a
  // device that has been opened since is discoverable.
  const learners = await fetchAccountLearners()
  const ids = [...new Set([...learners.map((l) => l.id), learnerId])].filter(Boolean)

  let moved = 0
  for (const id of ids) {
    const base = ['households', user.uid, 'learners', id] as const
    const [attempts, sessions, tombstones] = await Promise.all([
      getDocs(collection(db, ...base, 'attempts')),
      getDocs(collection(db, ...base, 'sessions')),
      getDocs(collection(db, ...base, 'tombstones')),
    ])

    // Stamped with this device's learner id, exactly as an import is, so local
    // indexes and deletions all key off one value.
    const incomingAttempts = attempts.docs.map((d) => ({
      ...(d.data() as Attempt),
      learnerId,
    }))
    const incomingSessions = sessions.docs.map((d) => ({
      ...(d.data() as SessionRecord),
      learnerId,
    }))
    const incomingTombstones = tombstones.docs
      .map((d) => convertLegacyTombstone(d.data() as LegacyTombstone, learnerId))
      .filter((t): t is Tombstone => t !== null)

    await storage.saveAttempts(incomingAttempts, { enqueue: true })
    await storage.saveSessions(incomingSessions, { enqueue: true })
    await storage.saveTombstones(incomingTombstones, { enqueue: true })
    moved += incomingAttempts.length + incomingSessions.length + incomingTombstones.length
  }

  // Deletions recorded here are re-applied, so a session deleted on purpose
  // does not come back just because it was recovered from the old layout.
  await storage.applyTombstonesLocally(await storage.loadTombstones())
  return moved
}
