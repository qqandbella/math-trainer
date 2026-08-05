/** Captures reference screenshots at iPad-portrait size into /tmp/mt-shots. */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const URL = process.env.SMOKE_URL ?? 'http://localhost:4173/'
const OUT = '/tmp/mt-shots'
mkdirSync(OUT, { recursive: true })

const evaluatePrompt = (text) =>
  Number(
    new Function(
      `return (${text.replace(/=$/, '').replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-').trim()})`,
    )(),
  )

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({
  viewport: { width: 834, height: 1112 },
  deviceScaleFactor: 2,
})

await page.goto(URL, { waitUntil: 'networkidle' })

await page.getByText('Daily Practice').first().click()
await page.locator('.problem-prompt').waitFor()
for (let i = 0; i < 24; i++) {
  const text = (await page.locator('.problem-prompt').innerText()).trim()
  const boxes = await page.locator('.answer-box').count()
  if (boxes === 2) {
    const [a, b] = text.replace('=', '').split('÷').map((s) => Number(s.trim()))
    await page.keyboard.type(String(Math.floor(a / b)))
    await page.keyboard.press('Enter')
    await page.keyboard.type(String(i % 7 === 0 ? (a % b) + 1 : a % b))
  } else {
    const value = evaluatePrompt(text)
    await page.keyboard.type(String(i % 7 === 0 ? value + 1 : value))
  }
  if (i === 10) await page.screenshot({ path: `${OUT}/02-session.png` })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(60)
}

await page.getByRole('button', { name: /pause/ }).click()
await page.getByRole('button', { name: 'End session now' }).click()
await page.getByText('Session complete').waitFor()
await page.screenshot({ path: `${OUT}/03-summary.png`, fullPage: true })

await page.getByRole('button', { name: 'Done' }).click()
await page.locator('.app-title').waitFor()
await page.screenshot({ path: `${OUT}/01-dashboard.png` })

await page.getByText('Progress').first().click()
await page.getByRole('heading', { name: 'Progress' }).waitFor()
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/04-reports.png`, fullPage: true })

await browser.close()
console.log('screenshots written to', OUT)
