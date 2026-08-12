import raw from './curriculum.json'
import type { Op, Skill, SkillFeature, SkillGroup } from '../core/types'

export interface ScoringConfig {
  ewmaAlpha: number
  minAttemptsToRate: number
  accuracyExponent: number
  speedCap: number
  recentWindow: number
}

export interface SelectionConfig {
  weakestShare: number
  reviewShare: number
  newShare: number
  reviewStaleDays: number
  maxShareOfSessionPerSkill: number
  unratedMasteryAssumption: number
}

export interface SessionConfig {
  defaultPauseBudget: number
  maxPauseSeconds: number
  revealAnswersDuringSession: boolean
}

export type OpMix = Partial<Record<Op, number>>

export interface DailyPreset {
  label: string
  problemCount: number
  /** Offered in parent settings; the session uses whichever is chosen. */
  countChoices: number[]
  mix: OpMix
}

export interface TimedPreset {
  label: string
  durationSec: number
  mix: OpMix
}

export interface MentalPreset {
  label: string
  durationSec: number
  durationChoices: number[]
  skipPenaltyDivisor: number
}

export interface Curriculum {
  version: number
  scoring: ScoringConfig
  selection: SelectionConfig
  session: SessionConfig
  presets: { daily: DailyPreset; timed: TimedPreset; mental: MentalPreset }
  skills: Skill[]
}

const OPS: readonly Op[] = ['add', 'sub', 'mul', 'div', 'mixed']
const GROUPS: readonly SkillGroup[] = [
  'Addition',
  'Subtraction',
  'Multiplication',
  'Division',
  'Mixed',
  'Mental',
]
const FEATURES: readonly SkillFeature[] = [
  'carry',
  'no_carry',
  'borrow',
  'borrow_zero',
  'exact',
  'remainder',
  'trailing_zeros',
  'precedence',
  'parens',
  'three_terms',
]

class CurriculumError extends Error {
  constructor(message: string) {
    super(`curriculum.json: ${message}`)
    this.name = 'CurriculumError'
  }
}

/**
 * Validates the hand-edited config at startup. This exists because the config
 * is meant to be edited by hand (and by an agent) - a typo should surface as a
 * loud, specific error rather than a skill that silently never generates.
 */
function validate(input: unknown): Curriculum {
  const c = input as Curriculum
  if (!c || typeof c !== 'object') throw new CurriculumError('not an object')
  if (!Array.isArray(c.skills) || c.skills.length === 0) {
    throw new CurriculumError('skills must be a non-empty array')
  }

  const seen = new Set<string>()
  for (const s of c.skills) {
    const where = `skill "${s?.id ?? '<missing id>'}"`
    if (!s.id || typeof s.id !== 'string') throw new CurriculumError(`${where}: missing id`)
    if (seen.has(s.id)) throw new CurriculumError(`duplicate skill id "${s.id}"`)
    seen.add(s.id)

    if (!OPS.includes(s.op)) throw new CurriculumError(`${where}: bad op "${s.op}"`)
    if (!GROUPS.includes(s.group)) throw new CurriculumError(`${where}: bad group "${s.group}"`)
    for (const f of s.features) {
      if (!FEATURES.includes(f)) throw new CurriculumError(`${where}: unknown feature "${f}"`)
    }
    if (!Number.isInteger(s.digitsA) || s.digitsA < 1 || s.digitsA > 6) {
      throw new CurriculumError(`${where}: digitsA must be 1-6`)
    }
    if (!Number.isInteger(s.digitsB) || s.digitsB < 1 || s.digitsB > 6) {
      throw new CurriculumError(`${where}: digitsB must be 1-6`)
    }
    if (s.op === 'sub' && s.digitsA < s.digitsB) {
      throw new CurriculumError(`${where}: subtraction needs digitsA >= digitsB`)
    }
    if (s.op === 'div' && s.digitsA <= s.digitsB) {
      throw new CurriculumError(`${where}: division needs digitsA > digitsB`)
    }
    if (s.features.includes('borrow_zero') && s.digitsA < 3) {
      throw new CurriculumError(`${where}: borrow_zero needs at least 3 digits`)
    }
    if (!(s.targetSec > 0)) throw new CurriculumError(`${where}: targetSec must be > 0`)
    if (!(s.weight >= 1)) throw new CurriculumError(`${where}: weight must be >= 1`)
    if (!Number.isInteger(s.tier) || s.tier < 1) throw new CurriculumError(`${where}: bad tier`)
  }

  const shares =
    c.selection.weakestShare + c.selection.reviewShare + c.selection.newShare
  if (Math.abs(shares - 1) > 0.001) {
    throw new CurriculumError(
      `selection shares must sum to 1, got ${shares.toFixed(3)}`,
    )
  }

  for (const [name, mix] of Object.entries({
    daily: c.presets.daily.mix,
    timed: c.presets.timed.mix,
  })) {
    for (const op of Object.keys(mix)) {
      if (!OPS.includes(op as Op)) {
        throw new CurriculumError(`preset "${name}" mix has unknown op "${op}"`)
      }
      if (!c.skills.some((s) => !s.mental && s.op === op)) {
        throw new CurriculumError(
          `preset "${name}" wants op "${op}" but no non-mental skill provides it`,
        )
      }
    }
  }

  if (!c.skills.some((s) => s.mental)) {
    throw new CurriculumError('at least one mental skill is required')
  }

  return c
}

export const curriculum: Curriculum = validate(raw)

export const skills: Skill[] = curriculum.skills
export const practiceSkills: Skill[] = skills.filter((s) => !s.mental)
export const mentalSkills: Skill[] = skills.filter((s) => s.mental)

const byId = new Map(skills.map((s) => [s.id, s]))

export function getSkill(id: string): Skill | undefined {
  return byId.get(id)
}

/** Throws when a skill id from stored history is no longer in the config. */
export function requireSkill(id: string): Skill {
  const s = byId.get(id)
  if (!s) throw new Error(`unknown skill id "${id}"`)
  return s
}
