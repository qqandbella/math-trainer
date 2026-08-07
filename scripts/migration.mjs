/**
 * Verifies the v1 -> v2 schema migration in a real browser.
 *
 * Every device that already ran this app holds a v1 database containing real
 * practice history. A migration bug destroys it, and no amount of in-memory
 * testing proves the real IndexedDB implementation behaves the same way. So:
 * seed an authentic v1 database, load the app on top of it, and check the
 * history is intact and still usable.
 *
 *   node scripts/migration.mjs [url]
 */
import { chromium } from 'playwright-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_URL = process.argv[2] ?? 'https://qqandbella.github.io/math-trainer/'
const PROFILE = mkdtempSync(join(tmpdir(), 'mt-migrate-'))

const fail = (m) => {
  console.error(`FAIL: ${m}`)
  process.exitCode = 1
  throw new Error(m)
}

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome' })
const page = await ctx.newPage()
page.on('pageerror', (e) => fail(`page error: ${e.message}`))

try {
  // Load a same-origin asset rather than the app, so nothing opens the database
  // before the v1 fixture exists.
  await page.goto(`${APP_URL}manifest.webmanifest`, { waitUntil: 'domcontentloaded' })

  const seeded = await page.evaluate(async () => {
    await new Promise((resolve) => {
      const del = indexedDB.deleteDatabase('math-trainer')
      del.onsuccess = del.onerror = del.onblocked = () => resolve(undefined)
    })

    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('math-trainer', 1)
      req.onupgradeneeded = () => {
        const d = req.result
        const attempts = d.createObjectStore('attempts', { keyPath: 'id' })
        attempts.createIndex('by-at', 'at')
        attempts.createIndex('by-skill', 'skillId')
        attempts.createIndex('by-session', 'sessionId')
        const sessions = d.createObjectStore('sessions', { keyPath: 'id' })
        sessions.createIndex('by-startedAt', 'startedAt')
        d.createObjectStore('settings', { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

    const now = Date.now()
    const tx = db.transaction(['attempts', 'sessions', 'settings'], 'readwrite')
    const COUNT = 7
    for (let i = 0; i < COUNT; i++) {
      // No learnerId: that field did not exist in v1.
      tx.objectStore('attempts').put({
        id: `legacy-${i}`,
        sessionId: 'legacy-session',
        skillId: 'mul_3x2',
        prompt: `${100 + i} x 24`,
        answer: (100 + i) * 24,
        given: i === 3 ? 0 : (100 + i) * 24,
        correct: i !== 3,
        ms: 15000 + i,
        at: now - (COUNT - i) * 1000,
      })
    }
    tx.objectStore('sessions').put({
      id: 'legacy-session',
      mode: 'daily',
      startedAt: now - 10000,
      endedAt: now,
      problemCount: COUNT,
      attemptedCount: COUNT,
      correctCount: COUNT - 1,
      activeMs: 105000,
      pausesUsed: 0,
      completed: true,
    })
    tx.objectStore('settings').put({ key: 'learnerName', value: 'Legacy Learner' })
    await new Promise((resolve) => {
      tx.oncomplete = resolve
    })
    db.close()
    return COUNT
  })
  console.log(`ok  seeded an authentic v1 database with ${seeded} attempts`)

  // Now let the app open it and run the migration for real.
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.locator('.app-title').waitFor({ timeout: 15000 })

  const shown = await page.locator('.app-header .muted').innerText().catch(() => '')
  if (shown.trim() !== 'Legacy Learner') {
    fail(`learner name lost in migration: saw "${shown}"`)
  }
  console.log('ok  app loaded on the migrated database; learner name preserved')

  await page.getByText('Progress').first().click()
  await page.getByRole('heading', { name: 'Progress' }).waitFor({ timeout: 10000 })
  const totals = await page.locator('.stat-row').first().innerText()
  if (!totals.includes(String(seeded))) {
    fail(`migrated history missing: expected ${seeded} problems, saw "${totals.replace(/\n/g, ' ')}"`)
  }
  console.log(`ok  all ${seeded} legacy attempts survived and appear in Progress`)

  // Accuracy proves field-level fidelity, not just row counts.
  const expectedAccuracy = Math.round(((seeded - 1) / seeded) * 100)
  if (!totals.includes(`${expectedAccuracy}%`)) {
    fail(`accuracy wrong after migration: expected ${expectedAccuracy}%, saw "${totals.replace(/\n/g, ' ')}"`)
  }
  console.log(`ok  per-record fields intact (accuracy ${expectedAccuracy}% matches the seed)`)

  // The database must be writable afterwards, not just readable.
  await page.getByRole('button', { name: 'done' }).click()
  await page.getByText('Daily Practice').first().click()
  await page.locator('.problem-prompt').waitFor({ timeout: 10000 })
  const text = (await page.locator('.problem-prompt').innerText()).trim()
  const expr = text
    .replace(/=$/, '')
    .replaceAll('×', '*')
    .replaceAll('÷', '/')
    .replaceAll('−', '-')
    .trim()
  const boxes = await page.locator('.answer-box').count()
  if (boxes === 2) {
    const [a, b] = expr.split('/').map((s) => Number(s.trim()))
    await page.keyboard.type(String(Math.floor(a / b)))
    await page.keyboard.press('Enter')
    await page.keyboard.type(String(a % b))
  } else {
    await page.keyboard.type(String(Number(new Function(`return (${expr})`)())))
  }
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)

  await page.goto(`${APP_URL}#/`, { waitUntil: 'domcontentloaded' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('Progress').first().click()
  const after = await page.locator('.stat-row').first().innerText()
  if (!after.includes(String(seeded + 1))) {
    fail(`new practice not recorded after migration: saw "${after.replace(/\n/g, ' ')}"`)
  }
  console.log('ok  new practice records alongside the migrated history')

  console.log('\nMIGRATION VERIFIED — existing practice history survives the upgrade')
} finally {
  await ctx.close()
  rmSync(PROFILE, { recursive: true, force: true })
}
