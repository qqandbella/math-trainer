/**
 * Verifies going back to fix a mistyped answer.
 *
 * A typo recorded as a wrong answer is a false data point in exactly the
 * measurements the app exists to produce, so correction has to work - and has
 * to replace the original record rather than adding a second one.
 */
import { chromium } from 'playwright-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_URL = process.argv[2] ?? 'https://qqandbella.github.io/math-trainer/'
const PROFILE = mkdtempSync(join(tmpdir(), 'mt-correct-'))
const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; throw new Error(m) }

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome' })
const page = await ctx.newPage()
page.on('pageerror', (e) => fail(`page error: ${e.message}`))

const solve = async (wrong = false) => {
  const text = (await page.locator('.problem-prompt').innerText()).trim()
  const expr = text.replace(/=$/, '').replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-').trim()
  const boxes = await page.locator('.answer-box').count()
  let value
  if (boxes === 2) {
    const [a, b] = expr.split('/').map((s) => Number(s.trim()))
    value = Math.floor(a / b)
    await page.keyboard.type(String(wrong ? value + 1 : value))
    await page.keyboard.press('Enter')
    await page.keyboard.type(String(a % b))
  } else {
    value = Number(new Function(`return (${expr})`)())
    await page.keyboard.type(String(wrong ? value + 1 : value))
  }
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  return value
}

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.getByText('Daily Practice').first().click()
  await page.locator('.problem-prompt').waitFor({ timeout: 15000 })

  if (await page.getByRole('button', { name: /back/ }).count()) {
    fail('back offered on the first problem, where there is nothing to go back to')
  }
  console.log('ok  no back button on the first problem')

  // Answer the first deliberately wrong, as a typo would.
  const firstPrompt = (await page.locator('.problem-prompt').innerText()).trim()
  await solve(true)
  await solve()
  console.log('ok  answered two problems, the first one wrongly')

  await page.getByRole('button', { name: /back/ }).click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: /back/ }).click()
  await page.waitForTimeout(200)
  const backPrompt = (await page.locator('.problem-prompt').innerText()).trim()
  if (backPrompt !== firstPrompt) fail(`back showed "${backPrompt}", expected "${firstPrompt}"`)
  console.log('ok  back returns to the earlier problem')

  const prefilled = (await page.locator('.answer-box').first().innerText()).trim()
  if (!/^\d+$/.test(prefilled)) fail(`previous answer not pre-filled, saw "${prefilled}"`)
  console.log(`ok  the previous answer is pre-filled ("${prefilled}") ready to edit`)

  // Correct it.
  for (let i = 0; i < 12; i++) await page.keyboard.press('Backspace')
  const corrected = await solve()
  console.log(`ok  re-answered with the correct value (${corrected})`)

  // Finish and check the summary counted one attempt, now correct.
  await page.getByRole('button', { name: /pause/ }).click()
  await page.getByRole('button', { name: 'End session now' }).click()
  await page.getByText('Session complete').waitFor()
  const summary = await page.locator('.stat-row').first().innerText()
  if (!summary.includes('2/2')) {
    fail(`correction did not replace the original attempt: summary shows "${summary.replace(/\n/g, ' ')}"`)
  }
  console.log('ok  the corrected answer replaced the original — 2/2, not 2/3')

  if (await page.locator('.review-item').count()) {
    fail('the corrected answer is still listed as a mistake')
  }
  console.log('ok  no mistakes listed after the correction')

  console.log('\nANSWER CORRECTION VERIFIED')
} finally {
  await ctx.close()
  rmSync(PROFILE, { recursive: true, force: true })
}
