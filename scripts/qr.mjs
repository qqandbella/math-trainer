/**
 * Decodes the enrollment QR the way a phone camera would, and checks it
 * carries exactly the otpauth:// URL the app intends.
 *
 * A QR that renders but encodes the wrong thing is worse than no QR at all -
 * it fails at the moment someone is standing there with a phone.
 *
 *   node scripts/qr.mjs [url]
 */
import { chromium } from 'playwright-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_URL = process.argv[2] ?? 'https://qqandbella.github.io/math-trainer/'
const PROFILE = mkdtempSync(join(tmpdir(), 'mt-qr-'))
const JSQR = join(process.cwd(), 'node_modules', 'jsqr', 'dist', 'jsQR.js')

const fail = (m) => {
  console.error(`FAIL: ${m}`)
  process.exitCode = 1
  throw new Error(m)
}

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome' })
const page = await ctx.newPage()
page.on('pageerror', (e) => fail(`page error: ${e.message}`))

try {
  await page.goto(APP_URL, { waitUntil: 'networkidle' })

  const box = await page.locator('.app-title').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(3300)
  await page.mouse.up()
  await page.getByRole('heading', { name: 'Set up parent access' }).waitFor({ timeout: 5000 })

  const qr = page.locator('.qr-wrap svg')
  if (!(await qr.isVisible())) fail('no QR code rendered on the enrollment screen')
  console.log('ok  QR code is rendered on the enrollment screen')

  // The hand-entry fallback must still exist, behind a disclosure.
  await page.getByText("Can't scan? Enter the code by hand").click()
  const secret = (await page.locator('.code-block').innerText()).trim()
  if (!/^[A-Z2-7]{32}$/.test(secret)) fail(`fallback secret malformed: "${secret}"`)
  console.log('ok  hand-entry fallback still available behind a disclosure')

  await page.addScriptTag({ path: JSQR })

  // Rasterise the SVG and decode it exactly as a camera would see it.
  const decoded = await page.evaluate(async () => {
    const svg = document.querySelector('.qr-wrap svg')
    const xml = new XMLSerializer().serializeToString(svg)
    const img = new Image()
    img.src = `data:image/svg+xml;base64,${btoa(xml)}`
    await img.decode()
    const size = 420
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const c = canvas.getContext('2d')
    c.fillStyle = '#fff'
    c.fillRect(0, 0, size, size)
    c.drawImage(img, 0, 0, size, size)
    const pixels = c.getImageData(0, 0, size, size)
    return window.jsQR(pixels.data, pixels.width, pixels.height)?.data ?? null
  })

  if (!decoded) fail('QR code could not be decoded at all')
  console.log(`ok  decoded: ${decoded.slice(0, 46)}...`)

  const url = new URL(decoded)
  if (url.protocol !== 'otpauth:') fail(`wrong scheme: ${url.protocol}`)
  if (url.host !== 'totp') fail(`wrong otpauth type: ${url.host}`)
  const params = url.searchParams
  const checks = [
    ['secret', secret],
    ['issuer', 'Math Trainer'],
    ['algorithm', 'SHA1'],
    ['digits', '6'],
    ['period', '30'],
  ]
  for (const [key, want] of checks) {
    if (params.get(key) !== want) {
      fail(`QR parameter ${key} is "${params.get(key)}", expected "${want}"`)
    }
  }
  console.log('ok  QR carries the same secret shown as fallback, SHA1/6 digits/30s')
  console.log('    (matches what Google Authenticator and 1Password expect)')

  console.log('\nQR VERIFIED — scannable and correct')
} finally {
  await ctx.close()
  rmSync(PROFILE, { recursive: true, force: true })
}
