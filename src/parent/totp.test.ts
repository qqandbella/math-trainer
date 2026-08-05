import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, generateSecret, totpCode, verifyTotp } from './totp'

// RFC 6238 Appendix B, SHA-1 suite. The published values are 8 digits; a
// 6-digit TOTP is the same truncation modulo 10^6, i.e. the last six digits.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' // ASCII "12345678901234567890"

describe('totp', () => {
  it('matches the RFC 6238 SHA-1 test vectors', async () => {
    const cases: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ]
    for (const [seconds, expected] of cases) {
      expect(await totpCode(RFC_SECRET, seconds * 1000)).toBe(expected)
    }
  })

  it('accepts the current code and rejects a stale one', async () => {
    const now = 1_700_000_000_000
    const code = await totpCode(RFC_SECRET, now)
    expect(await verifyTotp(code, RFC_SECRET, now)).toBe(true)
    // Five steps away is well outside the tolerance window.
    expect(await verifyTotp(code, RFC_SECRET, now + 5 * 30_000)).toBe(false)
  })

  it('tolerates one step of clock drift in either direction', async () => {
    const now = 1_700_000_000_000
    const code = await totpCode(RFC_SECRET, now)
    expect(await verifyTotp(code, RFC_SECRET, now + 30_000)).toBe(true)
    expect(await verifyTotp(code, RFC_SECRET, now - 30_000)).toBe(true)
  })

  it('rejects malformed input without throwing', async () => {
    const now = 1_700_000_000_000
    expect(await verifyTotp('', RFC_SECRET, now)).toBe(false)
    expect(await verifyTotp('12345', RFC_SECRET, now)).toBe(false)
    expect(await verifyTotp('abcdef', RFC_SECRET, now)).toBe(false)
  })

  it('round-trips base32', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64, 7])
    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes])
  })

  it('generates distinct 32-character secrets', () => {
    const a = generateSecret()
    const b = generateSecret()
    expect(a).toHaveLength(32)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Z2-7]+$/)
  })
})
