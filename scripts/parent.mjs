/**
 * Exercises the parent flow end to end: the hidden gesture, TOTP enrollment,
 * unlocking, and the destructive "erase all practice data" path.
 *
 * The TOTP code is computed here with node:crypto, independently of the app's
 * Web Crypto implementation - so a passing run also cross-validates the two.
 *
 *   node scripts/parent.mjs [url]
 */
import { chromium } from 'playwright-core'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_URL = process.argv[2] ?? 'https://qqandbella.github.io/math-trainer/'
const PROFILE = mkdtempSync(join(tmpdir(), 'mt-parent-'))
const HOLD_MS = 3300

const fail = (m) => {
  console.error(`FAIL: ${m}`)
  process.exitCode = 1
  throw new Error(m)
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function base32Decode(input) {
  let bits = 0
  let value = 0
  const out = []
  for (const ch of input.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function totp(secret, atMs = Date.now()) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)))
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const bin =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  return String(bin % 1e6).padStart(6, '0')
}

async function longPressTitle(page) {
  const box = await page.locator('.app-title').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(HOLD_MS)
  await page.mouse.up()
}

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome' })
const page = await ctx.newPage()
page.on('pageerror', (e) => fail(`uncaught page error: ${e.message}`))

try {
  await page.goto(APP_URL, { waitUntil: 'networkidle' })

  /* --- create some practice data, as a parent trying the app out would ---- */
  await page.getByText('Daily Practice').first().click()
  await page.locator('.problem-prompt').waitFor()
  for (let i = 0; i < 4; i++) {
    const text = (await page.locator('.problem-prompt').innerText()).trim()
    const boxes = await page.locator('.answer-box').count()
    const expr = text
      .replace(/=$/, '')
      .replaceAll('×', '*')
      .replaceAll('÷', '/')
      .replaceAll('−', '-')
      .trim()
    if (boxes === 2) {
      const [a, b] = expr.split('/').map((s) => Number(s.trim()))
      await page.keyboard.type(String(Math.floor(a / b)))
      await page.keyboard.press('Enter')
      await page.keyboard.type(String(a % b))
    } else {
      await page.keyboard.type(String(Number(new Function(`return (${expr})`)())))
    }
    await page.keyboard.press('Enter')
    await page.waitForTimeout(120)
  }
  await page.getByRole('button', { name: /pause/ }).click()
  await page.getByRole('button', { name: 'End session now' }).click()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.locator('.app-title').waitFor()
  console.log('ok  created practice data (4 problems)')

  /* --- the hidden gesture ------------------------------------------------- */
  if (await page.getByText('Parent').isVisible().catch(() => false)) {
    fail('parent mode has a visible entry point on the dashboard')
  }
  await longPressTitle(page)
  await page.getByRole('heading', { name: 'Set up parent access' }).waitFor({ timeout: 5000 })
  console.log('ok  3-second press-and-hold on the title opens parent setup')

  /* --- enrollment, verified against an independent TOTP ------------------- */
  await page.getByText("Can't scan? Enter the code by hand").click()
  const secret = (await page.locator('.code-block').innerText()).trim()
  if (!/^[A-Z2-7]{32}$/.test(secret)) fail(`enrollment secret looks wrong: "${secret}"`)
  await page.locator('input').first().fill(totp(secret))
  await page.getByRole('button', { name: 'Confirm and unlock' }).click()
  await page.getByRole('heading', { name: 'Parent', exact: true }).waitFor({ timeout: 5000 })
  console.log('ok  enrolled; app accepted a code computed by node:crypto')
  console.log('    (independent implementations agree -> real authenticator apps will work)')

  /* --- a wrong code must be rejected -------------------------------------- */
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await longPressTitle(page)
  await page.getByRole('heading', { name: 'Parent', exact: true }).waitFor({ timeout: 5000 })
  await page.locator('input').first().fill('000000')
  await page.getByRole('button', { name: 'Unlock' }).click()
  await page.getByText('Wrong code.').waitFor({ timeout: 5000 })
  console.log('ok  a wrong code is rejected')

  /* --- unlock and erase ---------------------------------------------------- */
  await page.locator('input').first().fill(totp(secret))
  await page.getByRole('button', { name: 'Unlock' }).click()
  await page.getByRole('heading', { name: 'Parent', exact: true }).waitFor()
  const before = await page.locator('table.data tbody tr').count()
  if (before === 0) fail('parent mastery table is empty despite practice data existing')
  console.log(`ok  unlocked; mastery table lists ${before} practised skills`)

  await page.getByText('Export / import').click()
  await page.getByRole('button', { name: 'Erase all practice data' }).click()
  await page.getByRole('button', { name: 'Yes, erase everything' }).click()
  await page.getByText('All practice data erased.').waitFor({ timeout: 8000 })
  console.log('ok  erase confirmed (two-step, so it cannot be hit by accident)')

  /* --- prove it is really gone, including after a reload ------------------- */
  // Reloading on the parent route correctly re-locks it, so go to the
  // dashboard first and reload there.
  await page.goto(`${APP_URL}#/`, { waitUntil: 'domcontentloaded' })
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.app-title').waitFor({ timeout: 10000 })
  const stats = await page.locator('.stat-row').first().innerText()
  if (!/\b0\b/.test(stats) || /\b4\b/.test(stats)) {
    fail(`dashboard still shows data after erase: "${stats.replace(/\n/g, ' ')}"`)
  }
  console.log('ok  dashboard is back to zero after reload')

  await page.getByText('Progress').first().click()
  await page.getByText('No practice recorded yet.').waitFor({ timeout: 5000 })
  console.log('ok  Progress shows the empty state')

  /* --- the parent secret must SURVIVE the erase --------------------------- */
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await longPressTitle(page)
  await page.getByRole('heading', { name: 'Parent', exact: true }).waitFor({ timeout: 5000 })
  if (await page.getByText('Scan this with your authenticator app').isVisible().catch(() => false)) {
    fail('erase wiped the parent TOTP secret; setup would have to be redone')
  }
  await page.locator('input').first().fill(totp(secret))
  await page.getByRole('button', { name: 'Unlock' }).click()
  await page.getByRole('heading', { name: 'Parent', exact: true }).waitFor()
  console.log('ok  parent access still works after erase (secret and settings kept)')

  console.log('\nPARENT FLOW VERIFIED')
} finally {
  await ctx.close()
  rmSync(PROFILE, { recursive: true, force: true })
}
