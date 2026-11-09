// End-to-end test in Edge (playwright-core, installed browser).
// Prerequisite: server running on a test project:
//   python server/app.py <copy of sample/Help/Md> --port 8799 --no-window
// Usage: node tests/e2e.mjs <project folder> <screenshots folder>
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [root, shots] = process.argv.slice(2)
const URL = 'http://127.0.0.1:8799/'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

const openTopic = async name => {
  await page.fill('.explorer .filter', name)
  await page.locator('.tree-item', { hasText: name }).first().click()
  await page.fill('.explorer .filter', '')
  // Opening is asynchronous: wait for its tab (the previous topic matches the selectors too).
  await page.waitForFunction(n => document.querySelector('.tab.active')?.textContent?.includes(n), name)
}

let failures = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' ' + detail}`)
  if (!cond) failures++
}

await page.goto(URL)
await page.waitForSelector('.tree-item')
await page.screenshot({ path: join(shots, '1-home.png') })

// Open a topic with 2 snippets
await openTopic('GeneralViews-Map')
await page.waitForSelector('.doc-view.active .snippet-block .snippet-body .md-content')
await page.waitForTimeout(400)
const blocks = await page.locator('.doc-view.active .snippet-block').count()
check('2 snippets shown inline', blocks === 2, `(${blocks})`)
check('snippets-map label', await page.locator('.doc-view.active .snippet-name', { hasText: 'snippets-map' }).count() === 1)
check('snippet image loaded', await page.locator('.doc-view.active .snippet-block .img-wrap img').evaluate(i => i.naturalWidth > 0))
check('table rendered in the snippet', await page.locator('.doc-view.active .snippet-block table').count() === 1)
check('broken link flagged', await page.locator('.doc-view.active .broken-link').count() >= 1)
check('admonition rendered', await page.locator('.doc-view.active .admonition.warning').count() === 1)
await page.screenshot({ path: join(shots, '2-topic.png') })

// Edit the snippet in place
const para = page.locator('.doc-view.active .snippet-block .md-content p').first()
await para.click()
await page.keyboard.press('End')
await page.keyboard.type(' SNIPPET-EDIT')
await page.waitForTimeout(400)
check('tab marked as modified', await page.locator('.tab.active .tab-dirty.on').count() === 1)

// Save: shared snippet warning (2 topics)
await page.keyboard.press('Control+s')
await page.waitForSelector('.modal')
const modalText = await page.locator('.modal').innerText()
check('shared snippet warning', /used by 2 topics/.test(modalText), modalText)
await page.screenshot({ path: join(shots, '3-warning.png') })
await page.locator('.modal .btn.primary').click()
await page.waitForTimeout(800)
const snippetFile = readFileSync(join(root, '_snippets/snippets-map.md'), 'utf8')
const topicFile = readFileSync(join(root, 'GeneralViews-Map.md'), 'utf8')
check('snippet saved in _snippets', snippetFile.includes('SNIPPET-EDIT'))
check('topic without the snippet content', !topicFile.includes('SNIPPET-EDIT') && topicFile.includes('--8<-- "_snippets/snippets-map.md"'))
check('img kept as HTML', snippetFile.includes('<img src="images/map-overview.svg" alt="Map view" width="480" height="270">'))
check('no BOM / CRLF', !snippetFile.startsWith('﻿') && !snippetFile.includes('\r'))

// The same snippet opened in another topic reflects the change
await openTopic('Overview')
await page.waitForSelector('.doc-view.active .snippet-block .md-content')
await page.waitForTimeout(400)
check('other topic sees the change', (await page.locator('.doc-view.active .snippet-block').first().innerText()).includes('SNIPPET-EDIT'))

// Live sync between two views of the same snippet
const overviewPara = page.locator('.doc-view.active .snippet-block .md-content p').first()
await overviewPara.click()
await page.keyboard.press('End')
await page.keyboard.type(' SYNC')
await page.locator('.tab', { hasText: 'GeneralViews-Map' }).click()
await page.waitForTimeout(300)
check('sync between tabs', (await page.locator('.doc-view.active .snippet-block').first().innerText()).includes('SYNC'))

// Editing in the topic (outside the snippet): title + save
await page.locator('.doc-view.active > .page > .md-content > h1').click()
await page.keyboard.press('End')
await page.keyboard.type(' bis')
await page.keyboard.press('Control+s')
await page.waitForSelector('.modal')
await page.locator('.modal .btn.primary').click()
await page.waitForTimeout(800)
const topic2 = readFileSync(join(root, 'GeneralViews-Map.md'), 'utf8')
check('topic title changed', topic2.startsWith('# Map View bis\n'), topic2.slice(0, 60))
check('anchor kept', topic2.includes('<a id="map-intro"></a>'))

// Snippet insertion palette
await page.locator('.doc-view.active > .page > .md-content > h1').click()
await page.keyboard.press('Control+Shift+I')
await page.waitForSelector('.palette')
await page.keyboard.type('unused')
await page.waitForTimeout(300)
await page.screenshot({ path: join(shots, '4-palette.png') })
await page.keyboard.press('Enter')
await page.waitForTimeout(500)
check('snippet inserted', await page.locator('.doc-view.active .snippet-name', { hasText: 'snippet-unused' }).count() === 1)

// Dedicated tab for a snippet (double-click on the label)
await page.locator('.doc-view.active .snippet-name', { hasText: 'snippet-warning-simulation' }).dblclick()
await page.waitForSelector('.tab.active.snippet')
check('snippet opened in a dedicated tab', (await page.locator('.tab.active').innerText()).includes('snippet-warning-simulation'))
await page.screenshot({ path: join(shots, '5-snippet-tab.png') })

// Topic with tabs, details, ordered list
await openTopic('BasicEditors')
await page.waitForSelector('.doc-view.active .tabbed-set')
await page.waitForTimeout(300)
await page.screenshot({ path: join(shots, '6-tabs-details.png') })
check('tabs rendered', await page.locator('.doc-view.active .tabbed-block').count() === 2)
check('details rendered', await page.locator('.doc-view.active .admonition.is-details').count() === 1)

// Extract to snippet
await openTopic('Methodologies')
await page.waitForSelector('.doc-view.active .md-content p')
await page.locator('.doc-view.active > .page > .md-content > p').first().click({ clickCount: 3 })
await page.locator('.tb-btn[title^="Extract"]').click()
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'snippet-capacity')
await page.locator('.modal .btn.primary').click()
await page.waitForTimeout(800)
check('extraction: snippet block created', await page.locator('.doc-view.active .snippet-name', { hasText: 'snippet-capacity' }).count() === 1)
const extracted = readFileSync(join(root, '_snippets/snippet-capacity.md'), 'utf8')
check('extraction: file written', extracted.includes('**per sector**'), extracted)
await page.keyboard.press('Control+s')
await page.waitForTimeout(800)
check('extraction: topic references the snippet', readFileSync(join(root, 'Methodologies-Capacity.md'), 'utf8').includes('--8<-- "_snippets/snippet-capacity.md"'))

// Insert a 3x2 table
await page.locator('.doc-view.active > .page > .md-content > h1').click()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.locator('.tb-btn[title="Insert table"]').click()
await page.locator('.grid-cell[data-r="3"][data-c="2"]').click()
await page.keyboard.type('Col A')
await page.waitForTimeout(200)
check('table inserted', await page.locator('.doc-view.active > .page > .md-content table').count() === 1)
check('table tools visible', await page.locator('.table-tools:not([hidden])').count() === 1)
await page.screenshot({ path: join(shots, '8-table.png') })
await page.keyboard.press('Control+s')
await page.waitForTimeout(800)
const withTable = readFileSync(join(root, 'Methodologies-Capacity.md'), 'utf8')
check('table in pipe syntax', /\| Col A +\| +\|\n\| -+ \| -+ \|/.test(withTable), withTable)

// External change: automatic reload (file not modified in the editor)
const { writeFileSync } = await import('node:fs')
writeFileSync(join(root, 'Methodologies-Capacity.md'), '# Capacity changed outside\n')
await page.evaluate(() => window.dispatchEvent(new Event('focus')))
await page.waitForTimeout(1000)
check('reload after external change', (await page.locator('.doc-view.active h1').first().innerText()).includes('changed outside'))

// ---------------------------------------------------------------------------
// Links panel: broken links + orphan files
// ---------------------------------------------------------------------------
const tocXml = () => readFileSync(join(root, '../Maps/table_of_contents.xml'), 'utf8')
const { existsSync } = await import('node:fs')
await page.locator('.side-tab[data-view="broken"]').click()
await page.waitForSelector('.broken-view .orphan-file')
check('links panel: topic orphan listed', await page.locator('.orphan-file[data-file="Methodologies-Capacity.md"]').count() === 1)
check('links panel: snippet orphan listed', await page.locator('.orphan-file[data-file="_snippets/snippet-unused.md"]').count() === 1)
const info = await page.evaluate(() => fetch('/api/project').then(r => r.json()))
const linksBadge = await page.locator('.side-tab[data-view="broken"] .badge-count').innerText()
check('links badge = broken + orphans', linksBadge === String(info.broken.length + info.orphans.length), `(${linksBadge} vs ${info.broken.length}+${info.orphans.length})`)
await page.screenshot({ path: join(shots, '9-links-orphans.png') })

// ---------------------------------------------------------------------------
// Table of contents panel
// ---------------------------------------------------------------------------
const tocTab = page.locator('.side-tab[data-view="toc"]')
check('toc tab tooltip', await tocTab.getAttribute('title') === 'Table of contents')
check('side tab labels fit', await page.locator('.side-tabs').evaluate(bar => bar.scrollWidth <= bar.clientWidth && [...bar.querySelectorAll('.side-tab-label')].every(l => l.scrollWidth <= l.clientWidth)))
await tocTab.click()
await page.waitForSelector('.toc-item')
const row = file => page.locator(`.toc-item[data-file="${file}"]`).first()
const captions = await page.locator('.toc-item .toc-caption').allInnerTexts()
check('toc tree shown', ['Welcome', 'General views', 'Create a scenario', 'Charts'].every(c => captions.includes(c)), captions.join(' | '))
check('toc broken badge', (await tocTab.locator('.badge-count').innerText()) === '1')
check('broken node flagged', (await page.locator('.toc-item.broken').innerText()).includes('Import data'))
check('toc orphan listed', await page.locator('.toc-orphan[data-file="Methodologies-Capacity.md"]').count() === 1)
check('side tab remembered', await page.evaluate(() => localStorage.getItem('mdeditor.side')) === 'toc')
{
  const p2 = await context.newPage()
  await p2.goto(URL)
  await p2.waitForSelector('.toc-item')
  check('side tab restored at startup', await p2.locator('.side-tab.on[data-view="toc"]').count() === 1)
  await p2.close()
}

// Click opens the topic, active node highlighted
await row('GeneralViews-EntityViewer-Analysis-Charts.md').click()
await page.waitForTimeout(500)
check('toc click opens the topic', (await page.locator('.tab.active').innerText()).includes('GeneralViews-EntityViewer-Analysis-Charts'))
check('toc active node highlighted', await page.locator('.toc-item.active[data-file="GeneralViews-EntityViewer-Analysis-Charts.md"]').count() === 1)
await page.locator('.tab', { hasText: 'GeneralViews-Map' }).click()
await page.waitForTimeout(300)
check('toc follows the active tab', await page.locator('.toc-item.active[data-file="GeneralViews-Map.md"]').count() === 1)
await page.screenshot({ path: join(shots, '10-toc.png') })

// Rename with F2
await row('GeneralViews-BasicEditors.md').click()
await page.waitForTimeout(400)
await page.keyboard.press('F2')
await page.waitForSelector('.toc-rename')
await page.keyboard.press('Control+a')
await page.keyboard.type('Basic editors renamed')
await page.keyboard.press('Enter')
await page.waitForTimeout(600)
check('rename writes the caption', tocXml().includes('<caption translate="true">Basic editors renamed</caption>'))

// Add a topic inside "Create a scenario" (ID prefixed like its children)
await row('Workflow-CreateScenario.md').click()
await page.waitForTimeout(400)
await page.locator('.toc-toolbar button[title^="Add topic"]').click()
await page.waitForSelector('.modal input')
await page.locator('.modal input').first().fill('Export results')
const newId = await page.locator('.modal input').nth(1).inputValue()
check('topic ID generated with the sibling prefix', newId === 'Workflow-Export-results', newId)
await page.screenshot({ path: join(shots, '11-toc-add.png') })
await page.locator('.modal .btn.primary').click()
await page.waitForTimeout(800)
check('add topic creates the file', existsSync(join(root, 'Workflow-Export-results.md')) && readFileSync(join(root, 'Workflow-Export-results.md'), 'utf8') === '# Export results\n')
check('add topic opens it', (await page.locator('.tab.active').innerText()).includes('Workflow-Export-results'))
check('add topic in the XML', tocXml().includes('href="Workflow-Export-results"'))

// Drag & drop "Basic editors" into "Create a scenario"
await row('GeneralViews-BasicEditors.md').dragTo(row('Workflow-CreateScenario.md'), { targetPosition: { x: 60, y: 13 } })
await page.waitForTimeout(800)
{
  const toc = await page.evaluate(() => fetch('/api/toc').then(r => r.json()))
  const scenario = toc.tree.find(n => n.href === 'Workflow-CreateScenario')
  const xml = tocXml()
  check('drag & drop moves the node (tree)', scenario?.children.some(n => n.href === 'GeneralViews-BasicEditors'), JSON.stringify(scenario?.children.map(n => n.href)))
  check('drag & drop moves the node (XML)', xml.indexOf('href="GeneralViews-BasicEditors"') > xml.indexOf('href="Workflow-CreateScenario"'))
}

// Orphan dragged after "Welcome": added to the menu with its first heading
await page.locator('.toc-orphan[data-file="Methodologies-Capacity.md"]').dragTo(row('index.md'), { targetPosition: { x: 60, y: 23 } })
await page.waitForTimeout(800)
{
  const xml = tocXml()
  check('orphan added to the XML', /href="Methodologies-Capacity"[^>]*>\s*<caption[^>]*>Capacity changed outside</.test(xml), xml.slice(0, 600))
  check('orphan gone from the list', await page.locator('.toc-orphan[data-file="Methodologies-Capacity.md"]').count() === 0)
  const toc = await page.evaluate(() => fetch('/api/toc').then(r => r.json()))
  check('orphan inserted after Welcome', toc.tree[1]?.href === 'Methodologies-Capacity', toc.tree.map(n => n.href).join(','))
}

// Delete a referenced topic: the references are listed, Cancel keeps the file
const deleteBasic = async () => {
  await row('GeneralViews-BasicEditors.md').click({ button: 'right' })
  await page.locator('.popup-menu .menu-item', { hasText: 'Delete topic' }).click()
  await page.waitForSelector('.modal .ref-item')
}
await deleteBasic()
const refsText = await page.locator('.modal .ref-scroll').innerText()
// Line of the link in GeneralViews-Map.md as saved earlier in this flow (13 in sample/)
const linkLine = readFileSync(join(root, 'GeneralViews-Map.md'), 'utf8').split('\n').findIndex(l => l.includes('GeneralViews-BasicEditors.md')) + 1
check('delete lists the references', linkLine > 0 && new RegExp(`GeneralViews-Map\\s*:${linkLine}\\b`).test(refsText), `line ${linkLine}: ${refsText}`)
await page.screenshot({ path: join(shots, '12-delete-refs.png') })
await page.locator('.modal .btn', { hasText: 'Cancel' }).click()
await page.waitForTimeout(300)
check('cancel keeps the file', existsSync(join(root, 'GeneralViews-BasicEditors.md')) && tocXml().includes('href="GeneralViews-BasicEditors"'))
await deleteBasic()
await page.locator('.modal .btn', { hasText: 'Delete anyway' }).click()
await page.waitForTimeout(1000)
check('delete anyway removes the file', !existsSync(join(root, 'GeneralViews-BasicEditors.md')) && !tocXml().includes('href="GeneralViews-BasicEditors"'))
await page.locator('.side-tab[data-view="broken"]').click()
await page.waitForTimeout(300)
check('links panel shows the new broken link', (await page.locator('.broken-view .search-hit:not(.orphan-file)').allInnerTexts()).some(x => x.includes('GeneralViews-Map') && x.includes('BasicEditors')))
await page.locator('.side-tab[data-view="toc"]').click()

// Light theme
await page.evaluate(() => { localStorage.setItem('mdeditor.theme', 'light'); document.documentElement.dataset.theme = 'light' })
await page.waitForTimeout(200)
await page.screenshot({ path: join(shots, '7-light-theme.png') })

check('no JS errors', errors.length === 0, errors.join('\n'))
await browser.close()
console.log(failures ? `\n${failures} failure(s)` : '\nAll OK')
process.exit(failures ? 1 : 0)
