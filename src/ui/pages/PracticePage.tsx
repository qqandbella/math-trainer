import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useAppState } from '../../app/state'
import type { RouteName } from '../../app/router'
import { curriculum } from '../../curriculum'
import { createRng } from '../../core/rng'
import { generateBatch } from '../../core/generator'
import { selectByMix, selectSkills, type SelectionContext } from '../../core/selection'
import { SessionRunner } from '../components/SessionRunner'
import type { Op, SessionMode } from '../../core/types'
import type { OpMix } from '../../curriculum'

interface Props {
  mode: 'daily' | 'custom' | 'timed' | 'mental'
  navigate(route: RouteName): void
}

/**
 * Timed modes end on the clock, so the problem list is over-provisioned well
 * past any plausible rate rather than being sized to a guess.
 */
const TIMED_OVERPROVISION = 400

const OP_LABELS: Record<Op, string> = {
  add: 'Addition',
  sub: 'Subtraction',
  mul: 'Multiplication',
  div: 'Division',
  mixed: 'Mixed',
}

export function PracticePage({ mode, navigate }: Props): ReactNode {
  const { stats, practicePool, mentalSkills, settings } = useAppState()
  const [seed, setSeed] = useState(() => (Math.random() * 2 ** 32) >>> 0)
  const [started, setStarted] = useState(mode === 'daily' || mode === 'timed')

  const [customOps, setCustomOps] = useState<Op[]>(['add', 'sub', 'mul', 'div'])
  const [customCount, setCustomCount] = useState(30)
  const [mentalDuration, setMentalDuration] = useState(curriculum.presets.mental.durationSec)

  const spec = useMemo(() => {
    const rng = createRng(seed)
    const ctx: SelectionContext = {
      stats,
      now: Date.now(),
      rng,
      selection: curriculum.selection,
      scoring: curriculum.scoring,
    }
    const pauseBudget = settings.pauseBudget
    const learnerId = settings.activeLearnerId

    if (mode === 'daily') {
      const preset = curriculum.presets.daily
      const chosen = selectByMix(practicePool, preset.mix, preset.problemCount, ctx)
      return {
        mode: 'daily' as SessionMode,
        learnerId,
        problems: generateBatch(chosen, rng),
        pauseBudget,
        allowSkip: false,
        allowScratch: true,
        allowBack: true,
      }
    }

    if (mode === 'timed') {
      const preset = curriculum.presets.timed
      const chosen = selectByMix(practicePool, preset.mix, TIMED_OVERPROVISION, ctx)
      return {
        mode: 'timed' as SessionMode,
        learnerId,
        problems: generateBatch(chosen, rng),
        durationSec: preset.durationSec,
        pauseBudget,
        allowSkip: false,
        allowScratch: true,
        allowBack: true,
      }
    }

    if (mode === 'mental') {
      const chosen = selectSkills(mentalSkills, TIMED_OVERPROVISION, ctx)
      return {
        mode: 'mental' as SessionMode,
        learnerId,
        problems: generateBatch(chosen, rng),
        durationSec: mentalDuration,
        pauseBudget: 1,
        allowSkip: true,
        allowScratch: false,
        allowBack: false,
      }
    }

    const mix: OpMix = Object.fromEntries(customOps.map((op) => [op, 1]))
    const chosen = selectByMix(practicePool, mix, customCount, ctx)
    return {
      mode: 'custom' as SessionMode,
      learnerId,
      problems: generateBatch(chosen, rng),
      pauseBudget,
      allowSkip: false,
      allowScratch: true,
      allowBack: true,
    }
  }, [
    mode,
    seed,
    stats,
    practicePool,
    mentalSkills,
    settings.pauseBudget,
    settings.activeLearnerId,
    customOps,
    customCount,
    mentalDuration,
  ])

  const exit = useCallback(() => navigate('home'), [navigate])
  const regenerate = useCallback(() => setSeed((Math.random() * 2 ** 32) >>> 0), [])

  if (!started) {
    return mode === 'mental' ? (
      <MentalSetup
        duration={mentalDuration}
        setDuration={setMentalDuration}
        onStart={() => setStarted(true)}
        onCancel={exit}
      />
    ) : (
      <CustomSetup
        ops={customOps}
        setOps={setCustomOps}
        count={customCount}
        setCount={setCustomCount}
        onStart={() => setStarted(true)}
        onCancel={exit}
      />
    )
  }

  return (
    <SessionRunner
      spec={spec}
      onExit={exit}
      onRestart={regenerate}
      scoreAsMental={mode === 'mental'}
    />
  )
}

interface MentalSetupProps {
  duration: number
  setDuration(seconds: number): void
  onStart(): void
  onCancel(): void
}

function MentalSetup({
  duration,
  setDuration,
  onStart,
  onCancel,
}: MentalSetupProps): ReactNode {
  return (
    <div className="stack">
      <h1>Mental Challenge</h1>
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          No paper. Answer as many as you can. Harder problems are worth more; skipping
          costs points, and skipping an easy one costs the most.
        </p>
        <div>
          <div className="field">
            <label>How long?</label>
            <div className="chip-row">
              {curriculum.presets.mental.durationChoices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className={`chip${duration === choice ? ' selected' : ''}`}
                  onClick={() => setDuration(choice)}
                >
                  {choice / 60} min
                </button>
              ))}
            </div>
          </div>
        </div>
        <button type="button" className="btn btn-primary btn-block" onClick={onStart}>
          Start
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={onCancel}>
          Back
        </button>
      </div>
    </div>
  )
}

interface CustomSetupProps {
  ops: Op[]
  setOps(ops: Op[]): void
  count: number
  setCount(count: number): void
  onStart(): void
  onCancel(): void
}

function CustomSetup({
  ops,
  setOps,
  count,
  setCount,
  onStart,
  onCancel,
}: CustomSetupProps): ReactNode {
  const toggle = (op: Op): void => {
    setOps(ops.includes(op) ? ops.filter((o) => o !== op) : [...ops, op])
  }

  return (
    <div className="stack">
      <h1>Custom Practice</h1>
      <div className="card">
        <div className="field">
          <label>Operations</label>
          <div className="chip-row">
            {(Object.keys(OP_LABELS) as Op[]).map((op) => (
              <button
                key={op}
                type="button"
                className={`chip${ops.includes(op) ? ' selected' : ''}`}
                onClick={() => toggle(op)}
              >
                {OP_LABELS[op]}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>How many problems</label>
          <div className="chip-row">
            {[10, 20, 30, 50, 60, 100].map((n) => (
              <button
                key={n}
                type="button"
                className={`chip${count === n ? ' selected' : ''}`}
                onClick={() => setCount(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={onStart}
          disabled={ops.length === 0}
        >
          Start {count} problems
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          onClick={onCancel}
          style={{ marginTop: 8 }}
        >
          Back
        </button>
      </div>
    </div>
  )
}
