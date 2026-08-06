import type { Attempt, SessionRecord, Tombstone } from '../core/types'
import { isDeleted } from '../core/tombstones'
import type { LocalStore, PullResult, RecordSet, SyncBackend } from './types'

/**
 * An in-memory stand-in for the shared backend, plus an in-memory local store.
 *
 * Together these let the sync engine be exercised against the situations that
 * actually break sync - two devices writing at once, a deletion racing a merge,
 * a push failing halfway, a write landing behind a cursor - without a network,
 * a server, or an emulator.
 */

interface StoredRecord {
  position: number
  kind: 'attempt' | 'session' | 'tombstone'
  learnerId: string
  id: string
  value: Attempt | SessionRecord | Tombstone
}

export class FakeServer {
  private records: StoredRecord[] = []
  private nextPosition = 1
  clock = 1_000_000

  /** Publishes records, assigning each the next server position. */
  accept(learnerId: string, incoming: RecordSet): void {
    const put = (kind: StoredRecord['kind'], id: string, value: StoredRecord['value']): void => {
      // Create-only, exactly like the real security rules: an id that already
      // exists is left untouched rather than overwritten.
      if (this.records.some((r) => r.id === id && r.learnerId === learnerId)) return
      this.records.push({ position: this.nextPosition++, kind, learnerId, id, value })
    }
    for (const a of incoming.attempts) put('attempt', a.id, a)
    for (const s of incoming.sessions) put('session', s.id, s)
    for (const t of incoming.tombstones) put('tombstone', t.id, t)
  }

  /**
   * Publishes a record at an explicit position, simulating a commit that lands
   * behind a cursor another device has already passed.
   */
  acceptAtPosition(learnerId: string, position: number, records: RecordSet): void {
    for (const a of records.attempts) {
      this.records.push({ position, kind: 'attempt', learnerId, id: a.id, value: a })
    }
    for (const t of records.tombstones) {
      this.records.push({ position, kind: 'tombstone', learnerId, id: t.id, value: t })
    }
  }

  read(learnerId: string, since: number): PullResult {
    const page = this.records.filter((r) => r.learnerId === learnerId && r.position >= since)
    return {
      attempts: page.filter((r) => r.kind === 'attempt').map((r) => r.value as Attempt),
      sessions: page.filter((r) => r.kind === 'session').map((r) => r.value as SessionRecord),
      tombstones: page.filter((r) => r.kind === 'tombstone').map((r) => r.value as Tombstone),
      cursor: this.nextPosition,
      serverNow: this.clock,
    }
  }

  size(): number {
    return this.records.length
  }

  countOf(kind: StoredRecord['kind']): number {
    return this.records.filter((r) => r.kind === kind).length
  }
}

export interface FaultOptions {
  failPull?: Error | null
  failPush?: Error | null
}

export function createFakeBackend(server: FakeServer, faults: FaultOptions = {}): SyncBackend {
  return {
    async pull(learnerId, since) {
      if (faults.failPull) throw faults.failPull
      return server.read(learnerId, since)
    },
    async push(learnerId, records) {
      if (faults.failPush) throw faults.failPush
      server.accept(learnerId, records)
    },
  }
}

/** A device: local records, an outbox, and a cursor. */
export class MemoryLocalStore implements LocalStore {
  attempts = new Map<string, Attempt>()
  sessions = new Map<string, SessionRecord>()
  tombstones = new Map<string, Tombstone>()
  private queued = new Map<string, string[]>()
  private cursors = new Map<string, number>()

  async loadAttempts(): Promise<Attempt[]> {
    return [...this.attempts.values()]
  }

  async loadSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
  }

  async loadTombstones(): Promise<Tombstone[]> {
    return [...this.tombstones.values()]
  }

  async saveAttempts(attempts: readonly Attempt[]): Promise<void> {
    for (const a of attempts) this.attempts.set(a.id, a)
  }

  async saveSessions(sessions: readonly SessionRecord[]): Promise<void> {
    for (const s of sessions) this.sessions.set(s.id, s)
  }

  async saveTombstones(tombstones: readonly Tombstone[]): Promise<void> {
    for (const t of tombstones) this.tombstones.set(t.id, t)
  }

  async applyTombstones(tombstones: readonly Tombstone[]): Promise<void> {
    for (const [id, a] of this.attempts) {
      if (isDeleted(a, tombstones)) this.attempts.delete(id)
    }
    for (const [id, s] of this.sessions) {
      if (isDeleted({ id: s.id, learnerId: s.learnerId, at: s.startedAt }, tombstones)) {
        this.sessions.delete(id)
      }
    }
  }

  async outbox(learnerId: string): Promise<string[]> {
    return this.queued.get(learnerId) ?? []
  }

  async clearOutbox(learnerId: string, ids: readonly string[]): Promise<void> {
    const remaining = (this.queued.get(learnerId) ?? []).filter((id) => !ids.includes(id))
    this.queued.set(learnerId, remaining)
  }

  async getCursor(learnerId: string): Promise<number> {
    return this.cursors.get(learnerId) ?? 0
  }

  async setCursor(learnerId: string, cursor: number): Promise<void> {
    this.cursors.set(learnerId, cursor)
  }

  /** Records local practice and queues it for the next sync. */
  record(learnerId: string, record: Attempt | SessionRecord | Tombstone): void {
    if ('kind' in record) this.tombstones.set(record.id, record)
    else if ('mode' in record) this.sessions.set(record.id, record)
    else this.attempts.set(record.id, record)
    const queue = this.queued.get(learnerId) ?? []
    queue.push(record.id)
    this.queued.set(learnerId, queue)
  }
}
