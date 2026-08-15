import {
  collection,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
  type DocumentData,
  type Firestore,
  doc,
  setDoc,
} from 'firebase/firestore'
import type { Attempt, SessionRecord, Tombstone } from '../core/types'
import type { PullResult, RecordSet, SyncBackend } from './types'

/**
 * Firestore implementation of the sync port.
 *
 * Every record is its own document, keyed by the record's own UUID, and the
 * security rules permit create but never update or delete. That combination is
 * what makes a push idempotent and history append-only at the server rather
 * than merely by client convention.
 */

const MAX_BATCH = 450 // Firestore caps a batch at 500 writes; leave headroom.

/**
 * One shared pool per household.
 *
 * History merges across every device in the account, so there is no level
 * between the household and the records. An earlier layout nested them under a
 * per-device learner id, which silently gave each device a private namespace
 * and meant devices synced nothing to each other.
 */
function pathFor(householdId: string, kind: string): string[] {
  return ['households', householdId, kind]
}

function stripSyncFields<T>(data: DocumentData): T {
  const { syncedAt: _syncedAt, ...rest } = data
  return rest as T
}

function toMillis(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0
}

export function createFirestoreBackend(
  db: Firestore,
  householdId: string,
): SyncBackend {
  async function readKind<T>(
    kind: 'attempts' | 'sessions' | 'tombstones',
    since: number,
  ): Promise<{ records: T[]; maxStamp: number }> {
    const [root, ...segments] = pathFor(householdId, kind) as [string, ...string[]]
    const ref = collection(db, root, ...segments)
    const snapshot = await getDocs(
      query(ref, where('syncedAt', '>=', Timestamp.fromMillis(since)), orderBy('syncedAt')),
    )
    let maxStamp = 0
    const records: T[] = []
    for (const document of snapshot.docs) {
      const data = document.data()
      maxStamp = Math.max(maxStamp, toMillis(data.syncedAt))
      records.push(stripSyncFields<T>(data))
    }
    return { records, maxStamp }
  }

  return {
    async pull(since): Promise<PullResult> {
      const [attempts, sessions, tombstones] = await Promise.all([
        readKind<Attempt>('attempts', since),
        readKind<SessionRecord>('sessions', since),
        readKind<Tombstone>('tombstones', since),
      ])

      const maxStamp = Math.max(attempts.maxStamp, sessions.maxStamp, tombstones.maxStamp)

      return {
        attempts: attempts.records,
        sessions: sessions.records,
        tombstones: tombstones.records,
        // Advance to just past the newest thing seen. The engine re-reads a
        // trailing window anyway, so being conservative here is harmless.
        cursor: maxStamp > 0 ? maxStamp + 1 : since,
        // Firestore exposes no direct "what time is it" read, so the newest
        // server stamp observed stands in for server time. With no data to
        // compare against, skew is reported as zero rather than guessed.
        serverNow: maxStamp > 0 ? maxStamp : Date.now(),
      }
    },

    async push(records: RecordSet): Promise<void> {
      const writes: { kind: string; id: string; payload: DocumentData }[] = [
        ...records.attempts.map((a) => ({ kind: 'attempts', id: a.id, payload: { ...a } })),
        ...records.sessions.map((s) => ({ kind: 'sessions', id: s.id, payload: { ...s } })),
        ...records.tombstones.map((t) => ({ kind: 'tombstones', id: t.id, payload: { ...t } })),
      ]
      if (writes.length === 0) return

      for (let offset = 0; offset < writes.length; offset += MAX_BATCH) {
        const chunk = writes.slice(offset, offset + MAX_BATCH)
        const batch = writeBatch(db)
        for (const write of chunk) {
          const [root, ...segments] = pathFor(householdId, write.kind) as [
            string,
            ...string[],
          ]
          batch.set(doc(collection(db, root, ...segments), write.id), {
            ...write.payload,
            syncedAt: serverTimestamp(),
          })
        }
        try {
          await batch.commit()
        } catch (error) {
          // A batch is atomic, so a retry normally re-sends only records that
          // were never written. The exception is a push that succeeded but
          // whose local queue was not cleared: those documents now exist, and
          // create-only rules reject the rewrite, which would wedge the queue
          // permanently. Fall back to per-document writes and let the ones that
          // are already present fail individually.
          if (!isPermissionDenied(error)) throw error
          await pushIndividually(db, householdId, chunk)
        }
      }
    },
  }
}

async function pushIndividually(
  db: Firestore,
  householdId: string,
  writes: { kind: string; id: string; payload: DocumentData }[],
): Promise<void> {
  const results = await Promise.allSettled(
    writes.map((write) => {
      const [root, ...segments] = pathFor(householdId, write.kind) as [string, ...string[]]
      return setDoc(doc(collection(db, root, ...segments), write.id), {
        ...write.payload,
        syncedAt: serverTimestamp(),
      })
    }),
  )

  // Only a rejection that is NOT "already exists" is a real failure worth
  // surfacing; otherwise the record is on the server, which is the goal.
  const genuine = results.filter(
    (r) => r.status === 'rejected' && !isPermissionDenied(r.reason),
  )
  if (genuine.length > 0) {
    throw new Error(`${genuine.length} record(s) failed to publish`)
  }
}

function isPermissionDenied(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? ''
  return code === 'permission-denied' || String(error).includes('permission-denied')
}
