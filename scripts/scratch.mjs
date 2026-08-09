/**
 * Verifies the scratch pad on the single-screen layout: folding, drawing,
 * erasing, clearing, that the keypad is never taken away, and that the pad
 * resets per problem but keeps its open/closed state.
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

/** Draws using coordinates relative to the canvas's visible area. */
const drawStroke = async (points) => {
  const locator = page.locator('.scratch-canvas')
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  const view = page.viewportSize()
  const top = Math.max(0, box.y) + 8
  const left = Math.max(0, box.x) + 8
  const h = Math.min(view.height, box.y + box.height) - top - 8
  const w = Math.min(view.width, box.x + box.width) - left - 8
  const at = ([fx, fy]) => [left + fx * w, top + fy * h]
  const [sx, sy] = at(points[0])
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  for (let i = 1; i < points.length; i++) {
    const [x, y] = at(points[i])
    await page.mouse.move(x, y)
  }
  await page.mouse.up()
}

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.getByText('Daily Practice').first().click()
  await page.locator('.problem-prompt').waitFor({ timeout: 15000 })

  // One screen: the keypad is present from the start and never goes away.
  if (!(await page.locator('.keypad').isVisible())) fail('keypad missing')
  if (await page.locator('.scratch-canvas').isVisible()) fail('pad open before it was asked for')
  console.log('ok  starts folded, with the keypad available')

  await page.getByRole('button', { name: /scratch pad/ }).click()
  await page.locator('.scratch-canvas').waitFor({ timeout: 5000 })
  if (!(await page.locator('.keypad').isVisible())) fail('opening the pad hid the keypad')
  if (!(await page.locator('.answer-box').first().isVisible())) fail('answer box hidden')
  console.log('ok  opening the pad keeps the keypad and answer box on screen')

  await drawStroke([[0.05, 0.2], [0.35, 0.2]])
  await drawStroke([[0.6, 0.6], [0.9, 0.6]])
  const two = await inkPixels()
  if (two < 100) fail('drawing did not register')
  console.log(`ok  drawing works (${two} ink pixels)`)

  await page.getByRole('button', { name: /erase/ }).click()
  await drawStroke([[0.05, 0.2], [0.35, 0.2]])
  const left = await inkPixels()
  if (left === 0) fail('the eraser wiped everything, not just what it touched')
  if (left >= two * 0.9) fail(`erasing removed too little (${two} -> ${left})`)
  console.log(`ok  eraser removes only what it touches (${two} -> ${left} px)`)

  await page.getByRole('button', { name: /write/ }).click()
  await page.getByRole('button', { name: 'clear pad' }).click()
  if ((await inkPixels()) !== 0) fail('clear did not empty the pad')
  console.log('ok  clear empties the pad')

  // The keypad's own clear must be distinguishable from the pad's.
  const clears = await page.getByRole('button', { name: /^clear/ }).allInnerTexts()
  if (new Set(clears.map((t) => t.trim())).size !== clears.length) {
    fail(`two buttons share a label: ${JSON.stringify(clears)}`)
  }

  // Typing still works with the pad open.
  await drawStroke([[0.1, 0.2], [0.5, 0.5]])
  const kept = await inkPixels()
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.keyboard.type('42')
  if ((await page.locator('.answer-box').first().innerText()).trim() !== '42') {
    fail('keyboard input did not reach the answer box with the pad open')
  }
  console.log('ok  the keypad and keyboard work with the pad open')

  // Folding and unfolding must not lose the working out.
  await page.getByRole('button', { name: /scratch pad/ }).click()
  if (await page.locator('.scratch-canvas').isVisible()) fail('pad did not fold away')
  await page.getByRole('button', { name: /scratch pad/ }).click()
  await page.locator('.scratch-canvas').waitFor()
  const after = await inkPixels()
  if (after < kept * 0.8) fail(`folding lost the working out: ${kept} -> ${after} ink pixels`)
  console.log(`ok  folding and unfolding keeps the work (${after}/${kept} px)`)

  // A new problem clears the paper but leaves the pad open.
  const before = (await page.locator('.problem-prompt').innerText()).trim()
  // Otherwise Enter activates whichever button was clicked last.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('999999')
  await page.keyboard.press('Enter')
  await page.waitForFunction((p) => {
    const el = document.querySelector('.problem-prompt')
    return el && el.textContent.trim() !== p
  }, before, { timeout: 5000 })
  if (!(await page.locator('.scratch-canvas').isVisible())) fail('the pad folded itself on a new problem')
  if ((await inkPixels()) !== 0) fail('working out carried over to the next problem')
  console.log('ok  a new problem starts on clean paper, pad still open')

  // Mental Challenge excludes paper entirely.
  await page.goto(`${APP_URL}#/`, { waitUntil: 'domcontentloaded' })
  await page.locator('.app-title').waitFor()
  await page.getByText('Mental Challenge').first().click()
  await page.getByRole('button', { name: 'Start' }).click()
  await page.locator('.problem-prompt').waitFor({ timeout: 10000 })
  if (await page.getByRole('button', { name: /scratch pad/ }).count()) {
    fail('Mental Challenge offers a scratch pad, which defeats the mode')
  }
  console.log('ok  Mental Challenge has no scratch pad')

  console.log('\nSCRATCH PAD VERIFIED')
} finally {
  await ctx.close()
  rmSync(PROFILE, { recursive: true, force: true })
}
