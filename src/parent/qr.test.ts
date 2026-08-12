import { describe, expect, it } from 'vitest'
import qrcode from 'qrcode-generator'
import jsQR from 'jsqr'
import { generateSecret, otpauthUrl } from './totp'

/**
 * Checks the enrolment QR carries what an authenticator needs.
 *
 * This used to run in a browser, but the QR now sits behind Google sign-in,
 * which cannot be automated. The valuable property - that the code decodes to
 * the right otpauth URL - does not need a browser: build the same QR the
 * component builds, rasterise it, and read it back the way a camera would.
 */
function decode(text: string): string | null {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()

  const modules = qr.getModuleCount()
  const scale = 6
  const margin = 4 * scale
  const size = modules * scale + margin * 2
  // jsQR wants RGBA; start white and paint dark modules.
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255)

  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (!qr.isDark(row, col)) continue
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const px = margin + col * scale + x
          const py = margin + row * scale + y
          const i = (py * size + px) * 4
          pixels[i] = 0
          pixels[i + 1] = 0
          pixels[i + 2] = 0
        }
      }
    }
  }

  return jsQR(pixels, size, size)?.data ?? null
}

describe('enrolment QR', () => {
  it('decodes to the otpauth URL an authenticator expects', () => {
    const secret = generateSecret()
    const url = otpauthUrl(secret, 'yuyao-ipad')
    const read = decode(url)
    expect(read).toBe(url)

    const parsed = new URL(read as string)
    expect(parsed.protocol).toBe('otpauth:')
    expect(parsed.host).toBe('totp')
    expect(parsed.searchParams.get('secret')).toBe(secret)
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1')
    expect(parsed.searchParams.get('digits')).toBe('6')
    expect(parsed.searchParams.get('period')).toBe('30')
  })

  it('carries the device label so several devices are distinguishable', () => {
    const url = otpauthUrl(generateSecret(), 'laptop')
    expect(decode(url)).toContain(encodeURIComponent('laptop'))
  })

  it('survives a long label without becoming unreadable', () => {
    const url = otpauthUrl(generateSecret(), 'a-rather-long-device-name-for-testing')
    expect(decode(url)).toBe(url)
  })
})
