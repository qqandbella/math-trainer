import type { Op, Skill, SkillStat } from './types'
import type { OpMix, ScoringConfig, SelectionConfig } from '../curriculum'
import type { Rng } from './rng'
import { computeMastery } from './mastery'

export interface SelectionContext {
  stats: Map<string, SkillStat>
  now: number
  rng: Rng
  selection: SelectionConfig
  scoring: ScoringConfig
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Weighted sampling with replacement, capped so no single skill can swallow
 * the session. A capped skill's weight drops to zero rather than being removed,
 * so the cap degrades gracefully when the pool is small.
 */
function weightedDraw(
  pool: readonly Skill[],
  weightOf: (s: Skill) => number,
  count: number,
  rng: Rng,
  maxPerSkill: number,
): Skill[] {
  if (pool.length === 0 || count <= 0) return []
  const picked: Skill[] = []
  const used = new Map<string, number>()
  let cap = Math.max(1, maxPerSkill)

  while (picked.length < count) {
    const weights = pool.map((s) =>
      (used.get(s.id) ?? 0) >= cap ? 0 : Math.max(0.0001, weightOf(s)),
    )
    const total = weights.reduce((sum, w) => sum + w, 0)
    if (total <= 0) {
      // Everything is capped; loosen rather than return a short session.
      cap += Math.max(1, Math.ceil(maxPerSkill / 2))
      continue
    }
    let r = rng.next() * total
    let chosen = pool[pool.length - 1] as Skill
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i] as number
      if (r <= 0) {
        chosen = pool[i] as Skill
        break
      }
    }
    picked.push(chosen)
    used.set(chosen.id, (used.get(chosen.id) ?? 0) + 1)
  }
  return picked
}

/** Splits a total into shares without drift, using largest-remainder. */
function apportion(total: number, shares: readonly number[]): number[] {
  const exact = shares.map((s) => s * total)
  const floors = exact.map(Math.floor)
  let remaining = total - floors.reduce((a, b) => a + b, 0)
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac)
  const out = floors.slice()
  for (const { index } of order) {
    if (remaining <= 0) break
    out[index] = (out[index] as number) + 1
    remaining--
  }
  return out
}

/**
 * Picks `count` skills from `pool`, blending three intents:
 *   - weakest:  where practice pays off most right now
 *   - review:   skills gone stale, to stop mastery decaying silently
 *   - new:      the next rung up, so the ladder keeps moving
 */
export function selectSkills(
  pool: readonly Skill[],
  count: number,
  ctx: SelectionContext,
): Skill[] {
  if (pool.length === 0 || count <= 0) return []
  const { stats, now, rng, selection, scoring } = ctx
  const maxPerSkill = Math.max(1, Math.round(count * selection.maxShareOfSessionPerSkill))

  const seen: Skill[] = []
  const unseen: Skill[] = []
  for (const skill of pool) {
    const stat = stats.get(skill.id)
    if (!stat || stat.attempts === 0) unseen.push(skill)
    else seen.push(skill)
  }

  const staleCutoff = now - selection.reviewStaleDays * DAY_MS
  const stale = seen.filter((s) => (stats.get(s.id)?.lastPracticedAt ?? 0) < staleCutoff)

  let [wantWeak, wantReview, wantNew] = apportion(count, [
    selection.weakestShare,
    selection.reviewShare,
    selection.newShare,
  ]) as [number, number, number]

  // Redistribute any share whose bucket is empty, so the session is never short.
  if (unseen.length === 0) {
    wantWeak += wantNew
    wantNew = 0
  }
  if (stale.length === 0) {
    wantWeak += wantReview
    wantReview = 0
  }
  if (seen.length === 0) {
    wantNew += wantWeak
    wantWeak = 0
  }

  const masteryOf = (s: Skill): number => {
    const m = computeMastery(stats.get(s.id), s, scoring)
    return m.rated ? m.score : selection.unratedMasteryAssumption
  }

  const weak = weightedDraw(
    seen,
    (s) => Math.max(1, 100 - masteryOf(s)),
    wantWeak,
    rng,
    maxPerSkill,
  )

  const review = weightedDraw(
    stale,
    (s) => {
      const last = stats.get(s.id)?.lastPracticedAt ?? 0
      return Math.max(1, (now - last) / DAY_MS)
    },
    wantReview,
    rng,
    maxPerSkill,
  )

  // Introduce unseen skills from the bottom of the ladder up.
  const ladder = unseen.slice().sort((a, b) => a.tier - b.tier)
  const fresh = weightedDraw(
    ladder,
    (s) => 1 / s.tier,
    wantNew,
    rng,
    Math.max(1, Math.ceil(maxPerSkill / 2)),
  )

  return spread(rng.shuffle([...weak, ...review, ...fresh]))
}

/**
 * Nudges the order so the same skill rarely appears three times in a row -
 * a run of identical shapes reads as a bug and encourages pattern-matching
 * instead of calculating.
 */
function spread(items: Skill[]): Skill[] {
  const out = items.slice()
  for (let i = 2; i < out.length; i++) {
    const a = out[i] as Skill
    if (a.id !== (out[i - 1] as Skill).id || a.id !== (out[i - 2] as Skill).id) continue
    const swapWith = out.findIndex((s, j) => j > i && s.id !== a.id)
    if (swapWith === -1) break
    out[i] = out[swapWith] as Skill
    out[swapWith] = a
  }
  return out
}

/** Builds a session honouring an operation mix, e.g. 10 add / 20 mul / ... */
export function selectByMix(
  pool: readonly Skill[],
  mix: OpMix,
  totalCount: number,
  ctx: SelectionContext,
): Skill[] {
  const entries = Object.entries(mix).filter(([, n]) => (n ?? 0) > 0) as [Op, number][]
  const weightTotal = entries.reduce((sum, [, n]) => sum + n, 0)
  if (weightTotal === 0) return []

  const counts = apportion(
    totalCount,
    entries.map(([, n]) => n / weightTotal),
  )

  const out: Skill[] = []
  entries.forEach(([op], index) => {
    const opPool = pool.filter((s) => s.op === op)
    out.push(...selectSkills(opPool, counts[index] as number, ctx))
  })

  // If an op contributed nothing (its pool was filtered away), top up from the
  // whole pool rather than handing back a short session.
  if (out.length < totalCount) {
    out.push(...selectSkills(pool, totalCount - out.length, ctx))
  }
  return spread(ctx.rng.shuffle(out))
}
