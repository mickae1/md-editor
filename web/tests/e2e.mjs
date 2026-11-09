// End-to-end test in Edge (playwright-core, installed browser).
// Prerequisite: server running on a test project, with APPDATA pointing to an
// empty temporary folder (UI preferences and sessions live in settings.json):
//   APPDATA=<tmp> python server/app.py <copy of sample/Help/Md> --port 8799 --no-window
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
// 409 is an expected API answer (conflict, reference check), not a page error.
page.on('console', m => { if (m.type() === 'error' && !/status of 409/.test(m.text())) errors.push(m.text()) })

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

{
  // The UI state is server-side: refuse to run against the user's own settings.
  const ui = await fetch(URL + 'api/ui').then(r => r.json())
  if (Object.keys(ui.prefs).length || ui.session) {
    console.log('FAIL the server must run with APPDATA set to an empty temporary folder (UI preferences found)')
    process.exit(1)
  }
}
const expandAll = async (rows, p = page) => {
  for (let i = 0; i < 100; i++) {
    const closed = p.locator(`${rows}:not(.open) .twisty`)
    if (!(await closed.count())) return
    await closed.first().click()
  }
}
const openKeys = (sel, p = page) => p.locator(sel).evaluateAll(rows => rows.map(r => r.dataset.id ?? r.title))

await page.goto(URL)
await page.waitForSelector('#loading', { state: 'detached' })
await page.waitForSelector('.tree-item')
check('fresh profile: explorer fully collapsed', await page.locator('.explorer .tree-item.folder.open').count() === 0)
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
await page.screenshot({ path: join(shots, '10a-toc-collapsed.png') })
{
  // Collapsed by default: only the ancestors of topics opened from elsewhere are expanded (reveal).
  const files = await page.locator('.tab').evaluateAll(tabs => tabs.map(t => t.getAttribute('title')))
  const toc = await page.evaluate(() => fetch('/api/toc').then(r => r.json()))
  const allowed = new Set()
  const walk = (nodes, anc) => nodes.forEach(n => { if (files.includes(n.file)) anc.forEach(a => allowed.add(a)); walk(n.children, [...anc, n.id]) })
  walk(toc.tree, [])
  const open = await openKeys('.toc-item.open')
  check('toc collapsed except the paths to opened topics', open.every(id => allowed.has(id)) && await page.locator('.toc-item.has-children:not(.open)').count() > 0, `${open} vs ${[...allowed]}`)
}
await expandAll('.toc-item.has-children')
const row = file => page.locator(`.toc-item[data-file="${file}"]`).first()
const captions = await page.locator('.toc-item .toc-caption').allInnerTexts()
check('toc tree shown', ['Welcome', 'General views', 'Create a scenario', 'Charts'].every(c => captions.includes(c)), captions.join(' | '))
check('toc broken badge', (await tocTab.locator('.badge-count').innerText()) === '1')
check('broken node flagged', (await page.locator('.toc-item.broken').innerText()).includes('Import data'))
check('toc orphan listed', await page.locator('.toc-orphan[data-file="Methodologies-Capacity.md"]').count() === 1)
await page.waitForTimeout(1300) // debounced saves (preferences, session)
check('side tab remembered (server-side)', (await page.evaluate(() => fetch('/api/ui').then(r => r.json()))).prefs.side === 'toc')
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

// Resizable side panels
const width = sel => page.locator(sel).evaluate(el => Math.round(el.getBoundingClientRect().width))
const dragHandle = async (sel, dx) => {
  const box = await page.locator(sel).boundingBox()
  const x = box.x + box.width / 2, y = box.y + 300
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y)
  await page.mouse.move(x + dx, y)
  await page.mouse.up()
}
const left0 = await width('.side.left')
await dragHandle('.panel-resizer.left', 120)
check('left panel widened by dragging', await width('.side.left') === left0 + 120, `${left0} -> ${await width('.side.left')}`)
const right0 = await width('.side.right')
await dragHandle('.panel-resizer.right', -80)
check('right panel widened by dragging', await width('.side.right') === right0 + 80, `${right0} -> ${await width('.side.right')}`)
await page.screenshot({ path: join(shots, '13-resized-panels.png') })
await page.waitForTimeout(500) // debounced preference save
const page3 = await context.newPage()
await page3.goto(URL)
await page3.waitForSelector('.side.left')
check('panel widths restored after reload', await page3.locator('.side.left').evaluate(el => Math.round(el.getBoundingClientRect().width)) === left0 + 120)
await page3.close()
await dragHandle('.panel-resizer.left', -400)
check('left panel width has a minimum', await width('.side.left') === 200)
check('narrow left panel: tab labels hidden', await page.locator('.side-tab-label').first().isHidden())
await page.locator('.panel-resizer.left').dblclick()
check('double-click resets the width', await width('.side.left') === 280)
await page.locator('.panel-resizer.left').focus()
await page.keyboard.press('ArrowRight')
check('arrow key widens the panel', await width('.side.left') === 296)
await page.locator('.panel-resizer.left').dblclick()
await page.locator('.panel-resizer.right').dblclick()
await page.setViewportSize({ width: 900, height: 950 })
await dragHandle('.panel-resizer.left', 500)
check('editor keeps room in a narrow window', await width('.center') >= 360, String(await width('.center')))
await page.locator('.panel-resizer.left').dblclick()
await page.setViewportSize({ width: 1500, height: 950 })

