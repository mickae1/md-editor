// CPU profile of opening a big page (not part of npm test).
// Usage: same server as perf.mjs; node tests/perf-open.mjs <big topic name>
import { chromium } from 'playwright-core'

const big = process.argv[2]
const b = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage()
await page.goto('http://127.0.0.1:8794/')
await page.waitForSelector('#loading', { state: 'detached', timeout: 120000 })
const cdp = await page.context().newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
await page.keyboard.press('Control+p')
await page.waitForSelector('.palette-input')
await page.keyboard.type(big)
await page.waitForTimeout(100)
await cdp.send('Profiler.start')
await page.keyboard.press('Enter')
await page.waitForFunction(n => document.querySelector('.tab.active')?.textContent?.includes(n), big)
await page.waitForFunction(() => !document.querySelector('.doc-view.active .snippet-loading'), null, { timeout: 60000 })
await page.waitForTimeout(300)
const { profile } = await cdp.send('Profiler.stop')
const byId = new Map(profile.nodes.map(n => [n.id, n]))
const parent = new Map()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const total = new Map()
let all = 0
profile.samples.forEach((id, i) => {
  const ms = (profile.timeDeltas[i] ?? 0) / 1000
  if (byId.get(id).callFrame.functionName === '(idle)') return
  all += ms
  const seen = new Set()
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const f = byId.get(cur).callFrame
    const k = `${f.functionName || '(anonymous)'} :${f.lineNumber + 1}`
    if (seen.has(k)) continue
    seen.add(k)
    total.set(k, (total.get(k) ?? 0) + ms)
  }
})
console.log(`busy ${all.toFixed(0)} ms while opening`)
for (const [k, v] of [...total].sort((a, c) => c[1] - a[1]).filter(([k]) => !/^\((root|program)\)/.test(k)).slice(0, 26)) console.log(`  ${v.toFixed(0).padStart(5)} ms  ${k}`)
await b.close()
