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
  saveSettings,
  type Settings,
} from '../storage/db'

interface AppState {
  ready: boolean
  attempts: Attempt[]
  sessions: SessionRecord[]
  settings: Settings
  stats: Map<string, SkillStat>
  /** Curriculum skills with parent-calibrated target times applied. */
  skills: Skill[]
  practiceSkills: Skill[]
  mentalSkills: Skill[]
  recordSession(session: SessionRecord, attempts: readonly Attempt[]): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  reload(): Promise<void>
}

const Ctx = createContext<AppState | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }): ReactNode {
  const [ready, setReady] = useState(false)
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)

  const reload = useCallback(async () => {
    const [a, s, cfg] = await Promise.all([loadAttempts(), loadSessions(), loadSettings()])
    setAttempts(a)
    setSessions(s)
    setSettings(cfg)
    setReady(true)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

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
      await Promise.all([saveSession(session), saveAttempts(newAttempts)])
      setSessions((prev) => [...prev, session])
      setAttempts((prev) => [...prev, ...newAttempts])
    },
    [],
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
      mentalSkills: skills.filter((s) => s.mental),
      recordSession,
      updateSettings,
      reload,
    }),
    [ready, attempts, sessions, settings, stats, skills, recordSession, updateSettings, reload],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppState(): AppState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAppState must be used inside AppStateProvider')
  return ctx
}