// Files changed outside the editor while the window keeps the focus (Claude, Git...)
await page.locator('.side-tab[data-view="files"]').click()
await openTopic('Analysis-Charts')
const chartsPath = join(root, 'GeneralViews-EntityViewer-Analysis-Charts.md')
const chartsMd = v => '# Charts\n\n' + Array.from({ length: 80 }, (_, i) => `Paragraph ${i} ${v}.`).join('\n\n') + '\n'
const activeText = () => page.locator('.doc-view.active .md-content').first().innerText()
const waitText = (s, timeout = 6000) => page.waitForFunction(x => document.querySelector('.doc-view.active .md-content')?.textContent?.includes(x), s, { timeout }).then(() => true, () => false)
writeFileSync(chartsPath, chartsMd('v1'))
const reloadedV1 = await waitText('Paragraph 79 v1')
if (!reloadedV1) await page.screenshot({ path: join(shots, '14a-external-change-failed.png') })
check('clean file reloaded without any focus event', reloadedV1,
  `active tab: ${await page.locator('.tab.active').innerText()} | modal: ${await page.locator('.modal').count()}`)
await page.locator('.doc-view.active').evaluate(el => { el.scrollTop = 1500 })
writeFileSync(chartsPath, chartsMd('v2'))
check('second external change reloaded', await waitText('Paragraph 79 v2'))
await page.waitForTimeout(300)
const scrolled = await page.locator('.doc-view.active').evaluate(el => el.scrollTop)
check('scroll position kept after reload', Math.abs(scrolled - 1500) < 60, String(scrolled))
check('no dialog for a file without changes', await page.locator('.modal').count() === 0)

await page.locator('.doc-view.active .md-content p').first().click()
await page.keyboard.press('End')
await page.keyboard.type(' LOCAL-EDIT')
await page.waitForTimeout(400)
writeFileSync(chartsPath, chartsMd('v3'))
const asked = await page.waitForSelector('.modal', { timeout: 6000 }).then(() => true, () => false)
const dialogText = asked ? await page.locator('.modal').innerText() : ''
check('unsaved changes: dialog asks', asked && dialogText.includes('Keep my changes') && dialogText.includes('Reload and lose my changes'), dialogText)
await page.locator('.modal .btn', { hasText: 'Keep my changes' }).click()
await page.waitForTimeout(4500)
check('keep: local edit kept', (await activeText()).includes('LOCAL-EDIT') && !(await activeText()).includes('v3'))
check('keep: not asked again for the same version', await page.locator('.modal').count() === 0)
await page.keyboard.press('Control+s')
const conflict = await page.waitForSelector('.modal', { timeout: 4000 }).then(() => true, () => false)
check('keep: saving asks before overwriting the other version', conflict && (await page.locator('.modal').innerText()).includes('Overwrite'))
await page.locator('.modal .btn', { hasText: 'Overwrite' }).click()
await page.waitForTimeout(800)
check('keep: overwrite writes my version', readFileSync(chartsPath, 'utf8').includes('LOCAL-EDIT'))

await page.locator('.doc-view.active .md-content p').first().click()
await page.keyboard.press('End')
await page.keyboard.type(' SECOND-EDIT')
await page.waitForTimeout(400)
writeFileSync(chartsPath, chartsMd('v4'))
await page.waitForSelector('.modal', { timeout: 6000 })
await page.locator('.modal .btn', { hasText: 'Reload and lose my changes' }).click()
check('reload: external version shown', await waitText('Paragraph 79 v4'))
check('reload: local edit dropped, tab clean', !(await activeText()).includes('SECOND-EDIT') && !(await page.locator('.tab.active').innerText()).includes('●'))

