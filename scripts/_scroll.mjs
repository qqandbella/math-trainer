import { chromium } from 'playwright-core'
const b = await chromium.launch({ channel: 'chrome' })
for (const [name, vp] of [['phone',{width:390,height:844}],['small phone',{width:360,height:640}],['portrait',{width:834,height:1112}]]) {
  const p = await b.newPage({ viewport: vp })
  await p.goto('http://localhost:4173/math-trainer/', { waitUntil: 'domcontentloaded' })
  await p.getByText('Daily Practice').first().click()
  await p.locator('.problem-prompt').waitFor()
  await p.getByRole('button', { name: /scratch pad/ }).click()
  await p.locator('.scratch-canvas').waitFor()
  // Scroll to the very bottom, then back to the top, as a user would.
  await p.locator('.session').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await p.waitForTimeout(150)
  const enterSeen = await p.getByRole('button', { name: 'enter' }).isVisible()
  await p.locator('.session').evaluate((el) => { el.scrollTop = 0 })
  await p.waitForTimeout(150)
  const prompt = await p.locator('.problem-prompt').boundingBox()
  const reachable = prompt.y >= -1 && prompt.y + prompt.height <= vp.height
  console.log(`${name.padEnd(12)} prompt top=${Math.round(prompt.y)} visible=${reachable} | enter reachable=${enterSeen}`)
  await p.close()
}
await b.close()
