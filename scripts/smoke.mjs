/**
 * End-to-end smoke test against a running preview server.
 *
 * Exercises the real loop in a real browser: start a session, solve problems,
 * verify grading, finish, and confirm the results survived into IndexedDB and
 * show up in Reports.
 *
 *   npx vite preview --port 4173 &
 *   npx -p playwright node scripts/smoke.mjs
 */
import { chromium } from 'playwright-core'

const URL = process.env.SMOKE_URL ?? 'http://localhost:4173/math-trainer/'
const SOLVE_COUNT = 10

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

function evaluatePrompt(text) {
  const expr = text
    .replace(/=$/, '')
    .replaceAll('×', '*')
    .replaceAll('÷', '/')
    .replaceAll('−', '-')
    .trim()
  return { expr, value: Number(new Function(`return (${expr})`)()) }
}

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } })
page.on('pageerror', (error) => fail(`uncaught page error: ${error.message}`))

try {
  await page.goto(URL, { waitUntil: 'networkidle' })

  if (!(await page.locator('.app-title').isVisible())) fail('dashboard did not render')
  console.log('ok  dashboard rendered')

  await page.getByText('Daily Practice').first().click()
  await page.locator('.problem-prompt').waitFor()
  console.log('ok  daily session started')

  let expectedCorrect = 0
  const answered = []
  for (let i = 0; i < SOLVE_COUNT; i++) {
    const promptText = (await page.locator('.problem-prompt').innerText()).trim()
    const boxes = await page.locator('.answer-box').count()
    const { expr, value } = evaluatePrompt(promptText)

    // Deliberately get one wrong, to prove grading is not just always-true.
    const shouldBeWrong = i === 3

    if (boxes === 2) {
      const [a, b] = expr.split('/').map((s) => Number(s.trim()))
      const quotient = Math.floor(a / b)
      const remainder = a % b
      answered.push(`${promptText} -> ${shouldBeWrong ? quotient + 1 : quotient} r${remainder}`)
      await page.keyboard.type(String(shouldBeWrong ? quotient + 1 : quotient))
      await page.keyboard.press('Enter')
      await page.keyboard.type(String(remainder))
      await page.keyboard.press('Enter')
    } else {
      if (!Number.isInteger(value)) fail(`non-integer answer for "${promptText}"`)
      answered.push(`${promptText} -> ${shouldBeWrong ? value + 1 : value}`)
      await page.keyboard.type(String(shouldBeWrong ? value + 1 : value))
      await page.keyboard.press('Enter')
    }
    if (!shouldBeWrong) expectedCorrect++

    try {
      await page.waitForFunction(
        (n) =>
          document.querySelector('.session-top span')?.textContent?.trim().startsWith(String(n)),
        i + 2,
        { timeout: 3000 },
      )
    } catch {
      const counter = await page.locator('.session-top').innerText()
      const boxValues = await page.locator('.answer-box').allInnerTexts()
      fail(
        `stuck after problem ${i + 1} "${promptText}" (${boxes} box(es)); ` +
          `counter="${counter.replace(/\n/g, ' | ')}" boxes=${JSON.stringify(boxValues)}`,
      )
    }
  }
  console.log(`ok  solved ${SOLVE_COUNT} problems (1 intentionally wrong)`)

  // End early via pause -> end session, then check the summary's grading.
  await page.getByRole('button', { name: /pause/ }).click()
  await page.getByRole('button', { name: 'End session now' }).click()
  await page.getByText('Session complete').waitFor()

  const summary = await page.locator('.stat-row').first().innerText()
  if (!summary.includes(`${expectedCorrect}/${SOLVE_COUNT}`)) {
    const graded = await page.locator('.review-item').allInnerTexts()
    fail(
      `summary showed "${summary.replace(/\n/g, ' ')}", expected ${expectedCorrect}/${SOLVE_COUNT}.\n` +
        `  marked wrong: ${JSON.stringify(graded)}\n` +
        `  I answered:   ${JSON.stringify(answered)}`,
    )
  }
  console.log(`ok  grading correct: ${expectedCorrect}/${SOLVE_COUNT}`)

  const reviewCount = await page.locator('.review-item').count()
  if (reviewCount !== 1) fail(`expected 1 item in the wrong-answer review, saw ${reviewCount}`)
  console.log('ok  wrong answer surfaced in end-of-session review')

  await page.getByRole('button', { name: 'Done' }).click()
  await page.locator('.app-title').waitFor()

  // Reload to prove the data came back out of IndexedDB, not React state.
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByText('Progress').first().click()
  await page.getByRole('heading', { name: 'Progress' }).waitFor()

  const totals = await page.locator('.stat-row').first().innerText()
  if (!totals.includes(String(SOLVE_COUNT))) {
    fail(`reports did not show ${SOLVE_COUNT} problems after reload; saw "${totals.replace(/\n/g, ' ')}"`)
  }
  console.log('ok  data persisted across reload and reached Reports')

  const charts = await page.locator('svg').count()
  if (charts < 3) fail(`expected at least 3 charts, found ${charts}`)
  console.log(`ok  ${charts} charts rendered`)

  console.log('\nSMOKE PASSED')
} finally {
  await browser.close()
}