writeFileSync(chartsPath, chartsMd('v5') + '\n--8<-- "_snippets/snippet-unused.md"\n')
await page.waitForSelector('.doc-view.active .snippet-block', { timeout: 6000 })
writeFileSync(join(root, '_snippets/snippet-unused.md'), 'SNIPPET-CHANGED-OUTSIDE\n')
check('snippet shown inline reloaded when changed outside', await waitText('SNIPPET-CHANGED-OUTSIDE'))
await page.screenshot({ path: join(shots, '14-external-change.png') })

// ---------------------------------------------------------------------------
// Session: quit, then start again in a NEW browser context (no shared
// localStorage): same tabs, active tab, scroll, expanded nodes, side tab, widths.
// ---------------------------------------------------------------------------
await openTopic('index')
await page.locator('.tab', { hasText: 'GeneralViews-EntityViewer-Analysis-Charts' }).click()
await page.waitForTimeout(300)
await page.locator('.doc-view.active').evaluate(el => { el.scrollTop = 1200 })
const savedScroll = await page.locator('.doc-view.active').evaluate(el => el.scrollTop)
// Explorer: only "Workflow" expanded (the active topic is in another folder).
await page.locator('.side-tab[data-view="files"]').click()
for (let i = 0; i < 50 && await page.locator('.explorer .tree-item.folder.open').count(); i++) await page.locator('.explorer .tree-item.folder.open .twisty').last().click()
await page.locator('.explorer .tree-item.folder', { hasText: 'Workflow' }).first().locator('.twisty').click()
const savedExplorer = await openKeys('.explorer .tree-item.folder.open')
// Table of contents: collapse all, expand "Create a scenario" only.
await page.locator('.side-tab[data-view="toc"]').click()
await page.locator('.toc-toolbar button[title="Collapse all"]').click()
await row('Workflow-CreateScenario.md').locator('.twisty').click()
const savedToc = await openKeys('.toc-item.open')
await dragHandle('.panel-resizer.left', 40)
const savedWidth = await width('.side.left')
const savedTabs = await page.locator('.tab .tab-name').allInnerTexts()
const savedActive = await page.locator('.tab.active .tab-name').innerText()
await page.screenshot({ path: join(shots, '15-before-quit.png') })
// Quit at once: the session leaves with the pagehide beacon (the debounced save has not run).
await page.close({ runBeforeUnload: false })
await new Promise(r => setTimeout(r, 500))

