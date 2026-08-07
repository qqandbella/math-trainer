import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Attempt, SessionRecord, Skill, SkillStat } from '../core/types'
import { curriculum, skills as baseSkills } from '../curriculum'
import { rebuildStats } from '../core/mastery'
import {
  DEFAULT_SETTINGS,
  loadAttempts,
  loadSessions,
  loadSettings,
  saveAttempts,
  saveSession,
  requestPersistentStorage,
  saveSettings,
  type Settings,
} from '../storage/db'

export interface SyncStatus {
  account: { uid: string; email: string | null } | null
  busy: boolean
  message: string
  lastSyncedAt: number | null
  enabled: boolean
}

interface AppState {
  ready: boolean
  attempts: Attempt[]
  sessions: SessionRecord[]
  settings: Settings
  stats: Map<string, SkillStat>
  /** Curriculum skills with parent-calibrated target times applied. */
  skills: Skill[]
  /** Every non-mental skill, for reporting. */
  practiceSkills: Skill[]
  /** Non-mental skills at or above the difficulty floor, for generating work. */
  practicePool: Skill[]
  /** Mental skills are not floored: fast easy mental work is still valuable. */
  mentalSkills: Skill[]
  recordSession(session: SessionRecord, attempts: readonly Attempt[]): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  reload(): Promise<void>
  sync: SyncStatus
  signInToSync(): Promise<void>
  signOutOfSyncing(): Promise<void>
  runSync(): Promise<void>
}

const Ctx = createContext<AppState | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }): ReactNode {
  const [ready, setReady] = useState(false)
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [sync, setSync] = useState<SyncStatus>({
    account: null,
    busy: false,
    message: '',
    lastSyncedAt: null,
    enabled: false,
  })

  const reload = useCallback(async () => {
    const [a, s, cfg] = await Promise.all([loadAttempts(), loadSessions(), loadSettings()])
    setAttempts(a)
    setSessions(s)
    setSettings(cfg)
    setReady(true)
  }, [])

  useEffect(() => {
    void reload()
    void requestPersistentStorage()
  }, [reload])

  const runSync = useCallback(async () => {
    const learnerId = settings.activeLearnerId
    if (!learnerId) return
    setSync((s) => ({ ...s, busy: true }))
    const { syncNow, describeSync } = await import('../sync/syncNow')
    const result = await syncNow(learnerId)
    await reload()
    setSync((s) => ({
      ...s,
      busy: false,
      message: describeSync(result),
      lastSyncedAt: result.status === 'ok' ? Date.now() : s.lastSyncedAt,
    }))
  }, [settings.activeLearnerId, reload])

  const signInToSync = useCallback(async () => {
    setSync((s) => ({ ...s, busy: true, message: '' }))
    try {
      const { signIn } = await import('../sync/auth')
      const account = await signIn()
      if (account) {
        const previous = settings.syncAccountUid
        const switched = previous !== '' && previous !== account.uid
        let note = ''
        if (switched && settings.activeLearnerId) {
          // The outbox was emptied when this data went to the previous account,
          // so without re-queueing, the new account would receive nothing and
          // this device would look healthy while syncing in neither direction.
          const { requeueEverything } = await import('../storage/db')
          const count = await requeueEverything(settings.activeLearnerId)
          note = `Switched account — queued ${count} local records to upload here.`
        }
        await saveSettings({ syncEnabled: true, syncAccountUid: account.uid })
        setSettings((prev) => ({
          ...prev,
          syncEnabled: true,
          syncAccountUid: account.uid,
        }))
        setSync((s) => ({ ...s, account, busy: false, enabled: true, message: note }))
      } else {
        setSync((s) => ({ ...s, busy: false }))
      }
    } catch (error) {
      setSync((s) => ({
        ...s,
        busy: false,
        message: error instanceof Error ? error.message : 'Sign-in failed.',
      }))
    }
  }, [])

  const signOutOfSyncing = useCallback(async () => {
    const { signOutOfSync } = await import('../sync/auth')
    await signOutOfSync()
    await saveSettings({ syncEnabled: false })
    setSettings((prev) => ({ ...prev, syncEnabled: false }))
    setSync({
      account: null,
      busy: false,
      message: 'Signed out. Practice history stays on this device.',
      lastSyncedAt: null,
      enabled: false,
    })
  }, [])

  // Sync again as soon as connectivity returns, so a device that practised on a
  // flaky connection does not sit on unsent work until it is next opened.
  useEffect(() => {
    if (!settings.syncEnabled) return
    const onOnline = (): void => void runSync()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [settings.syncEnabled, runSync])

  // Only devices that have opted into sync ever load the Firebase SDK.
  useEffect(() => {
    setSync((s) => ({ ...s, enabled: settings.syncEnabled }))
    if (!ready || !settings.syncEnabled) return
    let dispose: (() => void) | undefined
    void (async () => {
      const { observeAccount } = await import('../sync/auth')
      dispose = await observeAccount((account) => {
        setSync((s) => ({ ...s, account }))
        if (account) void runSync()
      })
    })()
    return () => dispose?.()
  }, [ready, settings.syncEnabled, runSync])

  const skills = useMemo(() => {
    const overrides = settings.targetOverrides
    if (!overrides || Object.keys(overrides).length === 0) return baseSkills
    return baseSkills.map((s) =>
      overrides[s.id] ? { ...s, targetSec: overrides[s.id] as number } : s,
    )
  }, [settings.targetOverrides])

  const stats = useMemo(
    () => rebuildStats(attempts, curriculum.scoring),
    [attempts],
  )

  const recordSession = useCallback(
    async (session: SessionRecord, newAttempts: readonly Attempt[]) => {
      await Promise.all([
        saveSession(session, { enqueue: true }),
        saveAttempts(newAttempts, { enqueue: true }),
      ])
      setSessions((prev) => [...prev, session])
      setAttempts((prev) => [...prev, ...newAttempts])
      // Publish immediately rather than waiting for the next app open: a
      // finished session is exactly when there is new work worth sending.
      if (settings.syncEnabled) void runSync()
    },
    [settings.syncEnabled, runSync],
  )

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    await saveSettings(patch)
    setSettings((prev) => ({ ...prev, ...patch }))
  }, [])

  const value = useMemo<AppState>(
    () => ({
      ready,
      attempts,
      sessions,
      settings,
      stats,
      skills,
      practiceSkills: skills.filter((s) => !s.mental),
      practicePool: skills.filter((s) => !s.mental && s.tier >= settings.minTier),
      mentalSkills: skills.filter((s) => s.mental),
      recordSession,
      updateSettings,
      reload,
      sync,
      signInToSync,
      signOutOfSyncing,
      runSync,
    }),
    [
      ready,
      attempts,
      sessions,
      settings,
      stats,
      skills,
      recordSession,
      updateSettings,
      reload,
      sync,
      signInToSync,
      signOutOfSyncing,
      runSync,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppState(): AppState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAppState must be used inside AppStateProvider')
  return ctx
}
