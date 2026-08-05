/**
 * Verifies moving practice data between devices with Export / Import.
 *
 * Uses two completely separate browser profiles to stand in for two devices,
 * and checks the merge is idempotent - importing the same file twice must not
 * double-count a single session's work.
 *
 *   node scripts/transfer.mjs [url]
 */
import { chromium } from 'playwright-core'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_URL = process.argv[2] ?? 'https://qqandbella.github.io/math-trainer/'
const PROFILE_A = mkdtempSync(join(tmpdir(), 'mt-devA-'))
const PROFILE_B = mkdtempSync(join(tmpdir(), 'mt-devB-'))
const SOLVE = 6

const fail = (m) => {
  console.error(`FAIL: ${m}`)
  process.exitCode = 1
  throw new Error(m)
}

async function solve(page, count) {
  for (let i = 0; i < count; i++) {
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
}

async function openParent(page) {
  const box = await page.locator('.app-title').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(3300)
  await page.mouse.up()
}

let ctxA
let ctxB
let exportPath

try {
  /* ---------------- device A: practise, then export ------------------------ */
  ctxA = await chromium.launchPersistentContext(PROFILE_A, {
    channel: 'chrome',
    acceptDownloads: true,
  })
  const a = await ctxA.newPage()
  a.on('pageerror', (e) => fail(`device A page error: ${e.message}`))

  // Force the download path; on a tablet this is the OS share sheet instead.
  await a.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true })
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true })
  })

  await a.goto(APP_URL, { waitUntil: 'networkidle' })
  await a.getByText('Daily Practice').first().click()
  await a.locator('.problem-prompt').waitFor()
  await solve(a, SOLVE)
  await a.getByRole('button', { name: /pause/ }).click()
  await a.getByRole('button', { name: 'End session now' }).click()
  await a.getByRole('button', { name: 'Done' }).click()
  console.log(`ok  device A: completed a session of ${SOLVE} problems`)

  await openParent(a)
  const secretBox = a.locator('.code-block')
  if (await a.getByText("Can't scan? Enter the code by hand").isVisible().catch(() => false)) {
    await a.getByText("Can't scan? Enter the code by hand").click()
    // Fresh profile, so enroll first. Reuse the app's own code via a live read.
    const { createHmac } = await import('node:crypto')
    const secret = (await secretBox.innerText()).trim()
    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    const bytes = []
    let bits = 0
    let value = 0
    for (const ch of secret) {
      value = (value << 5) | B32.indexOf(ch)
      bits += 5
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 0xff)
        bits -= 8
      }
    }
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)))
    const d = createHmac('sha1', Buffer.from(bytes)).update(counter).digest()
    const o = d[d.length - 1] & 0x0f
    const bin =
      ((d[o] & 0x7f) << 24) | ((d[o + 1] & 0xff) << 16) | ((d[o + 2] & 0xff) << 8) | (d[o + 3] & 0xff)
    await a.locator('input').first().fill(String(bin % 1e6).padStart(6, '0'))
    await a.getByRole('button', { name: 'Confirm and unlock' }).click()
  }
  await a.getByRole('heading', { name: 'Parent', exact: true }).waitFor({ timeout: 5000 })

  await a.getByText('Export / import').click()
  const [download] = await Promise.all([
    a.waitForEvent('download', { timeout: 15000 }),
    a.getByRole('button', { name: 'Export data' }).click(),
  ])
  exportPath = join(tmpdir(), download.suggestedFilename())
  await download.saveAs(exportPath)

  const bundle = JSON.parse(readFileSync(exportPath, 'utf8'))
  if (bundle.app !== 'math-trainer') fail('export is not a math-trainer bundle')
  if (bundle.attempts.length !== SOLVE) {
    fail(`export holds ${bundle.attempts.length} attempts, expected ${SOLVE}`)
  }
  console.log(
    `ok  exported ${bundle.attempts.length} attempts / ${bundle.sessions.length} session(s) to JSON`,
  )
  await ctxA.close()

  /* ---------------- device B: a different profile entirely ----------------- */
  ctxB = await chromium.launchPersistentContext(PROFILE_B, { channel: 'chrome' })
  const b = await ctxB.newPage()
  b.on('pageerror', (e) => fail(`device B page error: ${e.message}`))
  await b.goto(APP_URL, { waitUntil: 'networkidle' })

  await b.getByText('Progress').first().click()
  await b.getByText('No practice recorded yet.').waitFor({ timeout: 5000 })
  console.log('ok  device B starts empty (confirming storage does NOT follow a Chrome profile)')
  await b.getByRole('button', { name: 'done' }).click()

  await openParent(b)
  await b.getByRole('heading', { name: 'Set up parent access' }).waitFor({ timeout: 5000 })
  console.log('ok  device B needs its own parent enrollment (secrets are per-device)')

  // Import without unlocking is impossible, so enroll on B too.
  const { createHmac } = await import('node:crypto')
  await b.getByText("Can't scan? Enter the code by hand").click()
  const secretB = (await b.locator('.code-block').innerText()).trim()
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bytesB = []
  let bitsB = 0
  let valB = 0
  for (const ch of secretB) {
    valB = (valB << 5) | B32.indexOf(ch)
    bitsB += 5
    if (bitsB >= 8) {
      bytesB.push((valB >>> (bitsB - 8)) & 0xff)
      bitsB -= 8
    }
  }
  const counterB = Buffer.alloc(8)
  counterB.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)))
  const dB = createHmac('sha1', Buffer.from(bytesB)).update(counterB).digest()
  const oB = dB[dB.length - 1] & 0x0f
  const binB =
    ((dB[oB] & 0x7f) << 24) |
    ((dB[oB + 1] & 0xff) << 16) |
    ((dB[oB + 2] & 0xff) << 8) |
    (dB[oB + 3] & 0xff)
  await b.locator('input').first().fill(String(binB % 1e6).padStart(6, '0'))
  await b.getByRole('button', { name: 'Confirm and unlock' }).click()
  await b.getByRole('heading', { name: 'Parent', exact: true }).waitFor({ timeout: 5000 })

  await b.getByText('Export / import').click()
  await b.locator('input[type=file]').setInputFiles(exportPath)
  await b.getByText(/Merged: /).waitFor({ timeout: 10000 })
  const first = await b.locator('.faint').filter({ hasText: 'Merged:' }).innerText()
  if (!first.includes(`${SOLVE} new attempts`)) fail(`unexpected merge report: "${first}"`)
  console.log(`ok  device B imported: ${first.trim()}`)

  /* ---------------- importing the same file again must be a no-op ---------- */
  await b.locator('input[type=file]').setInputFiles(exportPath)
  await b.waitForTimeout(1200)
  const second = await b.locator('.faint').filter({ hasText: 'Merged:' }).innerText()
  if (!second.includes('0 new attempts')) {
    fail(`re-import duplicated data: "${second.trim()}"`)
  }
  console.log(`ok  re-importing the same file changed nothing: ${second.trim()}`)

  await b.goto(`${APP_URL}#/`, { waitUntil: 'domcontentloaded' })
  await b.reload({ waitUntil: 'networkidle' })
  await b.getByText('Progress').first().click()
  const totals = await b.locator('.stat-row').first().innerText()
  if (!totals.includes(String(SOLVE))) {
    fail(`device B reports do not show the imported work: "${totals.replace(/\n/g, ' ')}"`)
  }
  console.log(`ok  device B Progress shows all ${SOLVE} imported problems after reload`)

  console.log('\nTRANSFER VERIFIED — export/import moves history between devices, safely repeatable')
} finally {
  await ctxA?.close().catch(() => {})
  await ctxB?.close().catch(() => {})
  rmSync(PROFILE_A, { recursive: true, force: true })
  rmSync(PROFILE_B, { recursive: true, force: true })
  if (exportPath) rmSync(exportPath, { force: true })
}
