import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAppState } from '../../app/state'
import type { RouteName } from '../../app/router'
import { curriculum } from '../../curriculum'
import { computeMastery, median } from '../../core/mastery'
import { createRng } from '../../core/rng'
import { generateBatch } from '../../core/generator'
import { selectSkills, type SelectionContext } from '../../core/selection'
import { SessionRunner } from '../components/SessionRunner'
import { generateSecret, otpauthUrl, secondsRemaining, verifyTotp } from '../../parent/totp'
import { QrCode } from '../../parent/QrCode'
import { buildExport, mergeBundle, parseBundle, shareBundle } from '../../storage/transfer'
import { deleteSessions, erasePracticeData, workingsSize } from '../../storage/db'
import { SessionHistory } from '../components/SessionHistory'
import type { Attempt } from '../../core/types'

interface Props {
  navigate(route: RouteName): void
}

const CALIBRATION_COUNT = 40

/**
 * Parent tools require an account.
 *
 * Signing in is what separates basic use from the advanced features, and the
 * parent secret lives with the account rather than the device - so it is
 * enrolled once and works on every device, instead of once per device and
 * browser profile.
 *
 * Being signed in is not by itself enough: the learner's own tablet has to be
 * signed in for sync to work, so a code is still required to get past this.
 */
export function Parent({ navigate }: Props): ReactNode {
  const { settings, updateSettings, sync, signInToSync, preloadSignIn } = useAppState()
  const [unlocked, setUnlocked] = useState(false)

  useEffect(() => {
    if (!sync.account) void preloadSignIn()
  }, [sync.account, preloadSignIn])

  if (!sync.account) {
    return <SignInRequired onSignIn={signInToSync} busy={sync.busy} onCancel={() => navigate('home')} />
  }

  const secret = settings.accountTotpSecret

  if (!unlocked) {
    return secret ? (
      <Gate secret={secret} onUnlock={() => setUnlocked(true)} onCancel={() => navigate('home')} />
    ) : (
      <Enrollment
        // An existing device-local secret is adopted as the account's, so a
        // household that already enrolled does not have to start again.
        suggested={settings.parentTotpSecret}
        onEnrolled={async (chosen) => {
          const { setAccountSecret } = await import('../../sync/account')
          await setAccountSecret(chosen)
          await updateSettings({ accountTotpSecret: chosen })
          setUnlocked(true)
        }}
        onCancel={() => navigate('home')}
      />
    )
  }

  return <ParentHome navigate={navigate} />
}

