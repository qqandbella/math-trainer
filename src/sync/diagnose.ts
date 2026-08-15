import type { Tombstone } from '../core/types'
import { isDeleted } from '../core/tombstones'

export interface LearnerCounts {
  learnerId: string
  name: string
  attempts: number
  sessions: number
  tombstones: number
}

export interface SyncDiagnosis {
  activeLearnerId: string
  learners: LearnerCounts[]
  local: { attempts: number; sessions: number; tombstones: number }
  /** Cloud sessions the tombstones would hide, whatever the cause. */
  hiddenSessions: number
  purges: { at: number; before: number; deviceId: string; learnerId: string }[]
}

/**
 * Reports what the account actually holds, per learner.
 *
 * Sync failures all present identically - a short history - while the causes
 * are opposite: records sitting under a learner id nobody else reads, versus
 * records that arrive and are then hidden by a deletion. Guessing between them
 * from the symptom is how this bug survived two rounds of fixes, so the app
 * states the facts instead.
 */
export async function diagnoseSync(activeLearnerId: string): Promise<SyncDiagnosis> {
  const [{ getFirebase }, { fetchAccountLearners }, storage] = await Promise.all([
    import('./auth'),
    import('./account'),
    import('../storage/db'),
  ])
  const { collection, getDocs } = await import('firebase/firestore')
  const { auth, db } = await getFirebase()
  const user = auth.currentUser
  if (!user) throw new Error('Not signed in.')

  const known = await fetchAccountLearners()
  // A learner the device uses but has never published would otherwise be
  // missing from the report, which is itself the interesting case.
  const ids = [...new Set([...known.map((l) => l.id), activeLearnerId])].filter(Boolean)

  const learners: LearnerCounts[] = []
  let hiddenSessions = 0
  const purges: SyncDiagnosis['purges'] = []

  for (const learnerId of ids) {
    const base = ['households', user.uid, 'learners', learnerId] as const
    const [attempts, sessions, tombstones] = await Promise.all([
      getDocs(collection(db, ...base, 'attempts')),
      getDocs(collection(db, ...base, 'sessions')),
      getDocs(collection(db, ...base, 'tombstones')),
    ])

    const stones = tombstones.docs.map((d) => d.data() as Tombstone)
    for (const stone of stones) {
      if (stone.kind === 'purge') {
        purges.push({
          at: stone.at,
          before: stone.before,
          deviceId: stone.deviceId,
          learnerId,
        })
      }
    }
    for (const entry of sessions.docs) {
      const s = entry.data() as { id: string; learnerId: string; startedAt: number }
      if (isDeleted({ id: s.id, learnerId: s.learnerId, at: s.startedAt }, stones)) {
        hiddenSessions++
      }
    }

    learners.push({
      learnerId,
      name: known.find((l) => l.id === learnerId)?.name ?? '',
      attempts: attempts.size,
      sessions: sessions.size,
      tombstones: tombstones.size,
    })
  }

  const [localAttempts, localSessions, localTombstones] = await Promise.all([
    storage.loadAttempts(),
    storage.loadSessions(),
    storage.loadTombstones(),
  ])

  return {
    activeLearnerId,
    learners,
    local: {
      attempts: localAttempts.length,
      sessions: localSessions.length,
      tombstones: localTombstones.length,
    },
    hiddenSessions,
    purges,
  }
}

/** A short, readable rendering - this gets read off a phone screen. */
export function describeDiagnosis(d: SyncDiagnosis): string {
  const lines: string[] = []
  lines.push(`this device uses learner ${d.activeLearnerId.slice(0, 8)}`)
  lines.push(`local: ${d.local.sessions} sessions, ${d.local.attempts} attempts`)
  lines.push(`account holds ${d.learners.length} learner(s):`)
  for (const l of d.learners) {
    const mark = l.learnerId === d.activeLearnerId ? '*' : ' '
    lines.push(
      `${mark} ${l.learnerId.slice(0, 8)} — ${l.sessions} sessions, ` +
        `${l.attempts} attempts, ${l.tombstones} deletions`,
    )
  }
  if (d.hiddenSessions > 0) {
    lines.push(`${d.hiddenSessions} cloud session(s) hidden by a deletion`)
  }
  for (const p of d.purges) {
    lines.push(`purge: everything before ${new Date(p.before).toLocaleString()}`)
  }
  return lines.join('\n')
}
