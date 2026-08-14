import { describe, expect, it } from 'vitest'
import { syncOnce } from './engine'
import { createFakeBackend, FakeServer, MemoryLocalStore } from './fake'
import { canonicalLearner } from './learner'
import type { Attempt, Learner, SessionRecord } from '../core/types'

/**
 * The defect this covers: two devices signed into one account synced nothing
 * to each other, because each had minted its own learner id on first run and
 * sync is scoped per learner. Every existing engine test shared one id, which
 * is precisely why none of them caught it.
 */

const T0 = 1_800_000_000_000

function attempt(id: string, learnerId: string): Attempt {
  return {
    id,
    learnerId,
    sessionId: `sess-${id}`,
    skillId: 'mul_3x2',
    prompt: `${id} x 2`,
    answer: 2,
    given: 2,
    correct: true,
    ms: 5000,
    at: T0,
  }
}

function session(id: string, learnerId: string): SessionRecord {
  return {
    id,
    learnerId,
    mode: 'daily',
    startedAt: T0,
    endedAt: T0 + 1000,
    problemCount: 1,
    attemptedCount: 1,
    correctCount: 1,
    activeMs: 5000,
    pausesUsed: 0,
    completed: true,
  }
}

/** What a device does on sign-in: adopt the agreed id and re-queue its work. */
function adopt(store: MemoryLocalStore, from: string, to: string): void {
  const records = [
    ...store.attempts.values(),
    ...store.sessions.values(),
    ...store.tombstones.values(),
  ]
  store.attempts.clear()
  store.sessions.clear()
  store.tombstones.clear()
  void store.clearOutbox(from, records.map((r) => r.id))
  for (const record of records) store.record(to, { ...record, learnerId: to })
}

describe('a second device joining an account', () => {
  it('sees nothing at all while the two devices disagree on the learner', async () => {
    const server = new FakeServer()
    const backend = createFakeBackend(server)
    const laptop = new MemoryLocalStore()
    const phone = new MemoryLocalStore()

    laptop.record('laptop-learner', attempt('a1', 'laptop-learner'))
    laptop.record('laptop-learner', session('sess-a1', 'laptop-learner'))
    await syncOnce('laptop-learner', backend, laptop, { now: () => server.clock })

    const pulled = await syncOnce('phone-learner', backend, phone, {
      now: () => server.clock,
    })
    expect(pulled.pulledAttempts + pulled.pulledSessions).toBe(0)
    expect(await phone.loadSessions()).toEqual([])
  })

  it('receives the whole history once both agree on one learner', async () => {
    const server = new FakeServer()
    const backend = createFakeBackend(server)
    const laptop = new MemoryLocalStore()
    const phone = new MemoryLocalStore()

    const laptopLearner: Learner = { id: 'laptop-learner', name: 'Y', createdAt: T0 }
    const phoneLearner: Learner = { id: 'phone-learner', name: 'Y', createdAt: T0 + 86_400_000 }

    laptop.record(laptopLearner.id, attempt('a1', laptopLearner.id))
    laptop.record(laptopLearner.id, session('sess-a1', laptopLearner.id))
    await syncOnce(laptopLearner.id, backend, laptop, { now: () => server.clock })

    // The phone had already practised on its own before signing in; that work
    // must survive adoption rather than be stranded under the discarded id.
    phone.record(phoneLearner.id, attempt('b1', phoneLearner.id))
    phone.record(phoneLearner.id, session('sess-b1', phoneLearner.id))

    const agreed = canonicalLearner([laptopLearner, phoneLearner])?.id as string
    expect(agreed).toBe(laptopLearner.id)
    adopt(phone, phoneLearner.id, agreed)

    const result = await syncOnce(agreed, backend, phone, { now: () => server.clock })
    expect(result.pulledAttempts + result.pulledSessions).toBe(2)
    expect(result.pushedRecords).toBe(2)

    const ids = (await phone.loadAttempts()).map((a) => a.id).sort()
    expect(ids).toEqual(['a1', 'b1'])
    for (const a of await phone.loadAttempts()) expect(a.learnerId).toBe(agreed)

    // And the laptop now sees the phone's work, in the same namespace.
    const back = await syncOnce(agreed, backend, laptop, { now: () => server.clock })
    expect(back.pulledAttempts + back.pulledSessions).toBe(2)
    expect((await laptop.loadAttempts()).map((a) => a.id).sort()).toEqual(['a1', 'b1'])
  })

  it('converges even when the phone signs in first', async () => {
    const server = new FakeServer()
    const backend = createFakeBackend(server)
    const laptop = new MemoryLocalStore()
    const phone = new MemoryLocalStore()

    const laptopLearner: Learner = { id: 'laptop-learner', name: 'Y', createdAt: T0 }
    const phoneLearner: Learner = { id: 'phone-learner', name: 'Y', createdAt: T0 + 86_400_000 }

    laptop.record(laptopLearner.id, attempt('a1', laptopLearner.id))
    phone.record(phoneLearner.id, attempt('b1', phoneLearner.id))

    // Phone reconciles when it is the only learner the account knows about, so
    // it keeps its own id and pushes under it.
    const phoneFirst = canonicalLearner([phoneLearner])?.id as string
    expect(phoneFirst).toBe(phoneLearner.id)
    await syncOnce(phoneFirst, backend, phone, { now: () => server.clock })

    // The laptop then publishes, both are visible, and oldest wins - so the
    // phone has to move again on its next sign-in.
    const agreed = canonicalLearner([laptopLearner, phoneLearner])?.id as string
    expect(agreed).toBe(laptopLearner.id)
    await syncOnce(agreed, backend, laptop, { now: () => server.clock })

    adopt(phone, phoneLearner.id, agreed)
    await syncOnce(agreed, backend, phone, { now: () => server.clock })
    await syncOnce(agreed, backend, laptop, { now: () => server.clock })

    expect((await laptop.loadAttempts()).map((a) => a.id).sort()).toEqual(['a1', 'b1'])
    expect((await phone.loadAttempts()).map((a) => a.id).sort()).toEqual(['a1', 'b1'])
  })
})
