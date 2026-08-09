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

/** Mode is sticky, so never assume which one we are in. */
const ensureMode = async (want) => {
  const inScratch = await page.locator('.scratch-canvas').isVisible().catch(() => false)
  if (want === 'scratch' && !inScratch) {
    await page.getByRole('button', { name: /scratch pad/ }).click()
    await page.locator('.scratch-canvas').waitFor({ timeout: 5000 })
  } else if (want === 'answer' && inScratch) {
    await page.getByRole('button', { name: 'use the keypad instead' }).click()
    await page.locator('.keypad').waitFor({ timeout: 5000 })
  }
}

/**
 * Draws inside the canvas using coordinates relative to its *visible* area.
 * The page can be scrolled such that the canvas starts above the viewport, and
 * mouse events at negative coordinates land nowhere.
 */
const drawStroke = async (points, selector = '.scratch-canvas') => {
  const locator = page.locator(selector)
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  const view = page.viewportSize()
  const top = Math.max(0, box.y) + 10
  const left = Math.max(0, box.x) + 10
  const usableHeight = Math.min(view.height, box.y + box.height) - top - 10
  const usableWidth = Math.min(view.width, box.x + box.width) - left - 10
  const at = ([fx, fy]) => [left + fx * usableWidth, top + fy * usableHeight]

  const [sx, sy] = at(points[0])
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  for (let i = 1; i < points.length; i++) {
    const [x, y] = at(points[i])
    await page.mouse.move(x, y)
  }
  await page.mouse.up()
}

