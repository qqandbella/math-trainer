/**
 * Verifies the privilege model: everything basic works signed out, and parent
 * tools require an account rather than a per-device enrolment.
 */
import { chromium } from 'playwright-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_URL = process.argv[2] ?? 'https://qqandbella.github.io/math-trainer/'
const PROFILE = mkdtempSync(join(tmpdir(), 'mt-priv-'))
const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; throw new Error(m) }

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome' })
const page = await ctx.newPage()
page.on('pageerror', (e) => fail(`page error: ${e.message}`))

const holdTitle = async () => {
  const box = await page.locator('.app-title').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(1600)
  await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2 + 5)
  await page.waitForTimeout(1900)
  await page.mouse.up()
}

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.locator('.app-title').waitFor({ timeout: 15000 })

  // Basic use must work with no account at all.
  await page.getByText('Daily Practice').first().click()
  await page.locator('.problem-prompt').waitFor({ timeout: 10000 })
  console.log('ok  practice works signed out')
  await page.getByRole('button', { name: /exit/ }).click()
  await page.locator('.app-title').waitFor()

  await page.getByText('Progress').first().click()
  await page.getByRole('heading', { name: 'Progress' }).waitFor({ timeout: 5000 })
  console.log('ok  progress works signed out')
  await page.getByRole('button', { name: 'done' }).click()

  // Parent tools must ask for an account, not offer a device-local enrolment.
  await holdTitle()
  await page.getByRole('heading', { name: 'Parent tools' }).waitFor({ timeout: 5000 })
  if (await page.locator('.code-block').count()) {
    fail('offered a device-local enrolment while signed out')
  }
  if (!(await page.getByRole('button', { name: /Sign in with Google/ }).isVisible())) {
    fail('no way to sign in from parent tools')
  }
  console.log('ok  parent tools require an account, with no per-device enrolment')

  // Sync is likewise an account feature, reachable from the dashboard.
  await page.getByRole('button', { name: 'Back' }).click()
  await page.locator('.app-title').waitFor()
  await page.getByRole('button', { name: /sign in to sync/ }).click()
  await page.getByRole('heading', { name: 'Sync' }).waitFor({ timeout: 5000 })
  console.log('ok  sync is offered from the dashboard while signed out')

  console.log('\nPRIVILEGE MODEL VERIFIED')
} finally {
  await ctx.close()
  rmSync(PROFILE, { recursive: true, force: true })
}
