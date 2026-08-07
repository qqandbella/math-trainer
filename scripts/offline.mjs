/**
 * Verifies the car scenario: install once with network, then work entirely
 * without it.
 *
 * Uses a persistent browser profile and a full browser restart, so the second
 * phase is a genuine cold start - service worker served from disk, no warm page
 * in memory - which is what actually happens when the iPad is opened in a car.
 *
 *   node scripts/offline.mjs [url]
 */
import { chromium } from 'playwright-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_URL = process.argv[2] ?? process.env.SMOKE_URL ?? 'https://qqandbella.github.io/math-trainer/'
const PROFILE = mkdtempSync(join(tmpdir(), 'mt-profile-'))
const SOLVE = 8

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

const evaluate = (text) => {
  const expr = text
    .replace(/=$/, '')
    .replaceAll('×', '*')
    .replaceAll('÷', '/')
    .replaceAll('−', '-')
    .trim()
  return { expr, value: Number(new Function(`return (${expr})`)()) }
}

async function solve(page, count) {
  for (let i = 0; i < count; i++) {
    const text = (await page.locator('.problem-prompt').innerText()).trim()
    const boxes = await page.locator('.answer-box').count()
    const { expr, value } = evaluate(text)
    if (boxes === 2) {
      const [a, b] = expr.split('/').map((s) => Number(s.trim()))
      await page.keyboard.type(String(Math.floor(a / b)))
      await page.keyboard.press('Enter')
      await page.keyboard.type(String(a % b))
      await page.keyboard.press('Enter')
    } else {
      await page.keyboard.type(String(value))
      await page.keyboard.press('Enter')
    }
    await page.waitForFunction(
      (n) => document.querySelector('.session-top span')?.textContent?.trim().startsWith(String(n)),
      i + 2,
      { timeout: 5000 },
    )
  }
}

try {
  /* ---------- phase 1: one online visit, as if setting it up at home ------- */
  let ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome' })
  let page = await ctx.newPage()

  const appOrigin = new URL(APP_URL).origin
  const external = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (url.origin !== appOrigin && url.protocol !== 'data:') external.push(r.url())
  })

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    return { scope: reg.scope, active: !!reg.active }
  })
  if (!sw.active) fail('service worker never activated')
  console.log(`ok  installed online; service worker active at ${sw.scope}`)

  // Any third-party request is a hard dependency on the network at runtime.
  if (external.length > 0) {
    fail(`app requests external origins, which will fail offline: ${external.join(', ')}`)
  }
  console.log('ok  zero external requests (no CDN, fonts or analytics to fail offline)')

  await ctx.close()
  console.log('ok  browser fully closed (service worker now only on disk)')

  /* ---------- phase 2: cold start with no network at all ------------------- */
  ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', offline: true })
  page = await ctx.newPage()
  page.on('pageerror', (e) => fail(`uncaught page error offline: ${e.message}`))

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.locator('.app-title').waitFor({ timeout: 15000 })
  const cards = await page.locator('.mode-card').count()
  if (cards < 5) fail(`expected 5 mode cards offline, saw ${cards}`)
  console.log('ok  COLD START with no network: dashboard and all 5 modes render')

  await page.getByText('Daily Practice').first().click()
  await page.locator('.problem-prompt').waitFor({ timeout: 10000 })
  console.log('ok  new session generated offline (problems are made on-device)')

  await solve(page, SOLVE)
  console.log(`ok  solved ${SOLVE} problems offline`)

  await page.getByRole('button', { name: /pause/ }).click()
  await page.getByRole('button', { name: 'End session now' }).click()
  await page.getByText('Session complete').waitFor()
  const summary = await page.locator('.stat-row').first().innerText()
  if (!summary.includes(`${SOLVE}/${SOLVE}`)) {
    fail(`offline grading wrong: "${summary.replace(/\n/g, ' ')}"`)
  }
  console.log('ok  graded offline and summary correct')

  await page.getByRole('button', { name: 'Done' }).click()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.app-title').waitFor({ timeout: 15000 })
  await page.getByText('Progress').first().click()
  await page.getByRole('heading', { name: 'Progress' }).waitFor()
  const totals = await page.locator('.stat-row').first().innerText()
  if (!totals.includes(String(SOLVE))) {
    fail(`offline reports lost the session: "${totals.replace(/\n/g, ' ')}"`)
  }
  console.log('ok  results persisted offline and show in Progress after reload')

  // Mental Challenge is the other mode she is likely to reach for in a car.
  await page.getByRole('button', { name: 'done' }).click()
  await page.getByText('Mental Challenge').first().click()
  await page.getByRole('button', { name: 'Start' }).click()
  await page.locator('.problem-prompt').waitFor({ timeout: 10000 })
  console.log('ok  Mental Challenge starts offline too')

  /* --- phase 3: session interrupted without finishing (tab discarded) ------ */
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.getByText('Daily Practice').first().click()
  await page.locator('.problem-prompt').waitFor({ timeout: 10000 })
  const INTERRUPTED = 5
  await solve(page, INTERRUPTED)

  // Simulate what iOS actually does to a backgrounded tab: signal pagehide,
  // then discard it. No "end session", no user action.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await page.waitForTimeout(150)
  await page.close()
  page = await ctx.newPage()
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.locator('.app-title').waitFor({ timeout: 15000 })
  await page.getByText('Progress').first().click()
  await page.getByRole('heading', { name: 'Progress' }).waitFor()
  const afterCrash = await page.locator('.stat-row').first().innerText()
  const expected = SOLVE + INTERRUPTED
  if (!afterCrash.includes(String(expected))) {
    fail(
      `work from an interrupted session was lost: expected ${expected} problems, ` +
        `saw "${afterCrash.replace(/\n/g, ' ')}"`,
    )
  }
  console.log(
    `ok  ${INTERRUPTED} problems from a killed mid-session survived (${expected} total)`,
  )

  await ctx.close()
  console.log('\nOFFLINE VERIFIED — usable in a car with no connectivity')
} finally {
  rmSync(PROFILE, { recursive: true, force: true })
}
