import type { Learner } from '../core/types'

/**
 * Which learner an account's devices should all agree on.
 *
 * Each device mints its own learner id the first time it runs, and sync is
 * scoped per learner (`households/{uid}/learners/{learnerId}/attempts`). Left
 * alone, two devices on one account read and write in separate namespaces and
 * neither ever sees the other's practice - which is exactly the "synced 0
 * records" case.
 *
 * The rule has to be a pure function of the learner list, so that devices
 * reconciling independently, in any order, reach the same answer. Oldest wins:
 * it is stable, and it keeps the id that most likely already carries history.
 * The id breaks ties so two learners created in the same millisecond still
 * converge.
 */
export function canonicalLearner(learners: readonly Learner[]): Learner | null {
  if (learners.length === 0) return null
  return [...learners].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0] as Learner
}

/**
 * Publishes this device's learner, then reports the id every device will use.
 *
 * Publishing comes first and happens unconditionally: a device that has only
 * ever pushed attempts has no learner document, because writing to a
 * subcollection does not create its parent. Without this it stays invisible to
 * every other device, which would then adopt the wrong id.
 */
export async function reconcileLearner(mine: Learner): Promise<string> {
  const { fetchAccountLearners, publishLearner } = await import('./account')
  await publishLearner(mine)
  const learners = await fetchAccountLearners()
  return canonicalLearner(learners.length > 0 ? learners : [mine])?.id ?? mine.id
}
