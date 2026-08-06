import type { Attempt, SessionRecord, Tombstone } from '../core/types'

/**
 * Records as they travel between devices. Deliberately the same shapes the app
 * already stores, so nothing has to be translated on the way in or out.
 */
export interface RecordSet {
  attempts: Attempt[]
  sessions: SessionRecord[]
  tombstones: Tombstone[]
}

export interface PullResult extends RecordSet {
  /**
   * Highest server-assigned position seen in this page. The engine stores it
   * as the next cursor; it is opaque and only ever compared, never arithmetic.
   */
  cursor: number
  /** Server clock at the time of the read, used to detect device clock skew. */
  serverNow: number
}

/**
 * The only thing the sync engine knows about a backend.
 *
 * Keeping this narrow is what lets the engine be tested exhaustively against an
 * in-memory implementation, and what allows the backend to be replaced without
 * touching merge semantics.
 */
export interface SyncBackend {
  /** Everything recorded at or after `since`. Implementations must be inclusive. */
  pull(learnerId: string, since: number): Promise<PullResult>
  /**
   * Publishes records. Must be idempotent: every record carries its own id, so
   * re-sending one that already exists is a no-op rather than an error.
   */
  push(learnerId: string, records: RecordSet): Promise<void>
}

/** The slice of local storage the engine touches. */
export interface LocalStore {
  loadAttempts(): Promise<Attempt[]>
  loadSessions(): Promise<SessionRecord[]>
  loadTombstones(): Promise<Tombstone[]>
  saveAttempts(attempts: readonly Attempt[]): Promise<void>
  saveSessions(sessions: readonly SessionRecord[]): Promise<void>
  saveTombstones(tombstones: readonly Tombstone[]): Promise<void>
  /** Physically drops whatever the given tombstones cover. */
  applyTombstones(tombstones: readonly Tombstone[]): Promise<void>

  /** Ids queued for publication, in insertion order. */
  outbox(learnerId: string): Promise<string[]>
  clearOutbox(learnerId: string, ids: readonly string[]): Promise<void>

  getCursor(learnerId: string): Promise<number>
  setCursor(learnerId: string, cursor: number): Promise<void>
}

export interface SyncResult {
  pulledAttempts: number
  pulledSessions: number
  pulledTombstones: number
  pushedRecords: number
  removedLocally: number
  /** Device clock minus server clock, in ms. Large values corrupt purge windows. */
  clockSkewMs: number
  status: 'ok' | 'offline' | 'error'
  error?: string
}
