import {
  applyTombstonesLocally,
  clearOutbox,
  getSyncCursor,
  loadAttempts,
  loadSessions,
  loadTombstones,
  outboxIds,
  saveAttempts,
  saveSessions,
  saveTombstones,
  setSyncCursor,
} from '../storage/db'
import type { LocalStore } from './types'

/**
 * Binds the sync engine to real device storage.
 *
 * Note that saves here never enqueue: everything passing through this adapter
 * arrived *from* the backend, and re-queueing it would make each device
 * republish whatever it just received.
 */
export const indexedDbStore: LocalStore = {
  loadAttempts,
  loadSessions,
  loadTombstones,
  saveAttempts: (attempts) => saveAttempts(attempts),
  saveSessions: (sessions) => saveSessions(sessions),
  saveTombstones: (tombstones) => saveTombstones(tombstones),
  applyTombstones: async (tombstones) => {
    await applyTombstonesLocally(tombstones)
  },
  outbox: (learnerId) => outboxIds(learnerId),
  clearOutbox: (_learnerId, ids) => clearOutbox(ids),
  getCursor: (learnerId) => getSyncCursor(learnerId),
  setCursor: (learnerId, cursor) => setSyncCursor(learnerId, cursor),
}
