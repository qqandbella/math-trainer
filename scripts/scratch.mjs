/**
 * Verifies the scratch pad: switching modes, drawing, undo/clear, that the
 * problem stays visible, that scratch resets between problems, and that the
 * keyboard still works while the pad is open.
 */
import { chromium } from 'playwright-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_URL = process.argv[2] ?? 'https://qqandbella.github.io/math-trainer/'
const PROFILE = mkdtempSync(join(tmpdir(), 'mt-scratch-'))
const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; throw new Error(m) }

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome' })
const page = await ctx.newPage()
page.on('pageerror', (e) => fail(`page error: ${e.message}`))

const inkPixels = () => page.evaluate(() => {
  const c = document.querySelector('.scratch-canvas')
  const ctx = c.getContext('2d')
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let n = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
  return n
})

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.getByText('Daily Practice').first().click()
  await page.locator('.problem-prompt').waitFor({ timeout: 15000 })

  if (await page.locator('.scratch-canvas').count()) fail('scratch pad visible before it was asked for')
  console.log('ok  session starts on the keypad')

  await page.getByRole('button', { name: /scratch pad/ }).click()
  await page.locator('.scratch-canvas').waitFor({ timeout: 5000 })
  const promptInScratch = (await page.locator('.problem-prompt').innerText()).trim()
  if (!promptInScratch) fail('problem is not visible in scratch mode')
  if (await page.locator('.keypad').count()) fail('keypad still taking space in scratch mode')
  if (!(await page.locator('.answer-box').first().isVisible())) fail('answer box hidden in scratch mode')
  console.log(`ok  scratch mode keeps the problem visible ("${promptInScratch}") and drops the keypad`)

  if ((await inkPixels()) !== 0) fail('canvas did not start blank')
  const box = await page.locator('.scratch-canvas').boundingBox()
  await page.mouse.move(box.x + 40, box.y + 40)
  await page.mouse.down()
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + 40 + i * 8, box.y + 40 + Math.sin(i / 3) * 20)
  await page.mouse.up()
  const drawn = await inkPixels()
  if (drawn < 100) fail(`drawing produced almost no ink (${drawn} px)`)
  console.log(`ok  drawing works (${drawn} ink pixels)`)

  await page.getByRole('button', { name: 'undo' }).click()
  if ((await inkPixels()) !== 0) fail('undo did not remove the stroke')
  console.log('ok  undo removes a stroke')

  // Typing must still reach the answer box while the pad is open.
  await page.keyboard.type('123')
  const typed = (await page.locator('.answer-box').first().innerText()).trim()
  if (typed !== '123') fail(`keyboard input did not reach the answer box, saw "${typed}"`)
  console.log('ok  physical keyboard still works in scratch mode')

  await page.getByRole('button', { name: /enter answer/ }).click()
  await page.locator('.keypad').waitFor({ timeout: 5000 })
  console.log('ok  switches back to the keypad')

  // Scratch must not carry over to the next problem.
  await page.getByRole('button', { name: /scratch pad/ }).click()
  const box2 = await page.locator('.scratch-canvas').boundingBox()
  await page.mouse.move(box2.x + 30, box2.y + 30)
  await page.mouse.down()
  for (let i = 1; i <= 15; i++) await page.mouse.move(box2.x + 30 + i * 9, box2.y + 60)
  await page.mouse.up()
  if ((await inkPixels()) < 100) fail('second drawing did not register')

  const before = (await page.locator('.problem-prompt').innerText()).trim()
  await page.keyboard.press('Escape')
  await page.keyboard.type('999999')
  await page.keyboard.press('Enter')
  await page.waitForFunction((p) => {
    const el = document.querySelector('.problem-prompt')
    return el && el.textContent.trim() !== p
  }, before, { timeout: 5000 })

  await page.getByRole('button', { name: /scratch pad/ }).click()
  await page.locator('.scratch-canvas').waitFor()
  if ((await inkPixels()) !== 0) fail('scratch work carried over to the next problem')
  console.log('ok  each problem starts on clean paper')

  console.log('\nSCRATCH PAD VERIFIED')
} finally {
  await ctx.close()
  rmSync(PROFILE, { recursive: true, force: true })
}
