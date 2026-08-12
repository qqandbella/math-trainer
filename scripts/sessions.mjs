/**
 * Verifies per-session review: two sessions of different kinds on one day are
 * listed separately, each expandable to the problems it contained.
 */
import { chromium } from 'playwright-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_URL = process.argv[2] ?? 'https://qqandbella.github.io/math-trainer/'
const PROFILE = mkdtempSync(join(tmpdir(), 'mt-sessions-'))
const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; throw new Error(m) }

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome' })
const page = await ctx.newPage()
page.on('pageerror', (e) => fail(`page error: ${e.message}`))

const answer = async (wrong = false) => {
  const text = (await page.locator('.problem-prompt').innerText()).trim()
  const expr = text.replace(/=$/, '').replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-').trim()
  const boxes = await page.locator('.answer-box').count()
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  if (boxes === 2) {
    const [a, b] = expr.split('/').map((s) => Number(s.trim()))
    await page.keyboard.type(String(wrong ? Math.floor(a / b) + 1 : Math.floor(a / b)))
    await page.keyboard.press('Enter')
    await page.keyboard.type(String(a % b))
  } else {
    const v = Number(new Function(`return (${expr})`)())
    await page.keyboard.type(String(wrong ? v + 1 : v))
  }
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
}

const endSession = async () => {
  await page.getByRole('button', { name: /pause/ }).click()
  await page.getByRole('button', { name: 'End session now' }).click()
  await page.getByText('Session complete').waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: 'Done' }).click()
  await page.locator('.app-title').waitFor()
}

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.locator('.app-title').waitFor({ timeout: 15000 })

  // A written practice with one deliberate mistake.
  await page.getByText('Daily Practice').first().click()
  await page.locator('.problem-prompt').waitFor({ timeout: 10000 })
  await answer(true)
  await answer()
  await answer()
  await endSession()

  // A mental challenge on the same day: a different kind of session entirely.
  await page.getByText('Mental Challenge').first().click()
  await page.getByRole('button', { name: 'Start' }).click()
  await page.locator('.problem-prompt').waitFor({ timeout: 10000 })
  await answer()
  await answer()
  await endSession()
  console.log('ok  recorded two sessions of different kinds today')

  await page.getByText('Progress').first().click()
  await page.getByRole('heading', { name: 'Progress' }).waitFor({ timeout: 5000 })

  const rows = page.locator('.session-row')
  const count = await rows.count()
  if (count !== 2) fail(`expected 2 sessions listed, saw ${count}`)
  const titles = await page.locator('.session-row-title').allInnerTexts()
  if (!titles.some((t) => t.includes('Daily Practice'))) fail('daily session not listed')
  if (!titles.some((t) => t.includes('Mental Challenge'))) fail('mental session not listed')
  console.log(`ok  both listed separately: ${titles.map((t) => t.split('\n')[0]).join(' | ')}`)

  // Mental sessions carry a score; a written practice does not.
  const mentalRow = rows.filter({ hasText: 'Mental Challenge' })
  if (!(await mentalRow.locator('.pill').first().innerText()).includes('score')) {
    fail('mental session does not show its score')
  }
  console.log('ok  the mental session shows its score')

  // Expanding shows the individual problems.
  await rows.filter({ hasText: 'Daily Practice' }).locator('.session-row-main').click()
  await page.locator('.attempt-row').first().waitFor({ timeout: 5000 })
  const attemptCount = await page.locator('.attempt-row').count()
  if (attemptCount !== 3) fail(`expected 3 problems in the daily session, saw ${attemptCount}`)
  const wrongShown = await page.locator('.attempt-row.wrong').count()
  if (wrongShown !== 1) fail(`expected 1 wrong answer highlighted, saw ${wrongShown}`)
  console.log(`ok  expanding shows all ${attemptCount} problems, 1 marked wrong`)

  console.log('\nSESSION HISTORY VERIFIED')
} finally {
  await ctx.close()
  rmSync(PROFILE, { recursive: true, force: true })
}
