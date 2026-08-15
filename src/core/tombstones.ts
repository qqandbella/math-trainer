import type { Attempt, SessionRecord, Tombstone } from './types'

/**
 * Deletion under a merging data model.
 *
 * History merges by set union across every device, which is what makes it
 * conflict-free - but a union has no way to express "this is gone". Removing
 * rows locally is undone by the next merge with any copy that predates the
 * removal, including an export from last week. So a deletion is written down,
 * and every merge consults it.
 *
 * A deletion names sessions. It never names a time span: a span deletes
 * whatever happens to fall inside it, including practice from other devices
 * that the person deleting had never seen. Naming sessions means a deletion
 * removes exactly what was chosen, on every device, forever.
 *
 * These functions are pure and hold no storage assumptions, so the same rules
 * apply to a local erase, an import, and a pull from the server.
 */

/** Every session id covered by these tombstones. */
export function deletedSessionIds(tombstones: readonly Tombstone[]): Set<string> {
  const ids = new Set<string>()
  for (const tombstone of tombstones) {
    for (const sessionId of tombstone.sessionIds) ids.add(sessionId)
  }
  return ids
}

export function attemptIsDeleted(
  attempt: Pick<Attempt, 'sessionId'>,
  tombstones: readonly Tombstone[],
): boolean {
  return deletedSessionIds(tombstones).has(attempt.sessionId)
}

export function sessionIsDeleted(
  session: Pick<SessionRecord, 'id'>,
  tombstones: readonly Tombstone[],
): boolean {
  return deletedSessionIds(tombstones).has(session.id)
}

export function survivingAttempts(
  attempts: readonly Attempt[],
  tombstones: readonly Tombstone[],
): Attempt[] {
  if (tombstones.length === 0) return attempts.slice()
  const gone = deletedSessionIds(tombstones)
  return attempts.filter((a) => !gone.has(a.sessionId))
}

export function survivingSessions(
  sessions: readonly SessionRecord[],
  tombstones: readonly Tombstone[],
): SessionRecord[] {
  if (tombstones.length === 0) return sessions.slice()
  const gone = deletedSessionIds(tombstones)
  return sessions.filter((s) => !gone.has(s.id))
}

/**
 * One tombstone per session, which is what makes a deletion mergeable.
 *
 * "Reset everything" is not a distinct operation - it is a tombstone for each
 * session currently stored. That keeps a reset as bounded as any other
 * deletion: it removes the history that exists, not history that arrives
 * afterwards from a device that was offline.
 */
export function makeTombstones(
  sessionIds: readonly string[],
  learnerId: string,
  deviceId: string,
  now: number,
): Tombstone[] {
  return sessionIds.map((sessionId) => ({
    id: crypto.randomUUID(),
    sessionIds: [sessionId],
    at: now,
    deviceId,
    learnerId,
  }))
}

/** Drops tombstones that name nothing new, so the log cannot outgrow the data. */
export function compactTombstones(tombstones: readonly Tombstone[]): Tombstone[] {
  const seen = new Set<string>()
  const out: Tombstone[] = []
  for (const tombstone of tombstones) {
    const fresh = tombstone.sessionIds.filter((id) => !seen.has(id))
    if (fresh.length === 0) continue
    for (const id of fresh) seen.add(id)
    out.push(tombstone)
  }
  return out
}
