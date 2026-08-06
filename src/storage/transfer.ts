import type { Attempt, Learner, SessionRecord, Tombstone } from '../core/types'
import { compactTombstones, isDeleted } from '../core/tombstones'
import {
  applyTombstonesLocally,
  deleteTombstones,
  loadAttempts,
  loadLearners,
  loadSessions,
  loadSettings,
  loadTombstones,
  saveAttempts,
  saveLearner,
  saveSession,
  saveSettings,
  saveTombstones,
  type Settings,
} from './db'

export const FORMAT_VERSION = 2

export interface ExportBundle {
  app: 'math-trainer'
  formatVersion: number
  exportedAt: number
  deviceLabel: string
  learners: Learner[]
  attempts: Attempt[]
  sessions: SessionRecord[]
  /** Deletions travel with the data, or importing this file would undo them. */
  tombstones: Tombstone[]
  settings: Pick<Settings, 'learnerName' | 'targetOverrides' | 'pauseBudget'>
}

export interface MergeReport {
  attemptsAdded: number
  attemptsSkipped: number
  sessionsAdded: number
  sessionsSkipped: number
  /** Records this device has deliberately erased, and therefore did not restore. */
  attemptsBlockedByErase: number
  /** Rows removed here because the file carried a newer deletion. */
  removedByImportedTombstones: number
}

export async function buildExport(deviceLabel: string): Promise<ExportBundle> {
  const [attempts, sessions, settings, tombstones, learners] = await Promise.all([
    loadAttempts(),
    loadSessions(),
    loadSettings(),
    loadTombstones(),
    loadLearners(),
  ])
  return {
    app: 'math-trainer',
    formatVersion: FORMAT_VERSION,
    exportedAt: Date.now(),
    deviceLabel,
    learners,
    attempts,
    sessions,
    tombstones,
    settings: {
      learnerName: settings.learnerName,
      targetOverrides: settings.targetOverrides,
      pauseBudget: settings.pauseBudget,
    },
  }
}

class ImportError extends Error {}

/**
 * Parses an export file, accepting the v1 format that predates learner scoping
 * and tombstones. Older files are adopted into the active learner rather than
 * rejected - refusing to read a backup someone actually made is a poor trade
 * for a schema detail.
 */
export function parseBundle(text: string, activeLearnerId: string): ExportBundle {
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
  if (bundle.formatVersion > FORMAT_VERSION) {
    throw new ImportError(
      `This file was written by a newer version of the app (format v${String(
        bundle.formatVersion,
      )}). Update this device and try again.`,
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

  return {
    ...bundle,
    learners: bundle.learners ?? [],
    tombstones: bundle.tombstones ?? [],
    attempts: bundle.attempts.map((a) => ({ ...a, learnerId: a.learnerId ?? activeLearnerId })),
    sessions: bundle.sessions.map((s) => ({ ...s, learnerId: s.learnerId ?? activeLearnerId })),
  }
}

/**
 * Reconciles learner identity across devices.
 *
 * Every device mints its own learner id on first run, so the same child has a
 * different id on the laptop and the tablet. Merging without reconciling would
 * leave two disjoint histories - and worse, an erase recorded on one device
 * would not match the other device's records and would silently fail to apply.
 *
 * While a device tracks exactly one learner, an incoming bundle is by
 * definition the same child, so its records are adopted. Once there are
 * several learners (a later phase) identity must be matched explicitly instead,
 * because the assumption no longer holds.
 */
function adoptIncomingLearner(
  bundle: ExportBundle,
  localLearners: readonly Learner[],
): ExportBundle {
  const local = localLearners.length === 1 ? localLearners[0] : undefined
  if (!local) return bundle
  return {
    ...bundle,
    attempts: bundle.attempts.map((a) => ({ ...a, learnerId: local.id })),
    sessions: bundle.sessions.map((s) => ({ ...s, learnerId: local.id })),
    tombstones: bundle.tombstones.map((t) => ({ ...t, learnerId: local.id })),
  }
}

export interface MergeOptions {
  /**
   * Restore records this device previously erased, by dropping the tombstones
   * that cover them. Without it, an import cannot undo a deliberate erase.
   */
  overrideErasures?: boolean
}

/**
 * Merges an export into this device by set union on record id, then applies
 * every known deletion.
 *
 * Union alone is not enough: an older file necessarily predates any erase, so a
 * plain union would silently restore deleted history. Tombstones are merged
 * first and then enforced in both directions - incoming records covered by a
 * local deletion are refused, and local rows covered by an incoming deletion
 * are removed.
 */
export async function mergeBundle(
  incoming: ExportBundle,
  options: MergeOptions = {},
): Promise<MergeReport> {
  let bundle = incoming
  const [existingAttempts, existingSessions, existingTombstones, localLearners] =
    await Promise.all([loadAttempts(), loadSessions(), loadTombstones(), loadLearners()])

  bundle = adoptIncomingLearner(bundle, localLearners)

  let effectiveTombstones = compactTombstones([...existingTombstones, ...bundle.tombstones])

  if (options.overrideErasures) {
    // Restoring means the deletions themselves have to go; a tombstone that
    // survives would simply re-erase the records on the next merge.
    const covering = new Set(
      effectiveTombstones
        .filter((t) => bundle.attempts.some((a) => isDeleted(a, [t])))
        .map((t) => t.id),
    )
    effectiveTombstones = effectiveTombstones.filter((t) => !covering.has(t.id))
    await deleteTombstones([...covering])
  }

  const newTombstones = bundle.tombstones.filter(
    (t) => !existingTombstones.some((e) => e.id === t.id),
  )
  await saveTombstones(newTombstones)
  const removed = await applyTombstonesLocally(newTombstones)

  // Only when learner identity was not remapped; otherwise this would create a
  // duplicate learner alongside the one the records were just adopted into.
  if (localLearners.length !== 1) {
    for (const learner of bundle.learners) {
      await saveLearner(learner)
    }
  }

  const haveAttempt = new Set(existingAttempts.map((a) => a.id))
  const haveSession = new Set(existingSessions.map((s) => s.id))

  const candidateAttempts = bundle.attempts.filter((a) => !haveAttempt.has(a.id))
  const survivingAttempts = candidateAttempts.filter((a) => !isDeleted(a, effectiveTombstones))
  const blocked = candidateAttempts.length - survivingAttempts.length

  const candidateSessions = bundle.sessions.filter((s) => !haveSession.has(s.id))
  const survivingSessions = candidateSessions.filter(
    (s) => !isDeleted({ id: s.id, learnerId: s.learnerId, at: s.startedAt }, effectiveTombstones),
  )

  await saveAttempts(survivingAttempts)
  for (const session of survivingSessions) await saveSession(session)

  if (bundle.settings?.targetOverrides) {
    const current = await loadSettings()
    await saveSettings({
      targetOverrides: { ...bundle.settings.targetOverrides, ...current.targetOverrides },
    })
  }

  return {
    attemptsAdded: survivingAttempts.length,
    attemptsSkipped: bundle.attempts.length - candidateAttempts.length,
    sessionsAdded: survivingSessions.length,
    sessionsSkipped: bundle.sessions.length - candidateSessions.length,
    attemptsBlockedByErase: blocked,
    removedByImportedTombstones: removed.attemptsRemoved,
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
