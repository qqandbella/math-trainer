import type { SessionRecord, Tombstone } from '../core/types'
import { deletedSessionIds } from '../core/tombstones'

export interface SyncDiagnosis {
  local: { attempts: number; sessions: number; tombstones: number }
  cloud: { attempts: number; sessions: number; tombstones: number }
  /** Cloud sessions a deletion covers, which is why they are not shown. */
  deletedSessions: number
  /** Records still sitting in the retired per-device layout. */
  legacy: { learnerId: string; attempts: number; sessions: number }[]
}

/**
 * Reports what the account actually holds.
 *
 * Every sync failure looks the same from the outside - a short history - while
 * the causes are opposite: records nobody else reads, or records that arrive
 * and are then deleted. Guessing between them from the symptom is how this bug
 * survived two rounds of fixes, so the app states the facts instead.
 */
export async function diagnoseSync(): Promise<SyncDiagnosis> {
  const [{ getFirebase }, { fetchAccountLearners }, storage] = await Promise.all([
    import('./auth'),
    import('./account'),
    import('../storage/db'),
  ])
  const { collection, getDocs } = await import('firebase/firestore')
  const { auth, db } = await getFirebase()
  const user = auth.currentUser
  if (!user) throw new Error('Not signed in.')

  const [attempts, sessions, tombstones] = await Promise.all([
    getDocs(collection(db, 'households', user.uid, 'attempts')),
    getDocs(collection(db, 'households', user.uid, 'sessions')),
    getDocs(collection(db, 'households', user.uid, 'tombstones')),
  ])

  const gone = deletedSessionIds(tombstones.docs.map((d) => d.data() as Tombstone))
  const deletedSessions = sessions.docs.filter((entry) =>
    gone.has((entry.data() as SessionRecord).id),
  ).length

  const legacy: SyncDiagnosis['legacy'] = []
  for (const learner of await fetchAccountLearners()) {
    const base = ['households', user.uid, 'learners', learner.id] as const
    const [oldAttempts, oldSessions] = await Promise.all([
      getDocs(collection(db, ...base, 'attempts')),
      getDocs(collection(db, ...base, 'sessions')),
    ])
    if (oldAttempts.size === 0 && oldSessions.size === 0) continue
    legacy.push({
      learnerId: learner.id,
      attempts: oldAttempts.size,
      sessions: oldSessions.size,
    })
  }

  const [localAttempts, localSessions, localTombstones] = await Promise.all([
    storage.loadAttempts(),
    storage.loadSessions(),
    storage.loadTombstones(),
  ])

  return {
    local: {
      attempts: localAttempts.length,
      sessions: localSessions.length,
      tombstones: localTombstones.length,
    },
    cloud: {
      attempts: attempts.size,
      sessions: sessions.size,
      tombstones: tombstones.size,
    },
    deletedSessions,
    legacy,
  }
}

/** A short, readable rendering - this gets read off a phone screen. */
export function describeDiagnosis(d: SyncDiagnosis): string {
  const lines = [
    `this device: ${d.local.sessions} sessions, ${d.local.attempts} attempts`,
    `account: ${d.cloud.sessions} sessions, ${d.cloud.attempts} attempts, ` +
      `${d.cloud.tombstones} deletions`,
  ]
  if (d.deletedSessions > 0) lines.push(`${d.deletedSessions} session(s) deleted on purpose`)
  for (const l of d.legacy) {
    lines.push(`older layout ${l.learnerId.slice(0, 8)}: ${l.sessions} sessions not yet moved`)
  }
  if (d.legacy.length === 0) lines.push('nothing left in the older layout')
  return lines.join('\n')
}
