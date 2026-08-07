import { syncOnce } from './engine'
import { createFirestoreBackend } from './firestoreBackend'
import { createIndexedDbStore } from './localStore'
import { getFirebase } from './auth'
import type { SyncResult } from './types'

/**
 * Runs one sync for the signed-in account.
 *
 * The household id is the account's uid. That keeps Phase 1 to a single
 * household without painting us into a corner: the security rules already
 * accept an optional `members` map, so adding a second parent later needs no
 * data migration.
 */
export async function syncNow(learnerId: string): Promise<SyncResult> {
  const { auth, db } = await getFirebase()
  const user = auth.currentUser
  if (!user) {
    return {
      pulledAttempts: 0,
      pulledSessions: 0,
      pulledTombstones: 0,
      pushedRecords: 0,
      removedLocally: 0,
      clockSkewMs: 0,
      status: 'error',
      error: 'Not signed in.',
    }
  }
  const backend = createFirestoreBackend(db, user.uid)
  return syncOnce(learnerId, backend, createIndexedDbStore(user.uid))
}

export function describeSync(result: SyncResult): string {
  if (result.status === 'offline') return 'Offline — will sync when there is a connection.'
  if (result.status === 'error') return `Sync failed: ${result.error ?? 'unknown error'}`

  const parts: string[] = []
  const received = result.pulledAttempts + result.pulledSessions
  if (result.pushedRecords > 0) parts.push(`sent ${result.pushedRecords}`)
  if (received > 0) parts.push(`received ${received}`)
  if (result.removedLocally > 0) parts.push(`removed ${result.removedLocally} erased elsewhere`)
  return parts.length > 0 ? `Synced: ${parts.join(', ')}.` : 'Already up to date.'
}