const context2 = await browser.newContext({ viewport: { width: 1500, height: 950 } })
const page4 = await context2.newPage()
page4.on('pageerror', e => errors.push(String(e)))
page4.on('console', m => { if (m.type() === 'error' && !/status of 409/.test(m.text())) errors.push(m.text()) })
await page4.goto(URL)
await page4.waitForSelector('#loading', { state: 'detached' })
const readyMs = await page4.evaluate(() => window.mdeditorReadyMs)
console.log(`     startup: overlay removed after ${readyMs} ms (session of ${savedTabs.length} tabs)`)
check('session: same tabs in the same order', JSON.stringify(await page4.locator('.tab .tab-name').allInnerTexts()) === JSON.stringify(savedTabs), `${await page4.locator('.tab .tab-name').allInnerTexts()} vs ${savedTabs}`)
check('session: same active tab', await page4.locator('.tab.active .tab-name').innerText() === savedActive)
check('session: side tab', await page4.locator('.side-tab.on[data-view="toc"]').count() === 1)
check('session: toc expanded nodes exactly as left (no reveal)', JSON.stringify(await openKeys('.toc-item.open', page4)) === JSON.stringify(savedToc), `${await openKeys('.toc-item.open', page4)} vs ${savedToc}`)
check('session: active topic not revealed in the toc', await page4.locator('.toc-item[data-file="GeneralViews-EntityViewer-Analysis-Charts.md"]').count() === 0)
check('session: panel width', await page4.locator('.side.left').evaluate(el => Math.round(el.getBoundingClientRect().width)) === savedWidth)
// Clickable as soon as the overlay is gone.
const firstTwisty = page4.locator('.toc-item.has-children:not(.open) .twisty').first()
const before = await page4.locator('.toc-item.open').count()
await firstTwisty.click({ timeout: 1000 })
check('tree clickable right after the overlay', await page4.locator('.toc-item.open').count() === before + 1)
await page4.locator('.toc-item.open .twisty').last().click()
await page4.waitForTimeout(1200)
const restoredScroll = await page4.locator('.doc-view.active').evaluate(el => el.scrollTop)
check('session: scroll restored', Math.abs(restoredScroll - savedScroll) <= 50, `${restoredScroll} vs ${savedScroll}`)
await page4.locator('.side-tab[data-view="files"]').click()
check('session: explorer expanded folders exactly as left', JSON.stringify(await openKeys('.explorer .tree-item.folder.open', page4)) === JSON.stringify(savedExplorer), `${await openKeys('.explorer .tree-item.folder.open', page4)} vs ${savedExplorer}`)
await page4.screenshot({ path: join(shots, '16-session-restored.png') })
// Opening a topic from elsewhere (quick open) still reveals it in both trees.
await page4.keyboard.press('Control+p')
await page4.waitForSelector('.palette-input')
await page4.keyboard.type('Analysis-Overview')
await page4.waitForTimeout(200)
await page4.keyboard.press('Enter')
await page4.waitForFunction(() => document.querySelector('.tab.active')?.textContent?.includes('Analysis-Overview'))
check('quick open reveals the topic in the explorer', await page4.locator('.explorer .tree-item.active[data-path="GeneralViews-EntityViewer-Analysis-Overview.md"]').count() === 1)
await page4.locator('.side-tab[data-view="toc"]').click()
check('quick open reveals the topic in the toc', await page4.locator('.toc-item.active[data-file="GeneralViews-EntityViewer-Analysis-Overview.md"]').count() === 1)

// Heading anchor ids ({ #id }), anchor suggestions, mailto links, TODO panel, export
const quickOpen = async name => {
  await page4.keyboard.press('Control+p')
  await page4.waitForSelector('.palette-input')
  await page4.keyboard.type(name)
  await page4.waitForTimeout(200)
  await page4.keyboard.press('Enter')
  await page4.waitForFunction(n => document.querySelector('.tab.active')?.textContent?.includes(n), name)
  await page4.waitForTimeout(300)
}
await quickOpen('GeneralViews-Map')
const h2 = page4.locator('.doc-view.active > .page > .md-content > h2', { hasText: 'Interactions' })
await h2.click({ button: 'right' })
await page4.locator('.popup-menu .menu-item', { hasText: 'Add an anchor ID' }).click()
await page4.waitForSelector('.modal input')
await page4.fill('.modal input', 'interactions-id')
await page4.locator('.modal .btn.primary').click()
await page4.waitForTimeout(300)
check('heading id: set from the context menu', await h2.getAttribute('data-heading-id') === 'interactions-id')
check('heading id: not in the editable text', (await h2.innerText()).trim() === 'Interactions')
await page4.keyboard.press('Control+s')
await page4.waitForTimeout(800)
check('heading id: saved as { #id }', readFileSync(join(root, 'GeneralViews-Map.md'), 'utf8').includes('## Interactions { #interactions-id }'))
await page4.screenshot({ path: join(shots, '17-heading-id.png') })

await page4.locator('.doc-view.active > .page > .md-content > p').last().click()
await page4.keyboard.press('End')
await page4.keyboard.press('Control+k')
await page4.waitForSelector('.modal input[list]')
await page4.fill('.modal input[list]', '#')
await page4.waitForFunction(() => [...document.querySelectorAll('#dl-topics option')].some(o => o.value === '#interactions-id'), null, { timeout: 5000 }).catch(() => undefined)
const anchorOptions = await page4.$$eval('#dl-topics option', o => o.map(x => x.value))
check('link dialog: anchors of the page suggested', anchorOptions.includes('#interactions-id') && anchorOptions.includes('#map-intro'), anchorOptions.join(' '))
await page4.fill('.modal input[list]', 'GeneralViews-EntityViewer-Analysis-Overview.md#')
await page4.waitForFunction(() => [...document.querySelectorAll('#dl-topics option')].some(o => o.value.startsWith('GeneralViews-EntityViewer-Analysis-Overview.md#')), null, { timeout: 5000 }).catch(() => undefined)
const otherOptions = await page4.$$eval('#dl-topics option', o => o.map(x => x.value))
check('link dialog: anchors of another page suggested', otherOptions.some(v => v.startsWith('GeneralViews-EntityViewer-Analysis-Overview.md#')), otherOptions.join(' '))
await page4.locator('.modal .btn', { hasText: 'Cancel' }).click()

