import type { Attempt, SessionRecord, Tombstone } from './types'

/**
 * Deletion under a merging data model.
 *
 * Attempts merge by set union, which is what makes multi-device history
 * conflict-free - but a union has no way to express "this is gone". Removing
 * rows locally is undone by the next merge with any copy that predates the
 * removal, including an export file from last week. So a deletion is written
 * down, and every merge consults it.
 *
 * These functions are pure and hold no storage assumptions, so the same rules
 * apply to a local erase, an import, and (later) a pull from a server.
 */

interface Deletable {
  id: string
  learnerId: string
  at: number
}

/** True when a tombstone covers this record, i.e. the record is deleted. */
export function isDeleted(record: Deletable, tombstones: readonly Tombstone[]): boolean {
  for (const tombstone of tombstones) {
    if (tombstone.learnerId !== record.learnerId) continue
    if (tombstone.kind === 'purge') {
      if (record.at <= tombstone.before) return true
    } else if (tombstone.targetIds.includes(record.id)) {
      return true
    }
  }
  return false
}

export function surviving<T extends Deletable>(
  records: readonly T[],
  tombstones: readonly Tombstone[],
): T[] {
  if (tombstones.length === 0) return records.slice()
  return records.filter((record) => !isDeleted(record, tombstones))
}

/** Sessions are timestamped by their start, which is what a purge compares. */
function asDeletable(session: SessionRecord): Deletable {
  return { id: session.id, learnerId: session.learnerId, at: session.startedAt }
}

export function survivingSessions(
  sessions: readonly SessionRecord[],
  tombstones: readonly Tombstone[],
): SessionRecord[] {
  if (tombstones.length === 0) return sessions.slice()
  return sessions.filter((session) => !isDeleted(asDeletable(session), tombstones))
}

export function survivingAttempts(
  attempts: readonly Attempt[],
  tombstones: readonly Tombstone[],
): Attempt[] {
  return surviving(attempts, tombstones)
}

export function makePurge(
  learnerId: string,
  deviceId: string,
  now: number,
  latestKnownAt = 0,
): Tombstone {
  return {
    id: crypto.randomUUID(),
    kind: 'purge',
    learnerId,
    // Anchored past anything already recorded, so a device whose clock runs
    // ahead cannot leave records stranded on the far side of the boundary.
    before: Math.max(now, latestKnownAt),
    at: now,
    deviceId,
  }
}

export function makeRecordTombstone(
  learnerId: string,
  deviceId: string,
  targetIds: string[],
  now: number,
): Tombstone {
  return {
    id: crypto.randomUUID(),
    kind: 'record',
    learnerId,
    targetIds,
    at: now,
    deviceId,
  }
}

/**
 * Collapses redundant tombstones. A purge subsumes every earlier purge and any
 * record tombstone it already covers, so history does not accumulate a
 * deletion log that outgrows the data it deletes.
 */
export function compactTombstones(tombstones: readonly Tombstone[]): Tombstone[] {
  const latestPurge = new Map<string, number>()
  for (const t of tombstones) {
    if (t.kind !== 'purge') continue
    const current = latestPurge.get(t.learnerId) ?? -1
    if (t.before > current) latestPurge.set(t.learnerId, t.before)
  }

  const out: Tombstone[] = []
  const keptPurge = new Set<string>()
  for (const t of tombstones) {
    const purgeBefore = latestPurge.get(t.learnerId)
    if (t.kind === 'purge') {
      if (t.before !== purgeBefore || keptPurge.has(t.learnerId)) continue
      keptPurge.add(t.learnerId)
      out.push(t)
    } else {
      // A record tombstone is redundant once a purge covers the same window.
      if (purgeBefore !== undefined && t.at <= purgeBefore) continue
      out.push(t)
    }
  }
  return out
}
