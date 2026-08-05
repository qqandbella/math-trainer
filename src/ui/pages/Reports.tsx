import { useMemo, type ReactNode } from 'react'
import { useAppState } from '../../app/state'
import type { RouteName } from '../../app/router'
import { curriculum } from '../../curriculum'
import { computeMastery } from '../../core/mastery'
import { MasteryBar, TrendChart, type Point } from '../components/Charts'
import type { Attempt, MasteryResult, Skill, SkillGroup } from '../../core/types'

interface Props {
  navigate(route: RouteName): void
}

const DAY_MS = 24 * 60 * 60 * 1000
const GROUP_ORDER: SkillGroup[] = [
  'Addition',
  'Subtraction',
  'Multiplication',
  'Division',
  'Mixed',
  'Mental',
]

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

/** Groups attempts into calendar days, oldest first, capped to the last N days. */
function byDay(attempts: readonly Attempt[], days: number): Map<string, Attempt[]> {
  const cutoff = Date.now() - days * DAY_MS
  const out = new Map<string, Attempt[]>()
  for (const a of attempts) {
    if (a.at < cutoff || a.given === null) continue
    const key = new Date(a.at).toDateString()
    const bucket = out.get(key)
    if (bucket) bucket.push(a)
    else out.set(key, [a])
  }
  return out
}

export function Reports({ navigate }: Props): ReactNode {
  const { attempts, sessions, skills, stats } = useAppState()

  const daily = useMemo(() => byDay(attempts, 30), [attempts])

  const accuracySeries = useMemo<Point[]>(
    () =>
      [...daily.entries()].map(([key, list]) => ({
        label: dayLabel(new Date(key).getTime()),
        value: Math.round((list.filter((a) => a.correct).length / list.length) * 100),
      })),
    [daily],
  )

  const speedSeries = useMemo<Point[]>(
    () =>
      [...daily.entries()].map(([key, list]) => ({
        label: dayLabel(new Date(key).getTime()),
        value: list.reduce((sum, a) => sum + a.ms, 0) / list.length / 1000,
      })),
    [daily],
  )

  const volumeSeries = useMemo<Point[]>(
    () =>
      [...daily.entries()].map(([key, list]) => ({
        label: dayLabel(new Date(key).getTime()),
        value: list.length,
      })),
    [daily],
  )

  const mastery = useMemo(() => {
    const rows = skills.map((skill) => ({
      skill,
      mastery: computeMastery(stats.get(skill.id), skill, curriculum.scoring),
    }))
    return rows
  }, [skills, stats])

  const grouped = useMemo(() => {
    const map = new Map<SkillGroup, { skill: Skill; mastery: MasteryResult }[]>()
    for (const row of mastery) {
      const list = map.get(row.skill.group)
      if (list) list.push(row)
      else map.set(row.skill.group, [row])
    }
    return map
  }, [mastery])

  const focus = useMemo(
    () =>
      mastery
        .filter((r) => r.mastery.rated)
        .sort((a, b) => a.mastery.score - b.mastery.score)
        .slice(0, 5),
    [mastery],
  )

  const totals = useMemo(() => {
    const answered = attempts.filter((a) => a.given !== null)
    const correct = answered.filter((a) => a.correct).length
    return {
      problems: answered.length,
      accuracy: answered.length > 0 ? Math.round((correct / answered.length) * 100) : 0,
      sessions: sessions.length,
      minutes: Math.round(attempts.reduce((sum, a) => sum + a.ms, 0) / 60000),
    }
  }, [attempts, sessions])

  const bestMental = useMemo(() => {
    const scored = sessions.filter((s) => s.mode === 'mental' && s.score !== undefined)
    return scored.length > 0 ? Math.max(...scored.map((s) => s.score as number)) : null
  }, [sessions])

  if (attempts.length === 0) {
    return (
      <div className="stack">
        <div className="row-between">
          <h1>Progress</h1>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('home')}>
            done
          </button>
        </div>
        <div className="card center">
          <p className="muted">No practice recorded yet. Finish a session and come back.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="row-between">
        <h1>Progress</h1>
        <button type="button" className="btn btn-ghost" onClick={() => navigate('home')}>
          done
        </button>
      </div>

      <div className="card">
        <div className="stat-row">
          <div className="stat">
            <div className="value">{totals.problems}</div>
            <div className="label">problems</div>
          </div>
          <div className="stat">
            <div className="value">{totals.accuracy}%</div>
            <div className="label">accuracy</div>
          </div>
          <div className="stat">
            <div className="value">{totals.sessions}</div>
            <div className="label">sessions</div>
          </div>
          <div className="stat">
            <div className="value">{totals.minutes}</div>
            <div className="label">minutes</div>
          </div>
          {bestMental !== null && (
            <div className="stat">
              <div className="value">{bestMental}</div>
              <div className="label">best mental</div>
            </div>
          )}
        </div>
      </div>

      {focus.length > 0 && (
        <div className="card">
          <h3>What to work on next</h3>
          <p className="faint" style={{ marginTop: 2 }}>
            Lowest mastery among skills with enough data to judge. Daily Practice already
            weights toward these.
          </p>
          {focus.map(({ skill, mastery: m }) => (
            <MasteryBar
              key={skill.id}
              label={skill.label}
              score={m.score}
              rated={m.rated}
              detail={`${Math.round(m.accuracy * 100)}% · ${(m.medianMs / 1000).toFixed(1)}s vs ${skill.targetSec}s`}
            />
          ))}
        </div>
      )}

      <div className="card">
        <h3>Accuracy by day</h3>
        <TrendChart points={accuracySeries} max={100} unit="%" color="var(--good)" />
      </div>

      <div className="card">
        <h3>Average time per problem</h3>
        <TrendChart points={speedSeries} unit="s" color="var(--accent)" />
        <p className="faint" style={{ marginBottom: 0 }}>
          Lower is better. Mixes across whatever she practised that day, so it moves with the
          problem mix as well as with speed.
        </p>
      </div>

      <div className="card">
        <h3>Problems per day</h3>
        <TrendChart points={volumeSeries} color="var(--warn)" />
      </div>

      <div className="card">
        <h3>Mastery by skill</h3>
        <p className="faint" style={{ marginTop: 2 }}>
          100 = the calibrated reference time with no mistakes. Grey means not enough
          attempts yet.
        </p>
        {GROUP_ORDER.map((group) => {
          const rows = grouped.get(group)
          if (!rows || rows.length === 0) return null
          return (
            <div key={group}>
              <div className="group-title">{group}</div>
              {rows.map(({ skill, mastery: m }) => (
                <MasteryBar
                  key={skill.id}
                  label={skill.label}
                  score={m.score}
                  rated={m.rated}
                  detail={
                    m.attempts === 0
                      ? 'not practised'
                      : `${m.attempts} ${m.attempts === 1 ? 'try' : 'tries'} · ${Math.round(m.accuracy * 100)}% · ${(m.medianMs / 1000).toFixed(1)}s`
                  }
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
