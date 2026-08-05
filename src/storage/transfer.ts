import type { Attempt, SessionRecord } from '../core/types'
import {
  loadAttempts,
  loadSessions,
  loadSettings,
  saveAttempts,
  saveSession,
  saveSettings,
  type Settings,
} from './db'

export interface ExportBundle {
  app: 'math-trainer'
  formatVersion: 1
  exportedAt: number
  deviceLabel: string
  attempts: Attempt[]
  sessions: SessionRecord[]
  settings: Pick<Settings, 'learnerName' | 'targetOverrides' | 'pauseBudget'>
}

export interface MergeReport {
  attemptsAdded: number
  attemptsSkipped: number
  sessionsAdded: number
  sessionsSkipped: number
}

export async function buildExport(deviceLabel: string): Promise<ExportBundle> {
  const [attempts, sessions, settings] = await Promise.all([
    loadAttempts(),
    loadSessions(),
    loadSettings(),
  ])
  return {
    app: 'math-trainer',
    formatVersion: 1,
    exportedAt: Date.now(),
    deviceLabel,
    attempts,
    sessions,
    settings: {
      learnerName: settings.learnerName,
      targetOverrides: settings.targetOverrides,
      pauseBudget: settings.pauseBudget,
    },
  }
}

class ImportError extends Error {}

export function parseBundle(text: string): ExportBundle {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ImportError('That file is not valid JSON.')
  }
  const bundle = raw as ExportBundle
  if (!bundle || bundle.app !== 'math-trainer') {
    throw new ImportError('That file was not exported by Math Trainer.')
  }
  if (bundle.formatVersion !== 1) {
    throw new ImportError(
      `Unsupported export format v${String(bundle.formatVersion)}; this app reads v1.`,
    )
  }
  if (!Array.isArray(bundle.attempts) || !Array.isArray(bundle.sessions)) {
    throw new ImportError('Export file is missing its attempts or sessions.')
  }
  for (const a of bundle.attempts) {
    if (typeof a.id !== 'string' || typeof a.skillId !== 'string' || typeof a.at !== 'number') {
      throw new ImportError('Export file contains a malformed attempt record.')
    }
  }
  return bundle
}

/**
 * Merges an export into this device by set-union on record id. Attempts are
 * immutable and UUID-keyed, so importing the same file twice is a no-op and
 * two devices can be merged in either direction with the same result.
 */
export async function mergeBundle(bundle: ExportBundle): Promise<MergeReport> {
  const [existingAttempts, existingSessions] = await Promise.all([
    loadAttempts(),
    loadSessions(),
  ])
  const haveAttempt = new Set(existingAttempts.map((a) => a.id))
  const haveSession = new Set(existingSessions.map((s) => s.id))

  const newAttempts = bundle.attempts.filter((a) => !haveAttempt.has(a.id))
  const newSessions = bundle.sessions.filter((s) => !haveSession.has(s.id))

  await saveAttempts(newAttempts)
  for (const session of newSessions) await saveSession(session)

  // Calibration data is a parent setting; merge it rather than overwrite.
  if (bundle.settings?.targetOverrides) {
    const current = await loadSettings()
    await saveSettings({
      targetOverrides: { ...bundle.settings.targetOverrides, ...current.targetOverrides },
    })
  }

  return {
    attemptsAdded: newAttempts.length,
    attemptsSkipped: bundle.attempts.length - newAttempts.length,
    sessionsAdded: newSessions.length,
    sessionsSkipped: bundle.sessions.length - newSessions.length,
  }
}

export function downloadBundle(bundle: ExportBundle): void {
  const stamp = new Date(bundle.exportedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `math-trainer-${stamp}.json`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** Uses the iOS/Android share sheet when available, falling back to download. */
export async function shareBundle(bundle: ExportBundle): Promise<'shared' | 'downloaded'> {
  const stamp = new Date(bundle.exportedAt).toISOString().slice(0, 10)
  const file = new File(
    [JSON.stringify(bundle, null, 2)],
    `math-trainer-${stamp}.json`,
    { type: 'application/json' },
  )
  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean
    share?: (data: { files: File[]; title?: string }) => Promise<void>
  }
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title: 'Math Trainer data' })
      return 'shared'
    } catch {
      // User dismissed the sheet, or the platform refused - fall through.
    }
  }
  downloadBundle(bundle)
  return 'downloaded'
}
