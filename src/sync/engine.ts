import type { Attempt, Tombstone } from '../core/types'
import { compactTombstones, deletedSessionIds } from '../core/tombstones'
import type { LocalStore, RecordSet, SyncBackend, SyncResult } from './types'

/**
 * How far back to re-read on every pull.
 *
 * A write can be assigned a server position marginally behind a cursor the
 * reader has already moved past, which would leave it unseen forever. Re-reading
 * a trailing window closes that gap, and costs nothing but a few reads because
 * every merge is idempotent.
 */
export const DEFAULT_OVERLAP_MS = 5 * 60 * 1000

/** Beyond this the device clock is reported as suspect. */
export const CLOCK_SKEW_WARN_MS = 5 * 60 * 1000

export interface SyncOptions {
  overlapMs?: number
  /** Injectable for tests; defaults to the device clock. */
  now?: () => number
}

/**
 * One full reconciliation: pull, merge, push.
 *
 * History is merged across every device in the account. A device id is an
 * annotation on a session, never a partition - so there is one shared pool of
 * records and a device's own id has no effect on what it sees.
 *
 * Incoming records are stamped with this device's learner id, exactly as an
 * import is. Local indexes and deletions are keyed by learner, so a record
 * arriving under the id another device happened to generate would sit outside
 * every local query without being visibly absent.
 *
 * Order matters. Tombstones are merged before records so that an erase
 * performed elsewhere is enforced against what arrives in the same pass, rather
 * than data being written and then immediately deleted. Pushing happens last so
 * that anything just learned is never echoed straight back.
 *
 * Failure is always safe: nothing is discarded locally on error, and the cursor
 * only advances after a pull has been fully applied. A crash mid-sync repeats
 * work rather than losing it.
 */
export async function syncOnce(
  learnerId: string,
  backend: SyncBackend,
  local: LocalStore,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const overlapMs = options.overlapMs ?? DEFAULT_OVERLAP_MS
  const now = options.now ?? (() => Date.now())

  const result: SyncResult = {
    pulledAttempts: 0,
    pulledSessions: 0,
    pulledTombstones: 0,
    pushedRecords: 0,
    removedLocally: 0,
    clockSkewMs: 0,
    status: 'ok',
  }

  try {
    const cursor = await local.getCursor(learnerId)
    const since = Math.max(0, cursor - overlapMs)
    const raw = await backend.pull(since)
    const incoming = {
      ...raw,
      attempts: raw.attempts.map((a) => ({ ...a, learnerId })),
      sessions: raw.sessions.map((s) => ({ ...s, learnerId })),
      tombstones: raw.tombstones.map((t) => ({ ...t, learnerId })),
    }

    // Snapshot before any deletion is applied. Counting afterwards would always
    // report zero, because the rows being counted are already gone.
    const [attemptsBefore, sessionsBefore] = await Promise.all([
      local.loadAttempts(),
      local.loadSessions(),
    ])

    // 1. Deletions first, so they apply to records arriving in this same pass.
    const knownTombstones = await local.loadTombstones()
    const knownTombstoneIds = new Set(knownTombstones.map((t) => t.id))
    const newTombstones = incoming.tombstones.filter((t) => !knownTombstoneIds.has(t.id))
    if (newTombstones.length > 0) {
      await local.saveTombstones(newTombstones)
      await local.applyTombstones(newTombstones)
    }
    const effective = compactTombstones([...knownTombstones, ...newTombstones])

    // 2. Records the tombstones do not cover, and that are genuinely new.
    //    "Already have" is judged against what survived the deletions above, so
    //    a record that was just removed is not mistaken for one already held.
    const gone = deletedSessionIds(effective)
    const haveAttempt = new Set(
      attemptsBefore.filter((a) => !gone.has(a.sessionId)).map((a) => a.id),
    )
    const haveSession = new Set(
      sessionsBefore.filter((s) => !gone.has(s.id)).map((s) => s.id),
    )

    const attemptsToSave = incoming.attempts.filter(
      (a) => !haveAttempt.has(a.id) && !gone.has(a.sessionId),
    )
    const sessionsToSave = incoming.sessions.filter(
      (s) => !haveSession.has(s.id) && !gone.has(s.id),
    )
    if (attemptsToSave.length > 0) await local.saveAttempts(attemptsToSave)
    if (sessionsToSave.length > 0) await local.saveSessions(sessionsToSave)

    result.pulledAttempts = attemptsToSave.length
    result.pulledSessions = sessionsToSave.length
    result.pulledTombstones = newTombstones.length
    result.removedLocally = countCovered(attemptsBefore, newTombstones)
    result.clockSkewMs = now() - incoming.serverNow

    // 3. Advance only after everything above succeeded.
    await local.setCursor(learnerId, Math.max(cursor, incoming.cursor))

    // 4. Publish local work. Records deleted before they were ever pushed are
    //    dropped from the queue rather than resurrected onto the server.
    const queued = new Set(await local.outbox(learnerId))
    let pushedRecords = 0
    if (queued.size > 0) {
      const afterMerge = await Promise.all([
        local.loadAttempts(),
        local.loadSessions(),
        local.loadTombstones(),
      ])
      const [allAttempts, allSessions, allTombstones] = afterMerge
      const outgoing: RecordSet = {
        attempts: allAttempts.filter((a) => queued.has(a.id)),
        sessions: allSessions.filter((s) => queued.has(s.id)),
        tombstones: allTombstones.filter((t) => queued.has(t.id)),
      }
      pushedRecords =
        outgoing.attempts.length + outgoing.sessions.length + outgoing.tombstones.length
      if (pushedRecords > 0) await backend.push(outgoing)
      result.pushedRecords = pushedRecords
      // Clear the whole queue, including ids whose records no longer exist:
      // leaving them would retry forever.
      await local.clearOutbox(learnerId, [...queued])
    }

    return result
  } catch (error) {
    // Sync is never load-bearing: a failure leaves local practice untouched,
    // and whatever completed before the failure is still reported honestly.
    result.status = isOffline(error) ? 'offline' : 'error'
    result.error = error instanceof Error ? error.message : String(error)
    return result
  }
}

function countCovered(attempts: readonly Attempt[], tombstones: readonly Tombstone[]): number {
  if (tombstones.length === 0) return 0
  const gone = deletedSessionIds(tombstones)
  return attempts.filter((a) => gone.has(a.sessionId)).length
}

function isOffline(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes('offline') ||
    message.includes('network') ||
    message.includes('unavailable') ||
    message.includes('failed to fetch')
  )
}

export function clockSkewIsConcerning(skewMs: number): boolean {
  return Math.abs(skewMs) > CLOCK_SKEW_WARN_MS
}
