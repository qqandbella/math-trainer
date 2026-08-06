import { describe, expect, it } from 'vitest'
import { syncOnce, clockSkewIsConcerning, CLOCK_SKEW_WARN_MS } from './engine'
import { createFakeBackend, FakeServer, MemoryLocalStore } from './fake'
import { makePurge } from '../core/tombstones'
import type { Attempt, SessionRecord } from '../core/types'

const L = 'learner-1'
const T0 = 1_800_000_000_000

function attempt(id: string, at = T0, deviceLabel = 'A'): Attempt {
  return {
    id,
    learnerId: L,
    sessionId: `sess-${deviceLabel}`,
    skillId: 'mul_3x2',
    prompt: `${id} x 2`,
    answer: 2,
    given: 2,
    correct: true,
    ms: 5000,
    at,
  }
}

function session(id: string, startedAt = T0): SessionRecord {
  return {
    id,
    learnerId: L,
    mode: 'daily',
    startedAt,
    endedAt: startedAt + 1000,
    problemCount: 1,
    attemptedCount: 1,
    correctCount: 1,
    activeMs: 5000,
    pausesUsed: 0,
    completed: true,
  }
}

interface Fixture {
  server: FakeServer
  a: MemoryLocalStore
  b: MemoryLocalStore
  syncA: () => Promise<ReturnType<typeof syncOnce> extends Promise<infer R> ? R : never>
  syncB: () => Promise<ReturnType<typeof syncOnce> extends Promise<infer R> ? R : never>
}

function twoDevices(): Fixture {
  const server = new FakeServer()
  const backend = createFakeBackend(server)
  const a = new MemoryLocalStore()
  const b = new MemoryLocalStore()
  return {
    server,
    a,
    b,
    syncA: () => syncOnce(L, backend, a, { now: () => server.clock }),
    syncB: () => syncOnce(L, backend, b, { now: () => server.clock }),
  }
}

describe('two-device convergence', () => {
  it('carries work from one device to the other', async () => {
    const { a, b, syncA, syncB } = twoDevices()
    a.record(L, attempt('a1'))
    a.record(L, session('sess-A'))

    await syncA()
    const pulled = await syncB()

    expect(pulled.pulledAttempts).toBe(1)
    expect(pulled.pulledSessions).toBe(1)
    expect([...b.attempts.keys()]).toEqual(['a1'])
  })

  it('converges when both devices practise before either syncs', async () => {
    const { a, b, syncA, syncB } = twoDevices()
    a.record(L, attempt('a1'))
    b.record(L, attempt('b1'))

    // Interleaved, as two devices coming online at once.
    await syncA()
    await syncB()
    await syncA()

    expect([...a.attempts.keys()].sort()).toEqual(['a1', 'b1'])
    expect([...b.attempts.keys()].sort()).toEqual(['a1', 'b1'])
  })

  it('reaches the same state regardless of sync order', async () => {
    const first = twoDevices()
    first.a.record(L, attempt('a1'))
    first.b.record(L, attempt('b1'))
    await first.syncA()
    await first.syncB()
    await first.syncA()

    const second = twoDevices()
    second.a.record(L, attempt('a1'))
    second.b.record(L, attempt('b1'))
    await second.syncB()
    await second.syncA()
    await second.syncB()

    expect([...first.a.attempts.keys()].sort()).toEqual([...second.a.attempts.keys()].sort())
    expect([...first.b.attempts.keys()].sort()).toEqual([...second.b.attempts.keys()].sort())
  })

  it('is a no-op when nothing changed', async () => {
    const { a, syncA } = twoDevices()
    a.record(L, attempt('a1'))
    await syncA()

    const second = await syncA()
    expect(second.pulledAttempts).toBe(0)
    expect(second.pushedRecords).toBe(0)
    expect(second.status).toBe('ok')
  })

  it('never republishes what it just received', async () => {
    const { server, a, syncA, syncB } = twoDevices()
    a.record(L, attempt('a1'))
    await syncA()
    await syncB()
    await syncB()
    // One attempt on the server, not a copy per device.
    expect(server.countOf('attempt')).toBe(1)
  })
})