const inkPixels = (selector = '.scratch-canvas') => page.evaluate((sel) => {
  const c = document.querySelector(sel)
  const ctx = c.getContext('2d')
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let n = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
  return n
}, selector)

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.getByText('Daily Practice').first().click()
  await page.locator('.problem-prompt').waitFor({ timeout: 15000 })

  if (await page.locator('.scratch-canvas').isVisible()) {
    fail('scratch pad visible before it was asked for')
  }
  console.log('ok  session starts on the keypad')

  await ensureMode('scratch')
  const promptInScratch = (await page.locator('.problem-prompt').innerText()).trim()
  if (!promptInScratch) fail('problem is not visible in scratch mode')
  if (await page.locator('.keypad').count()) fail('keypad still taking space in scratch mode')
  if (!(await page.locator('.scratch-canvas').isVisible())) fail('scratch canvas not visible')
  if (!(await page.locator('.answer-canvas').isVisible())) {
    fail('no separate area to write the answer in')
  }
  const workBox = await page.locator('.scratch-canvas').boundingBox()
  const ansBox = await page.locator('.answer-canvas').boundingBox()
  // Either stacked or side by side is fine; overlapping is not.
  const overlaps =
    ansBox.x < workBox.x + workBox.width - 1 &&
    workBox.x < ansBox.x + ansBox.width - 1 &&
    ansBox.y < workBox.y + workBox.height - 1 &&
    workBox.y < ansBox.y + ansBox.height - 1
  if (overlaps) fail('the answer area overlaps the working area')
  const view = page.viewportSize()
  if (ansBox.y + ansBox.height > view.height) {
    fail(
      `the answer area is below the fold (ends at ${Math.round(ansBox.y + ansBox.height)}px, ` +
        `viewport is ${view.height}px) - it would never be seen`,
    )
  }
  console.log('ok  the answer area is separate from the working area, and on screen')

  // Both orientations must give each surface usable room.
  for (const [name, size] of [
    ['portrait', { width: 834, height: 1112 }],
    ['landscape', { width: 1112, height: 834 }],
    ['phone portrait', { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(250)
    const work = await page.locator('.scratch-canvas').boundingBox()
    const ans = await page.locator('.answer-canvas').boundingBox()
    if (!work || !ans) fail(`${name}: a drawing surface disappeared`)
    if (ans.y + ans.height > size.height + 1) {
      fail(`${name}: the answer area runs off the bottom of the screen`)
    }
    if (ans.height < 70) fail(`${name}: the answer area is only ${Math.round(ans.height)}px tall`)
    if (work.height < 120) fail(`${name}: the working area is only ${Math.round(work.height)}px tall`)
    const layout = ans.x > work.x + work.width - 10 ? 'side by side' : 'stacked'
    if (layout === 'stacked') {
      const share = work.height / (work.height + ans.height)
      if (share < 0.6 || share > 0.85) {
        fail(`${name}: working area is ${Math.round(share * 100)}% of the pad, wanted 70-80%`)
      }
    }
    if (!(await page.getByRole('button', { name: 'use the keypad instead' }).isVisible())) {
      fail(`${name}: no way to reach the keypad from the pad`)
    }
    console.log(
      `ok  ${name}: work ${Math.round(work.width)}x${Math.round(work.height)}, ` +
        `answer ${Math.round(ans.width)}x${Math.round(ans.height)} (${layout})`,
    )
  }
  await page.setViewportSize({ width: 1280, height: 720 })
  if (!(await page.locator('.answer-box').first().isVisible())) fail('answer box hidden in scratch mode')
  console.log(`ok  scratch mode keeps the problem visible ("${promptInScratch}") and drops the keypad`)

  if ((await inkPixels()) !== 0) fail('canvas did not start blank')
  const wiggle = [[0.05, 0.1]]
  for (let i = 1; i <= 20; i++) wiggle.push([0.05 + i * 0.02, 0.1 + Math.sin(i / 3) * 0.03])
  await drawStroke(wiggle)
  const drawn = await inkPixels()
  if (drawn < 100) fail(`drawing produced almost no ink (${drawn} px)`)
  console.log(`ok  drawing works (${drawn} ink pixels)`)

  // Erasing must remove only what it is dragged over. Two well-separated
  // strokes, erase one, and the other has to survive.
  await page.getByRole('button', { name: 'clear', exact: true }).click()
  await drawStroke([[0.05, 0.15], [0.35, 0.15]])
  await drawStroke([[0.6, 0.6], [0.9, 0.6]])
  const twoStrokes = await inkPixels()
  if (twoStrokes < 100) fail('two-stroke setup did not draw')

  await page.getByRole('button', { name: /erase/ }).click()
  await drawStroke([[0.05, 0.15], [0.35, 0.15]])
  const oneLeft = await inkPixels()
  if (oneLeft === 0) fail('the eraser wiped everything, not just what it touched')
  if (oneLeft >= twoStrokes * 0.9) fail(`erasing removed too little (${twoStrokes} -> ${oneLeft})`)
  console.log(`ok  eraser removes only what it touches (${twoStrokes} -> ${oneLeft} px)`)

  await page.getByRole('button', { name: /write/ }).click()
  await page.getByRole('button', { name: 'clear', exact: true }).click()
  if ((await inkPixels()) !== 0) fail('clear did not empty the working area')
  console.log('ok  clear empties the working area')
  await drawStroke([[0.05, 0.1], [0.4, 0.2]])

  if (await page.getByRole('button', { name: 'undo' }).count()) {
    fail('undo is still present; it was meant to be replaced by the eraser')
  }

  // Typing must still reach the answer box while the pad is open.
  await page.keyboard.type('123')
  const typed = (await page.locator('.answer-box').first().innerText()).trim()
  if (typed !== '123') fail(`keyboard input did not reach the answer box, saw "${typed}"`)
  console.log('ok  physical keyboard still works in scratch mode')

  await ensureMode('answer')
  console.log('ok  switches back to the keypad')

  // Tapping the answer box must bring the keypad back: in scratch mode it is
  // otherwise impossible to answer on a touch device.
  await ensureMode('scratch')
  await page.locator('.answer-box').first().click()
  await page.locator('.keypad').waitFor({ timeout: 5000 })
  console.log('ok  tapping the answer box returns to the keypad')

  // Swipe left into scratch, swipe right back out.
  const prompt = page.locator('.problem-prompt')
  const pb = await prompt.boundingBox()
  const swipe = async (dx) => {
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(pb.x + pb.width / 2 + (dx * i) / 10, pb.y + pb.height / 2)
    }
    await page.mouse.up()
  }
  await swipe(-140)
  await page.locator('.scratch-canvas').waitFor({ timeout: 5000 })
  console.log('ok  swipe left opens the scratch pad')
  await swipe(140)
  await page.locator('.keypad').waitFor({ timeout: 5000 })
  console.log('ok  swipe right returns to the keypad')

  await ensureMode('scratch')
  const toolBox = await page.locator('.scratch-tools .btn').first().boundingBox()
  if (toolBox.height < 44) fail(`pad tools too small to hit: ${toolBox.height}px tall`)
  console.log(`ok  pad tools are ${Math.round(toolBox.height)}px tall (>=44 touch minimum)`)
  await ensureMode('answer')

  // Scratch must not carry over to the next problem.
  await ensureMode('scratch')
  const line = [[0.05, 0.1]]
  for (let i = 1; i <= 15; i++) line.push([0.05 + i * 0.02, 0.14])
  await drawStroke(line)
  if ((await inkPixels()) < 100) fail('second drawing did not register')

  const before = (await page.locator('.problem-prompt').innerText()).trim()
  await page.keyboard.press('Escape')
  await page.keyboard.type('999999')
  await page.keyboard.press('Enter')
  await page.waitForFunction((p) => {
    const el = document.querySelector('.problem-prompt')
    return el && el.textContent.trim() !== p
  }, before, { timeout: 5000 })

  // Mode is sticky, so the next problem opens straight into the pad - but on
  // fresh paper.
  await page.locator('.scratch-canvas').waitFor({ timeout: 5000 })
  console.log('ok  scratch mode persists into the next problem')
  if ((await inkPixels()) !== 0) fail('scratch work carried over to the next problem')
  console.log('ok  but the paper is clean for each new problem')

  /* --- scratch survives a trip to the keypad and back ---------------------- */
  await ensureMode('scratch')
  const diagonal = [[0.06, 0.12]]
  for (let i = 1; i <= 15; i++) diagonal.push([0.06 + i * 0.015, 0.12 + i * 0.01])
  await drawStroke(diagonal)
  const inkBeforeSwitch = await inkPixels()
  if (inkBeforeSwitch < 100) fail('drawing did not register')
  await ensureMode('answer')
  await ensureMode('scratch')
  const inkAfterSwitch = await inkPixels()
  // Not pixel-identical: the canvas is re-sized and the strokes re-rasterised
  // on the way back, so anti-aliasing differs slightly. What matters is that
  // the work is there rather than wiped.
  if (inkAfterSwitch < inkBeforeSwitch * 0.8) {
    fail(`scratch work lost on mode switch: ${inkBeforeSwitch} -> ${inkAfterSwitch} ink pixels`)
  }
  console.log(
    `ok  scratch survives switching to the keypad and back (${inkAfterSwitch}/${inkBeforeSwitch} px)`,
  )

  /* --- handwriting is read into the answer box, never auto-submitted ------- */
  await ensureMode('scratch')
  // Deliberately leave working-out on the pad: recognition must ignore it.
  const workingOut = []
  for (let i = 0; i <= 25; i++) workingOut.push([0.1 + i * 0.03, 0.3 + Math.sin(i / 2) * 0.08])
  await drawStroke(workingOut)
  if ((await inkPixels()) < 100) fail('working-out did not register')

  // A single tall vertical stroke in the answer strip: unambiguously a 1.
  const one = []
  for (let i = 0; i <= 20; i++) one.push([0.3, 0.08 + i * 0.042])
  await drawStroke(one, '.answer-canvas')
  if ((await inkPixels('.answer-canvas')) < 50) fail('the written answer did not register')
  const countBefore = (await page.locator('.session-top').innerText()).trim()
  await page.getByRole('button', { name: 'read', exact: true }).click()
  await page.getByRole('button', { name: /^submit / }).waitFor({ timeout: 5000 })
  if (!(await page.locator('.scratch-canvas').isVisible())) {
    fail('reading kicked us out of the pad instead of offering to submit in place')
  }
  console.log('ok  reading stays on the pad and offers submit in place')

  // A label the same colour as its background is invisible, which is exactly
  // how this button shipped once.
  const legible = await page.getByRole('button', { name: /^submit / }).evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      text: el.textContent.trim(),
      color: style.color,
      background: style.backgroundColor,
    }
  })
  if (!legible.text) fail('the submit button has no label')
  if (legible.color === legible.background) {
    fail(`submit button is invisible: text and background are both ${legible.color}`)
  }
  console.log(`ok  submit button reads "${legible.text}" and is legible`)
  const readValue = (await page.locator('.answer-box').first().innerText()).trim()
  if (!/^\d+$/.test(readValue)) fail(`recognition did not fill the answer box, saw "${readValue}"`)
  if (readValue.length !== 1) {
    fail(`recognition read the working-out too: got "${readValue}", expected a single digit`)
  }
  console.log(`ok  handwriting read into the answer box as "${readValue}" (working-out ignored)`)

  const countAfter = (await page.locator('.session-top').innerText()).trim()
  if (countBefore !== countAfter) fail('recognition auto-submitted instead of waiting for confirmation')
  console.log('ok  recognition never submits on its own - it waits for confirmation')

  // Confirming submits and advances, all without leaving the pad.
  await page.getByRole('button', { name: /^submit / }).click()
  await page.waitForFunction((c) => {
    const el = document.querySelector('.session-top')
    return el && el.innerText.trim() !== c
  }, countBefore, { timeout: 5000 })
  if (!(await page.locator('.scratch-canvas').isVisible())) {
    fail('submitting from the pad dropped back to the keypad')
  }
  console.log('ok  submitting from the pad advances and stays on the pad')

  /* --- Mental Challenge must not offer a scratch pad ---------------------- */
  await page.goto(`${APP_URL}#/`, { waitUntil: 'domcontentloaded' })
  await page.locator('.app-title').waitFor()
  await page.getByText('Mental Challenge').first().click()
  await page.getByRole('button', { name: 'Start' }).click()
  await page.locator('.problem-prompt').waitFor({ timeout: 10000 })
  if (await page.getByRole('button', { name: /scratch pad/ }).count()) {
    fail('Mental Challenge offers a scratch pad, which defeats the mode')
  }
  if (await page.locator('.scratch-canvas').count()) fail('scratch canvas present in Mental Challenge')
  console.log('ok  Mental Challenge has no scratch pad')

  console.log('\nSCRATCH PAD VERIFIED')
} finally {
  await ctx.close()
  rmSync(PROFILE, { recursive: true, force: true })
}
