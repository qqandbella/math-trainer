import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Attempt, SessionRecord } from '../core/types'

export interface Settings {
  learnerName: string
  pauseBudget: number
  revealAnswersDuringSession: boolean
  /**
   * Lowest skill tier used for written practice. A learner already fluent in
   * single-digit tables gains nothing from drilling them, and those reps would
   * dilute the per-skill measurements.
   */
  minTier: number
  /** Parent-calibrated reference times, skillId -> seconds. Overrides curriculum. */
  targetOverrides: Record<string, number>
  /** Base32 TOTP secret for the parent gate. Generated on-device, never shipped. */
  parentTotpSecret: string | null
  createdAt: number
}

export const DEFAULT_SETTINGS: Settings = {
  learnerName: '',
  pauseBudget: 3,
  revealAnswersDuringSession: false,
  minTier: 2,
  targetOverrides: {},
  parentTotpSecret: null,
  createdAt: 0,
}

interface TrainerDB extends DBSchema {
  attempts: {
    key: string
    value: Attempt
    indexes: { 'by-at': number; 'by-skill': string; 'by-session': string }
  }
  sessions: {
    key: string
    value: SessionRecord
    indexes: { 'by-startedAt': number }
  }
  settings: {
    key: string
    value: { key: string; value: unknown }
  }
}

const DB_NAME = 'math-trainer'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<TrainerDB>> | null = null

function db(): Promise<IDBPDatabase<TrainerDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TrainerDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        const attempts = database.createObjectStore('attempts', { keyPath: 'id' })
        attempts.createIndex('by-at', 'at')
        attempts.createIndex('by-skill', 'skillId')
        attempts.createIndex('by-session', 'sessionId')

        const sessions = database.createObjectStore('sessions', { keyPath: 'id' })
        sessions.createIndex('by-startedAt', 'startedAt')

        database.createObjectStore('settings', { keyPath: 'key' })
      },
    })
  }
  return dbPromise
}

export async function saveAttempts(attempts: readonly Attempt[]): Promise<void> {
  if (attempts.length === 0) return
  const database = await db()
  const tx = database.transaction('attempts', 'readwrite')
  await Promise.all(attempts.map((a) => tx.store.put(a)))
  await tx.done
}

export async function loadAttempts(): Promise<Attempt[]> {
  return (await db()).getAllFromIndex('attempts', 'by-at')
}

export async function saveSession(session: SessionRecord): Promise<void> {
  await (await db()).put('sessions', session)
}

export async function loadSessions(): Promise<SessionRecord[]> {
  return (await db()).getAllFromIndex('sessions', 'by-startedAt')
}

export async function loadSettings(): Promise<Settings> {
  const rows = await (await db()).getAll('settings')
  const merged: Settings = { ...DEFAULT_SETTINGS }
  for (const row of rows) {
    if (row.key in merged) {
      ;(merged as unknown as Record<string, unknown>)[row.key] = row.value
    }
  }
  if (!merged.createdAt) merged.createdAt = Date.now()
  return merged
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const database = await db()
  const tx = database.transaction('settings', 'readwrite')
  await Promise.all(
    Object.entries(patch).map(([key, value]) => tx.store.put({ key, value })),
  )
  await tx.done
}

export async function clearAllData(): Promise<void> {
  const database = await db()
  const tx = database.transaction(['attempts', 'sessions'], 'readwrite')
  await Promise.all([tx.objectStore('attempts').clear(), tx.objectStore('sessions').clear()])
  await tx.done
}