describe('deletion across devices', () => {
  it('propagates an erase to a device that already holds the data', async () => {
    const { a, b, syncA, syncB } = twoDevices()
    a.record(L, attempt('a1'))
    await syncA()
    await syncB()
    expect(b.attempts.size).toBe(1)

    a.attempts.clear()
    a.record(L, makePurge(L, 'device-a', T0 + 1000))
    await syncA()

    const result = await syncB()
    expect(b.attempts.size).toBe(0)
    expect(result.pulledTombstones).toBe(1)
    expect(result.removedLocally).toBe(1)
  })

  it('refuses records that a known deletion already covers', async () => {
    const { a, b, syncA, syncB } = twoDevices()
    // B erases; A then publishes an old record it never got round to sending.
    b.record(L, makePurge(L, 'device-b', T0 + 1000))
    await syncB()

    a.record(L, attempt('stale', T0))
    await syncA()

    const result = await syncB()
    expect(b.attempts.size).toBe(0)
    expect(result.pulledAttempts).toBe(0)
  })

  it('keeps work done after the erase', async () => {
    const { a, b, syncA, syncB } = twoDevices()
    b.record(L, makePurge(L, 'device-b', T0 + 1000))
    await syncB()

    a.record(L, attempt('after', T0 + 5000))
    await syncA()
    await syncB()

    expect([...b.attempts.keys()]).toEqual(['after'])
  })

  it('applies a deletion arriving in the same pass as the records it covers', async () => {
    const { server, b, syncB } = twoDevices()
    // Both published before B has ever synced, so they arrive together.
    server.accept(L, {
      attempts: [attempt('old', T0)],
      sessions: [],
      tombstones: [makePurge(L, 'device-a', T0 + 1000)],
    })
    const result = await syncB()
    expect(b.attempts.size).toBe(0)
    expect(result.pulledAttempts).toBe(0)
  })
})

describe('failure handling', () => {
  it('reports offline and loses nothing', async () => {
    const server = new FakeServer()
    const backend = createFakeBackend(server, { failPull: new Error('network unavailable') })
    const local = new MemoryLocalStore()
    local.record(L, attempt('a1'))

    const result = await syncOnce(L, backend, local)
    expect(result.status).toBe('offline')
    expect(local.attempts.size).toBe(1)
    expect(await local.outbox(L)).toEqual(['a1'])
  })

  it('retries a failed push on the next sync', async () => {
    const server = new FakeServer()
    const faults = { failPush: new Error('network unavailable') as Error | null }
    const backend = createFakeBackend(server, faults)
    const local = new MemoryLocalStore()
    local.record(L, attempt('a1'))

    const failed = await syncOnce(L, backend, local)
    expect(failed.status).toBe('offline')
    expect(server.countOf('attempt')).toBe(0)
    // The queue must survive, or the work is stranded on this device forever.
    expect(await local.outbox(L)).toEqual(['a1'])

    faults.failPush = null
    const ok = await syncOnce(L, backend, local)
    expect(ok.status).toBe('ok')
    expect(server.countOf('attempt')).toBe(1)
  })

  it('distinguishes a real error from being offline', async () => {
    const server = new FakeServer()
    const backend = createFakeBackend(server, { failPull: new Error('permission denied') })
    const result = await syncOnce(L, backend, new MemoryLocalStore())
    expect(result.status).toBe('error')
    expect(result.error).toContain('permission denied')
  })
})

describe('cursor handling', () => {
  it('catches a write that landed behind the cursor', async () => {
    const server = new FakeServer()
    const backend = createFakeBackend(server)
    const b = new MemoryLocalStore()

    server.accept(L, { attempts: [attempt('first')], sessions: [], tombstones: [] })
    await syncOnce(L, backend, b)
    const cursor = await b.getCursor(L)
    expect(b.attempts.size).toBe(1)

    // A concurrent commit assigned a position *behind* the cursor already read.
    server.acceptAtPosition(L, cursor - 1, {
      attempts: [attempt('straggler')],
      sessions: [],
      tombstones: [],
    })

    // Without an overlap window this record would never be seen again.
    const result = await syncOnce(L, backend, b, { overlapMs: 10 })
    expect(result.pulledAttempts).toBe(1)
    expect([...b.attempts.keys()].sort()).toEqual(['first', 'straggler'])
  })

  it('a device joining late receives the whole history', async () => {
    const { a, b, syncA, syncB } = twoDevices()
    for (let i = 0; i < 25; i++) a.record(L, attempt(`a${i}`, T0 + i))
    await syncA()

    const result = await syncB()
    expect(result.pulledAttempts).toBe(25)
    expect(b.attempts.size).toBe(25)
  })
})

describe('clock skew', () => {
  it('measures the device clock against the server', async () => {
    const server = new FakeServer()
    const backend = createFakeBackend(server)
    const local = new MemoryLocalStore()
    const result = await syncOnce(L, backend, local, {
      now: () => server.clock + 10 * 60 * 1000,
    })
    expect(result.clockSkewMs).toBe(10 * 60 * 1000)
    expect(clockSkewIsConcerning(result.clockSkewMs)).toBe(true)
  })

  it('tolerates ordinary drift', () => {
    expect(clockSkewIsConcerning(CLOCK_SKEW_WARN_MS - 1)).toBe(false)
    expect(clockSkewIsConcerning(-(CLOCK_SKEW_WARN_MS - 1))).toBe(false)
  })
})