writeFileSync(join(root, 'Workflow-CreateScenario.md'), readFileSync(join(root, 'Workflow-CreateScenario.md'), 'utf8') + '\nContact <a href="mailto:toto@toto.fr">Toto</a> or <toto@toto.fr>.\n')
await quickOpen('Workflow-CreateScenario')
await page4.waitForTimeout(2500) // external change picked up
const mailLinks = await page4.locator('.doc-view.active a[href="mailto:toto@toto.fr"]').allInnerTexts()
check('mailto links (HTML and autolink) shown as links, not raw HTML', JSON.stringify(mailLinks) === JSON.stringify(['Toto', 'toto@toto.fr'])
  && await page4.locator('.doc-view.active [data-raw-inline*="mailto"]').count() === 0, mailLinks.join(' | '))
check('TODO highlighted in the editor', await page4.locator('.doc-view.active .todo-mark').count() >= 1)

await page4.locator('.side-tab[data-view="todo"]').click()
await page4.waitForSelector('.todo-hit')
check('TODO panel: TODOs of the project (case sensitive, no code)', await page4.locator('.todo-hit').count() === 2, String(await page4.locator('.todo-hit').count()))
check('TODO panel: summary with singular page', (await page4.locator('.todo-view .search-summary').innerText()) === '2 TODOs in 1 page')
check('TODO badge', (await page4.locator('.side-tab[data-view="todo"] .badge-count').innerText()) === '2')
await quickOpen('GeneralViews-Map')
await page4.locator('.side-tab[data-view="todo"]').click()
await page4.locator('.todo-hit').first().click()
await page4.waitForFunction(() => document.querySelector('.tab.active')?.textContent?.includes('Workflow-CreateScenario'))
await page4.waitForTimeout(400)
check('TODO click: opens the page and selects the TODO', await page4.evaluate(() => getSelection()?.toString()) === 'TODO')
await page4.screenshot({ path: join(shots, '18-todos.png') })

if (process.env.E2E_EXPORT === '1') {
  const siteOut = join(shots, 'exported-site')
  await page4.locator('.title-btn[title^="Export"]').click()
  await page4.locator('.popup-menu .menu-item', { hasText: 'Export the website' }).click()
  await page4.waitForSelector('.modal input[type="text"]')
  await page4.fill('.modal input[type="text"]', siteOut)
  await page4.locator('.modal .btn.primary').click()
  await page4.waitForSelector('.modal-title, .modal h2, .modal', { timeout: 120000 })
  await page4.waitForFunction(() => document.querySelector('.modal')?.textContent?.includes('Export finished'), null, { timeout: 120000 })
  check('export website from the UI', existsSync(join(siteOut, 'GeneralViews-Map.html')) && existsSync(join(siteOut, 'contents.html')))
  await page4.screenshot({ path: join(shots, '19-export-done.png') })
  await page4.locator('.modal .btn', { hasText: 'OK' }).click()
  const pdfOut = join(shots, 'exported.pdf')
  await page4.locator('.title-btn[title^="Export"]').click()
  await page4.locator('.popup-menu .menu-item', { hasText: 'Export a PDF' }).click()
  await page4.waitForSelector('.modal input[type="text"]')
  await page4.fill('.modal input[type="text"]', pdfOut)
  await page4.locator('.modal .btn.primary').click()
  await page4.waitForFunction(() => document.querySelector('.modal')?.textContent?.includes('Export finished'), null, { timeout: 120000 })
  check('export PDF from the UI', existsSync(pdfOut) && readFileSync(pdfOut).subarray(0, 4).toString() === '%PDF')
  await page4.locator('.modal .btn', { hasText: 'OK' }).click()
} else console.log('     skip export from the UI (E2E_EXPORT=1 and MDEDITOR_MKDOCS on the server)')

// Light theme
await page4.evaluate(() => { document.documentElement.dataset.theme = 'light' })
await page4.waitForTimeout(200)
await page4.screenshot({ path: join(shots, '7-light-theme.png') })

check('no JS errors', errors.length === 0, errors.join('\n'))
await browser.close()
console.log(failures ? `\n${failures} failure(s)` : '\nAll OK')
process.exit(failures ? 1 : 0)
