// CPU profile of typing in a big page (not part of npm test).
// Usage: same server as perf.mjs; node tests/perf-profile.mjs <big topic name>
import { chromium } from 'playwright-core'

const big = process.argv[2]
const b = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage()
await page.goto('http://127.0.0.1:8794/')
await page.waitForSelector('#loading', { state: 'detached', timeout: 120000 })
await page.keyboard.press('Control+p')
await page.waitForSelector('.palette-input')
await page.keyboard.type(big)
await page.waitForTimeout(100)
await page.keyboard.press('Enter')
await page.waitForFunction(n => document.querySelector('.tab.active')?.textContent?.includes(n), big)
await page.waitForTimeout(2000)
await page.locator('.doc-view.active .md-content > p').nth(40).click()
await page.keyboard.press('End')

const cdp = await page.context().newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
await cdp.send('Profiler.start')
const t = Date.now()
await page.keyboard.type('abcdefghijklmnopqrstuvwxyz0123')
console.log(`typed 30 keys in ${Date.now() - t} ms`)
await page.waitForTimeout(400)
const { profile } = await cdp.send('Profiler.stop')

// Self time per function, and total time per function including callees.
const byId = new Map(profile.nodes.map(n => [n.id, n]))
const parent = new Map()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const dt = profile.timeDeltas
const self = new Map(), total = new Map()
profile.samples.forEach((id, i) => {
  const ms = (dt[i] ?? 0) / 1000
  const n = byId.get(id)
  const key = f => `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`
  self.set(key(n.callFrame), (self.get(key(n.callFrame)) ?? 0) + ms)
  const seen = new Set()
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const k = key(byId.get(cur).callFrame)
    if (seen.has(k)) continue
    seen.add(k)
    total.set(k, (total.get(k) ?? 0) + ms)
  }
})
const top = (m, n) => [...m].filter(([k]) => !/^\((idle|root)\)/.test(k)).sort((a, c) => c[1] - a[1]).slice(0, n)
console.log('\nself time:')
for (const [k, v] of top(self, 14)) console.log(`  ${v.toFixed(0).padStart(5)} ms  ${k}`)
console.log('\ntotal time (with callees):')
for (const [k, v] of top(total, 22)) console.log(`  ${v.toFixed(0).padStart(5)} ms  ${k}`)
await b.close()