function SignInRequired({
  onSignIn,
  busy,
  onCancel,
}: {
  onSignIn(): Promise<void>
  busy: boolean
  onCancel(): void
}): ReactNode {
  return (
    <div className="stack">
      <h1>Parent tools</h1>
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          Sign in with Google to reach reports, calibration, settings and sync. Practice
          itself never needs an account.
        </p>
        <p className="faint" style={{ margin: 0 }}>
          Parent access is set up once for the account and then works on every device, rather
          than being enrolled separately on each one.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={busy}
          onClick={() => void onSignIn()}
        >
          {busy ? 'Opening…' : 'Sign in with Google'}
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={onCancel}>
          Back
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ gate */

function Gate({
  secret,
  onUnlock,
  onCancel,
}: {
  secret: string
  onUnlock(): void
  onCancel(): void
}): ReactNode {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  const submit = useCallback(async () => {
    setChecking(true)
    const ok = await verifyTotp(code, secret)
    setChecking(false)
    if (ok) onUnlock()
    else {
      setError('Wrong code.')
      setCode('')
    }
  }, [code, secret, onUnlock])

  return (
    <div className="stack">
      <h1>Parent</h1>
      <div className="card stack">
        <div className="field">
          <label>Authenticator code</label>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            maxLength={6}
            placeholder="000000"
            onChange={(e) => {
              setError('')
              setCode(e.target.value.replace(/\D/g, ''))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
          {error && <span style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</span>}
        </div>
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={code.length !== 6 || checking}
          onClick={() => void submit()}
        >
          Unlock
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={onCancel}>
          Back
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ enrollment */

function Enrollment({
  onEnrolled,
  onCancel,
  suggested,
}: {
  onEnrolled(secret: string): Promise<void>
  onCancel(): void
  suggested?: string | null
}): ReactNode {
  const [secret] = useState(() => suggested ?? generateSecret())
  // Named at enrollment, because every device generates its own secret and
  // several identical "Math Trainer: parent" entries are impossible to tell
  // apart in an authenticator app.
  const [label, setLabel] = useState('parent')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [remaining, setRemaining] = useState(() => secondsRemaining())

  useEffect(() => {
    const timer = window.setInterval(() => setRemaining(secondsRemaining()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const confirm = useCallback(async () => {
    if (await verifyTotp(code, secret)) await onEnrolled(secret)
    else {
      setError('That code does not match. Check the secret was entered correctly.')
      setCode('')
    }
  }, [code, secret, onEnrolled])

  return (
    <div className="stack">
      <h1>Set up parent access</h1>
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          Parent mode is protected by a time-based code from your authenticator app rather
          than a password — a code seen over your shoulder is useless 30 seconds later.
        </p>
        <p className="faint" style={{ margin: 0 }}>
          Set up once for the account. Every device you sign in to accepts the same codes,
          including offline.
        </p>
        <div>
          <div className="field">
            <label>1. Name this device in your authenticator</label>
            <input
              type="text"
              value={label}
              placeholder="e.g. yuyao-ipad"
              maxLength={40}
              onChange={(e) => setLabel(e.target.value)}
            />
            <span className="faint">
              Shows up as &ldquo;Math Trainer &middot; {label.trim() || 'parent'}&rdquo;. Give
              each device its own name so they are distinguishable later.
            </span>
          </div>
          <div className="field">
            <label>2. Scan this with your authenticator app</label>
            <div className="qr-wrap">
              <QrCode value={otpauthUrl(secret, label.trim() || 'parent')} />
            </div>
          </div>
          <p className="faint" style={{ marginTop: 0 }}>
            Setting up on this same device?{' '}
            <a href={otpauthUrl(secret, label.trim() || 'parent')}>Open in authenticator</a>{' '}
            instead of scanning.
          </p>
          <details>
            <summary className="faint" style={{ cursor: 'pointer' }}>
              Can&apos;t scan? Enter the code by hand
            </summary>
            <div className="code-block" style={{ marginTop: 8 }}>
              {secret}
            </div>
          </details>
        </div>
        <div className="field">
          <label>3. Enter the current code to confirm ({remaining}s left)</label>
          <input
            type="text"
            inputMode="numeric"
            value={code}
            maxLength={6}
            placeholder="000000"
            onChange={(e) => {
              setError('')
              setCode(e.target.value.replace(/\D/g, ''))
            }}
          />
          {error && <span style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</span>}
        </div>
        <p className="faint" style={{ margin: 0 }}>
          Store the secret somewhere safe. It is kept with your account, so clearing this
          device&apos;s data does not lose it.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={code.length !== 6}
          onClick={() => void confirm()}
        >
          Confirm and unlock
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- parent home */

type Panel = 'menu' | 'calibrate' | 'data' | 'settings' | 'sessions'

function ParentHome({ navigate }: Props): ReactNode {
  const [panel, setPanel] = useState<Panel>('menu')

  if (panel === 'calibrate') return <Calibration onDone={() => setPanel('menu')} />
  if (panel === 'data') return <DataPanel onBack={() => setPanel('menu')} />
  if (panel === 'settings') return <SettingsPanel onBack={() => setPanel('menu')} />
  if (panel === 'sessions') return <SessionsPanel onBack={() => setPanel('menu')} />

  return (
    <div className="stack">
      <div className="row-between">
        <h1>Parent</h1>
        <button type="button" className="btn btn-ghost" onClick={() => navigate('home')}>
          exit
        </button>
      </div>

      <p className="faint" style={{ margin: '-6px 0 0' }}>
        Build {__BUILD_ID__}
      </p>

      <MasteryTable />

      <div className="mode-grid">
        <button type="button" className="mode-card" onClick={() => setPanel('calibrate')}>
          <span className="title">Calibrate reference times</span>
          <span className="muted">
            Run {CALIBRATION_COUNT} problems yourself; your speed becomes the 100 mark
          </span>
        </button>
        <button type="button" className="mode-card" onClick={() => setPanel('sessions')}>
          <span className="title">Sessions</span>
          <span className="muted">Review each session, and delete ones that should not count</span>
        </button>
        <button type="button" className="mode-card" onClick={() => setPanel('data')}>
          <span className="title">Export / import</span>
          <span className="muted">Move or merge data by file, no account needed</span>
        </button>
        <button type="button" className="mode-card" onClick={() => setPanel('settings')}>
          <span className="title">Settings</span>
          <span className="muted">Name, pauses, feedback style</span>
        </button>
        <button type="button" className="mode-card" onClick={() => navigate('reports')}>
          <span className="title">Full progress report</span>
          <span className="muted">Same charts she sees</span>
        </button>
      </div>
    </div>
  )
}

function MasteryTable(): ReactNode {
  const { skills, stats } = useAppState()
  const rows = useMemo(
    () =>
      skills
        .map((skill) => ({
          skill,
          m: computeMastery(stats.get(skill.id), skill, curriculum.scoring),
        }))
        .filter((r) => r.m.attempts > 0)
        .sort((a, b) => a.m.score - b.m.score),
    [skills, stats],
  )

  if (rows.length === 0) {
    return (
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          No practice data yet.
        </p>
      </div>
    )
  }

  return (
    <div className="card">
      <h3>Every practised skill</h3>
      <table className="data">
        <thead>
          <tr>
            <th>Skill</th>
            <th style={{ textAlign: 'right' }}>n</th>
            <th style={{ textAlign: 'right' }}>acc</th>
            <th style={{ textAlign: 'right' }}>median</th>
            <th style={{ textAlign: 'right' }}>target</th>
            <th style={{ textAlign: 'right' }}>mastery</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ skill, m }) => (
            <tr key={skill.id}>
              <td>{skill.label}</td>
              <td style={{ textAlign: 'right' }}>{m.attempts}</td>
              <td style={{ textAlign: 'right' }}>{Math.round(m.accuracy * 100)}%</td>
              <td style={{ textAlign: 'right' }}>{(m.medianMs / 1000).toFixed(1)}s</td>
              <td style={{ textAlign: 'right' }} className="muted">
                {skill.targetSec}s
              </td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>
                {m.rated ? Math.round(m.score) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------ calibration */

function Calibration({ onDone }: { onDone(): void }): ReactNode {
  const { practicePool, practiceSkills, stats, updateSettings, settings } = useAppState()
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<Record<string, number> | null>(null)

  const spec = useMemo(() => {
    const rng = createRng((Math.random() * 2 ** 32) >>> 0)
    const ctx: SelectionContext = {
      stats,
      now: Date.now(),
      rng,
      selection: curriculum.selection,
      scoring: curriculum.scoring,
    }
    // Spread evenly across the ladder rather than weighting by her weakness -
    // calibration wants coverage, not remediation.
    const chosen = selectSkills(practicePool, CALIBRATION_COUNT, {
      ...ctx,
      stats: new Map(),
    })
    return {
      mode: 'calibration' as const,
      learnerId: settings.activeLearnerId,
      problems: generateBatch(chosen, rng),
      pauseBudget: 1,
      allowSkip: false,
      allowScratch: true,
      allowBack: true,
    }
  }, [practicePool, stats, settings.activeLearnerId])

  const handleComplete = useCallback((attempts: Attempt[]) => {
    const bySkill = new Map<string, number[]>()
    for (const a of attempts) {
      if (!a.correct) continue
      const list = bySkill.get(a.skillId)
      if (list) list.push(a.ms)
      else bySkill.set(a.skillId, [a.ms])
    }
    const overrides: Record<string, number> = {}
    for (const [skillId, times] of bySkill) {
      overrides[skillId] = Math.round((median(times) / 1000) * 10) / 10
    }
    setResult(overrides)
    setRunning(false)
  }, [])

  const apply = useCallback(async () => {
    if (!result) return
    await updateSettings({
      targetOverrides: { ...settings.targetOverrides, ...result },
    })
    onDone()
  }, [result, settings.targetOverrides, updateSettings, onDone])

  if (running) {
    return (
      <SessionRunner
        spec={spec}
        persist={false}
        onComplete={handleComplete}
        onExit={() => setRunning(false)}
      />
    )
  }

  if (result) {
    const entries = Object.entries(result)
    return (
      <div className="stack">
        <h1>Calibration result</h1>
        <div className="card">
          <p className="muted">
            These become the 100 mark for the skills you covered. Skills you did not hit keep
            their current reference time.
          </p>
          <table className="data">
            <tbody>
              {entries.map(([skillId, seconds]) => (
                <tr key={skillId}>
                  <td>{practiceSkills.find((s) => s.id === skillId)?.label ?? skillId}</td>
                  <td style={{ textAlign: 'right', fontWeight: 650 }}>{seconds}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row">
          <button type="button" className="btn btn-primary btn-block" onClick={() => void apply()}>
            Use these times
          </button>
          <button type="button" className="btn btn-block" onClick={onDone}>
            Discard
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="stack">
      <h1>Calibrate</h1>
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          You answer {CALIBRATION_COUNT} problems at your natural working pace, on paper, the
          way the learner would. Your median time per skill becomes that skill&apos;s reference — a
          mastery of 100 then means &ldquo;as fast as you, with no mistakes&rdquo;.
        </p>
        <p className="faint" style={{ margin: 0 }}>
          Nothing from this session is written to the learner&apos;s history.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => setRunning(true)}
        >
          Start calibration
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={onDone}>
          Back
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- sessions */

function SessionsPanel({ onBack }: { onBack(): void }): ReactNode {
  const { sessions, attempts, skills, settings, reload } = useAppState()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [status, setStatus] = useState('')

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const remove = useCallback(async () => {
    const removed = await deleteSessions(
      [...selected],
      settings.activeLearnerId,
      settings.deviceId,
    )
    await reload()
    setSelected(new Set())
    setConfirming(false)
    setStatus(
      `Deleted ${removed.sessionsRemoved} session${removed.sessionsRemoved === 1 ? '' : 's'} ` +
        `and ${removed.attemptsRemoved} problems.`,
    )
  }, [selected, settings.activeLearnerId, settings.deviceId, reload])

  return (
    <div className="stack">
      <h1>Sessions</h1>
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          Tick any session that should not count — your own trial runs, for instance — and
          delete it. Deleting is permanent and propagates to your other devices; it will not
          come back from an older backup.
        </p>
        {selected.size > 0 &&
          (confirming ? (
            <>
              <button type="button" className="btn btn-danger btn-block" onClick={() => void remove()}>
                Yes, delete {selected.size} session{selected.size === 1 ? '' : 's'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-danger btn-block"
              onClick={() => setConfirming(true)}
            >
              Delete {selected.size} selected
            </button>
          ))}
        {status && (
          <p className="faint" style={{ margin: 0 }}>
            {status}
          </p>
        )}
        <SessionHistory
          sessions={sessions}
          attempts={attempts}
          skills={skills}
          selectable
          selected={selected}
          onToggleSelected={toggle}
        />
      </div>
      <button type="button" className="btn btn-ghost btn-block" onClick={onBack}>
        Back
      </button>
    </div>
  )
}

/* -------------------------------------------------------------- data i/o */

function DataPanel({ onBack }: { onBack(): void }): ReactNode {
  const { reload, attempts, sessions, settings } = useAppState()
  const [workings, setWorkings] = useState<{ count: number; bytes: number } | null>(null)

  useEffect(() => {
    void workingsSize().then(setWorkings)
  }, [])
  const [status, setStatus] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [confirmingReset, setConfirmingReset] = useState(false)
  /** Held so a blocked restore can be retried without re-picking the file. */
  const [blockedFile, setBlockedFile] = useState<{ text: string; count: number } | null>(null)

  const doExport = useCallback(async () => {
    const bundle = await buildExport(navigator.userAgent.includes('iPad') ? 'iPad' : 'computer')
    const how = await shareBundle(bundle)
    setStatus(
      how === 'shared'
        ? 'Shared.'
        : `Downloaded ${bundle.attempts.length} attempts and ${bundle.sessions.length} sessions.`,
    )
  }, [])

  const runImport = useCallback(
    async (text: string, overrideErasures: boolean) => {
      try {
        const bundle = parseBundle(text, settings.activeLearnerId)
        const report = await mergeBundle(bundle, { overrideErasures })
        await reload()

        const parts = [
          `Merged: ${report.attemptsAdded} new attempts (${report.attemptsSkipped} already here), ` +
            `${report.sessionsAdded} new sessions.`,
        ]
        if (report.removedByImportedTombstones > 0) {
          parts.push(
            `${report.removedByImportedTombstones} removed here because the file recorded an erase.`,
          )
        }
        if (report.attemptsBlockedByErase > 0) {
          // Silently dropping them would look like the import simply failed.
          parts.push(
            `${report.attemptsBlockedByErase} were left out because they were erased on this device.`,
          )
          setBlockedFile({ text, count: report.attemptsBlockedByErase })
        } else {
          setBlockedFile(null)
        }
        setStatus(parts.join(' '))
      } catch (error) {
        setBlockedFile(null)
        setStatus(error instanceof Error ? error.message : 'Import failed.')
      }
    },
    [reload, settings.activeLearnerId],
  )

  return (
    <div className="stack">
      <h1>Export / import</h1>
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          {attempts.length} attempts across {sessions.length} sessions on this device.
          Merging is by record id, so importing the same file twice changes nothing and two
          devices can be merged in either order.
        </p>
        {workings && workings.count > 0 && (
          <p className="faint" style={{ margin: 0 }}>
            {workings.count} pictures of working out, {Math.round(workings.bytes / 1024)} KB.
            These stay on this device and are not exported or synced.
          </p>
        )}
        <button type="button" className="btn btn-primary btn-block" onClick={() => void doExport()}>
          Export data
        </button>
        <button
          type="button"
          className="btn btn-block"
          onClick={() => fileRef.current?.click()}
        >
          Import and merge
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void file.text().then((text) => runImport(text, false))
            e.target.value = ''
          }}
        />
        {status && <p className="faint" style={{ margin: 0 }}>{status}</p>}
        {blockedFile && (
          <button
            type="button"
            className="btn btn-block"
            onClick={() => void runImport(blockedFile.text, true)}
          >
            Restore the {blockedFile.count} erased anyway
          </button>
        )}
      </div>

      <div className="card stack">
        <h3>Danger</h3>
        {confirmingReset ? (
          <>
            <p className="muted" style={{ margin: 0 }}>
              This erases every attempt and session on this device, and records the erase so
              that importing an older backup will not quietly bring it back. Export first if
              you want a copy.
            </p>
            <button
              type="button"
              className="btn btn-danger btn-block"
              onClick={() => {
                void erasePracticeData(settings.activeLearnerId, settings.deviceId)
                  .then(async (result) => {
                    await reload()
                    setConfirmingReset(false)
                    setBlockedFile(null)
                    setStatus(
                      `All practice data erased (${result.attemptsRemoved} attempts).`,
                    )
                  })
              }}
            >
              Yes, erase everything
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              onClick={() => setConfirmingReset(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-danger btn-block"
            onClick={() => setConfirmingReset(true)}
          >
            Erase all practice data
          </button>
        )}
      </div>

      <button type="button" className="btn btn-ghost btn-block" onClick={onBack}>
        Back
      </button>
    </div>
  )
}

/* ------------------------------------------------------------- settings */

function SettingsPanel({ onBack }: { onBack(): void }): ReactNode {
  const { settings, updateSettings } = useAppState()

  return (
    <div className="stack">
      <h1>Settings</h1>
      <div className="card">
        <div className="field">
          <label>Learner name</label>
          <input
            type="text"
            value={settings.learnerName}
            placeholder="shown on the dashboard"
            onChange={(e) => void updateSettings({ learnerName: e.target.value })}
          />
        </div>

        <div className="field">
          <label>Problems in a daily session</label>
          <div className="chip-row">
            {curriculum.presets.daily.countChoices.map((n) => (
              <button
                key={n}
                type="button"
                className={`chip${
                  (settings.dailyProblemCount || curriculum.presets.daily.problemCount) === n
                    ? ' selected'
                    : ''
                }`}
                onClick={() => void updateSettings({ dailyProblemCount: n })}
              >
                {n}
              </button>
            ))}
          </div>
          <span className="faint">
            Shorter sessions done every day beat long ones done occasionally. The mix of
            operations stays in proportion whichever length you pick.
          </span>
        </div>

        <div className="field">
          <label>Pauses allowed per session</label>
          <div className="chip-row">
            {[0, 1, 2, 3, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={`chip${settings.pauseBudget === n ? ' selected' : ''}`}
                onClick={() => void updateSettings({ pauseBudget: n })}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Difficulty floor for written practice</label>
          <div className="chip-row">
            {[
              { tier: 1, label: 'Everything' },
              { tier: 2, label: 'Skip the easiest' },
              { tier: 3, label: 'Harder only' },
            ].map(({ tier, label }) => (
              <button
                key={tier}
                type="button"
                className={`chip${settings.minTier === tier ? ' selected' : ''}`}
                onClick={() => void updateSettings({ minTier: tier })}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="faint">
            Keeps single-digit tables and no-carry addition out of written sessions, where
            they are wasted reps that also dilute the per-skill numbers. Mental Challenge
            ignores this — fast easy mental work is still worth doing.
          </span>
        </div>

        <div className="field">
          <label>Feedback during a session</label>
          <div className="chip-row">
            <button
              type="button"
              className={`chip${!settings.revealAnswersDuringSession ? ' selected' : ''}`}
              onClick={() => void updateSettings({ revealAnswersDuringSession: false })}
            >
              Quiet
            </button>
            <button
              type="button"
              className={`chip${settings.revealAnswersDuringSession ? ' selected' : ''}`}
              onClick={() => void updateSettings({ revealAnswersDuringSession: true })}
            >
              Show right/wrong
            </button>
          </div>
          <span className="faint">
            Quiet advances without flagging mistakes and reviews them all at the end — less
            pressure for a cautious solver.
          </span>
        </div>
      </div>
      <button type="button" className="btn btn-ghost btn-block" onClick={onBack}>
        Back
      </button>
    </div>
  )
}
