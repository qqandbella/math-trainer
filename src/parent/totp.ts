/**
 * RFC 6238 TOTP over Web Crypto.
 *
 * The parent gate uses a time-based code rather than a password because the
 * threat model is a bright kid who watches you type. A password is memorised
 * on first sighting; a 30-second code is worthless the moment it is seen.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_SECONDS = 30
const DIGITS = 6

export function generateSecret(byteLength = 20): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base32Encode(bytes)
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key.slice().buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, message.slice().buffer as ArrayBuffer)
  return new Uint8Array(sig)
}

function counterBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8)
  let remaining = counter
  for (let i = 7; i >= 0; i--) {
    bytes[i] = remaining & 0xff
    remaining = Math.floor(remaining / 256)
  }
  return bytes
}

export async function totpCode(secretBase32: string, atMs: number = Date.now()): Promise<string> {
  const key = base32Decode(secretBase32)
  if (key.length === 0) throw new Error('TOTP secret is empty or malformed')
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS)
  const digest = await hmacSha1(key, counterBytes(counter))
  const offset = (digest[digest.length - 1] as number) & 0x0f
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff)
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0')
}

/**
 * Accepts the neighbouring steps too, so a device clock that drifts by a few
 * seconds does not lock the parent out of their own reports.
 */
export async function verifyTotp(
  input: string,
  secretBase32: string,
  atMs: number = Date.now(),
  windowSteps = 1,
): Promise<boolean> {
  const candidate = input.replace(/\D/g, '')
  if (candidate.length !== DIGITS) return false
  for (let step = -windowSteps; step <= windowSteps; step++) {
    const code = await totpCode(secretBase32, atMs + step * STEP_SECONDS * 1000)
    if (timingSafeEqual(code, candidate)) return true
  }
  return false
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function otpauthUrl(secret: string, account = 'parent', issuer = 'Math Trainer'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

export function secondsRemaining(atMs: number = Date.now()): number {
  return STEP_SECONDS - Math.floor(atMs / 1000) % STEP_SECONDS
}
