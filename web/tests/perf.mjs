// Performance measurements on a large project (not part of npm test).
// Usage: APPDATA=<tmp> python server/app.py <big>/Md --port 8794 --no-window
//        node tests/perf.mjs [big topic name]
import { chromium } from 'playwright-core'

const URL = 'http://127.0.0.1:8794/'
const big = process.argv[2] ?? ''
const b = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage()

// Long tasks (main thread blocked > 50 ms) are collected in the page.
await page.addInitScript(() => {
  window.__long = []
  new PerformanceObserver(list => { for (const e of list.getEntries()) window.__long.push(Math.round(e.duration)) }).observe({ entryTypes: ['longtask'] })
})
const longTasks = async label => {
  const l = await page.evaluate(() => { const x = window.__long; window.__long = []; return x })
  console.log(`  ${label}: longest blocked ${Math.max(0, ...l)} ms, total ${l.reduce((a, c) => a + c, 0)} ms in ${l.length} long tasks`)
}

let t = Date.now()
await page.goto(URL)
await page.waitForSelector('#loading', { state: 'detached', timeout: 120000 })
console.log(`startup: ${Date.now() - t} ms (app ready ${await page.evaluate(() => window.mdeditorReadyMs)} ms)`)
await longTasks('startup')

// Open the big topic with quick open.
t = Date.now()
await page.keyboard.press('Control+p')
await page.waitForSelector('.palette-input')
await page.keyboard.type(big)
await page.waitForTimeout(100)
await page.keyboard.press('Enter')
await page.waitForFunction(n => document.querySelector('.tab.active')?.textContent?.includes(n), big, { timeout: 60000 })
await page.waitForSelector('.doc-view.active .md-content p')
console.log(`open big topic: ${Date.now() - t} ms, ${await page.locator('.doc-view.active .md-content > *').count()} blocks, ${await page.locator('.doc-view.active .snippet-block').count()} snippets`)
await page.waitForTimeout(1500)
await longTasks('open big topic')

// Typing latency: time from key press to the next painted frame.
await page.locator('.doc-view.active .md-content > p').nth(40).click()
await page.keyboard.press('End')
const lat = []
for (let i = 0; i < 30; i++) {
  lat.push(await page.evaluate(() => new Promise(resolve => {
    const t0 = performance.now()
    const ed = document.activeElement
    ed.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true }))
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)))
  })))
}
// Real key presses too (includes Playwright overhead, comparable between runs).
t = Date.now()
await page.keyboard.type('abcdefghijklmnopqrstuvwxyz0123')
const typed = (Date.now() - t) / 30
lat.sort((a, c) => a - c)
console.log(`typing: median ${lat[15].toFixed(1)} ms / key to frame, worst ${lat[29].toFixed(1)} ms; keyboard.type ${typed.toFixed(1)} ms per key`)
await page.waitForTimeout(1500)
await longTasks('typing (+ 250 ms dirty check)')

// Window focus: project reload + external change check.
t = Date.now()
await page.evaluate(() => window.dispatchEvent(new Event('focus')))
await page.waitForTimeout(3000)
await longTasks('focus (project reload)')

// Tree rendering: switch side tabs.
for (const v of ['files', 'toc', 'broken', 'todo', 'files']) {
  t = Date.now()
  await page.locator(`.side-tab[data-view="${v}"]`).click()
  await page.waitForTimeout(50)
  console.log(`  side tab ${v}: ${Date.now() - t} ms`)
}
await longTasks('side tabs')
await b.close()
