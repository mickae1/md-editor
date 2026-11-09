import '@fontsource/roboto/400.css'
import '@fontsource/roboto/400-italic.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import '@fontsource/roboto-mono/400.css'
import './styles/app.css'
import './styles/content.css'

import { api, rawUrl } from './api'
import { ctx, type ProjectInfo } from './context'
import { SnippetStore } from './snippets/store'
import { dirname, join, normalize, relative } from './paths'
import { h } from './ui/dom'
import { alertDialog, confirmDialog, popupMenu, toast } from './ui/dialogs'
import { icon } from './ui/icons'
import { palette } from './ui/palette'
import { Workspace } from './app/workspace'
import { Explorer } from './app/explorer'
import { TocPanel } from './app/toc'
import { SnippetsPanel, showUsage } from './app/snippetsPanel'
import { Toolbar } from './app/toolbar'
import { BrokenLinksView, SearchView, projectSettings, showDiff, showSource } from './app/views'
import * as cmd from './app/commands'
import { i18n, t } from './i18n'

// --------------------------------------------------------------------------
// Local preferences (convenience only)
// --------------------------------------------------------------------------
// Placeholder of an empty paragraph (content.css), as a CSS string.
document.documentElement.style.setProperty('--empty-placeholder', JSON.stringify(t('editor.emptyPlaceholder')))

const pref = {
  get(key: string, def: string) { try { return localStorage.getItem(`mdeditor.${key}`) ?? def } catch { return def } },
  set(key: string, v: string) { try { localStorage.setItem(`mdeditor.${key}`, v) } catch { /* unavailable */ } },
}

// --------------------------------------------------------------------------
// Layout
// --------------------------------------------------------------------------
const tabBar = h('div', { class: 'tabbar' })
const editorArea = h('div', { class: 'editor-area' })
const emptyState = h('div', { class: 'empty-state' },
  h('div', null, h('p', null, t('main.emptyOpen')),
    h('p', { class: 'hint' }, t('main.emptyHint'))))
editorArea.append(emptyState)

ctx.snippets = new SnippetStore()
const ws = new Workspace(tabBar, editorArea, emptyState)
const explorer = new Explorer()
const searchView = new SearchView(ws)
/** Closes the tab of a file; false if the user cancelled (unsaved changes). */
async function closeFile(path: string) {
  const doc = ws.find(path)
  if (doc) await ws.close(doc)
  return !ws.find(path)
}
const tocBadge = h('span', { class: 'badge-count' })
const tocPanel = new TocPanel({ closeFile, onBroken: n => { tocBadge.textContent = n ? String(n) : '' } })
const brokenView = new BrokenLinksView({ addToToc: path => { void tocPanel.addOrphan(path) }, closeFile })
const toolbar = new Toolbar({ showDiff: () => showDiff(ws), showSource: () => showSource(ws) })
const snippetsPanel = new SnippetsPanel({
  insert: path => cmd.insertSnippetAt(path),
  create: () => cmd.createSnippet(),
  extract: () => cmd.extractSnippet(),
})

type SideView = 'files' | 'toc' | 'search' | 'broken'
const sideViews: Record<SideView, HTMLElement> = { files: explorer.el, toc: tocPanel.el, search: searchView.el, broken: brokenView.el }
const sideContent = h('div', { class: 'side-content' })
const sideTabs = h('div', { class: 'side-tabs' })
let currentSide: SideView = 'files'
function showSide(v: SideView, remember = true) {
  currentSide = v
  if (remember) pref.set('side', v)
  sideContent.replaceChildren(sideViews[v])
  sideTabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.view === v))
  if (v === 'broken') brokenView.render()
  if (v === 'search') searchView.focus()
  if (v === 'toc') tocPanel.render()
}
const sideTab = (v: SideView, name: Parameters<typeof icon>[0], label: string, title = label) =>
  h('button', { class: 'side-tab', dataset: { view: v }, title, onclick: () => showSide(v) }, h('span', { class: 'side-tab-icon' }, icon(name, 16)), h('span', { class: 'side-tab-label' }, label))
sideTabs.append(sideTab('files', 'folder', t('main.tabFiles')), sideTab('toc', 'tree', t('main.tabToc'), t('main.tabTocTooltip')), sideTab('search', 'search', t('main.tabSearch')), sideTab('broken', 'brokenLink', t('main.tabLinks')))

const projectName = h('span', { class: 'project-name' })
const statusLeft = h('span')
const statusRight = h('span')
const brokenBadge = h('span', { class: 'badge-count' })
// Badges over the icon (four tabs share 280px).
sideTabs.querySelector('[data-view="broken"] .side-tab-icon')?.append(brokenBadge)
sideTabs.querySelector('[data-view="toc"] .side-tab-icon')?.append(tocBadge)

const leftPanel = h('aside', { class: 'side left' }, sideTabs, sideContent)
const rightPanel = h('aside', { class: 'side right' }, snippetsPanel.el)
const titlebar = h('header', { class: 'titlebar' },
  h('span', { class: 'app-name' }, icon('file', 16), 'mdEditor'),
  projectName,
  h('span', { class: 'spacer' }),
  hbtn('folderOpen', t('main.openFolderTooltip'), () => openFolderDialog()),
  hbtn('search', t('main.openTopicTooltip'), () => quickOpen()),
  hbtn('save', t('main.saveTooltip'), () => saveActive()),
  hbtn('play', t('main.buildPreviewTooltip'), () => buildPreview()),
  hbtn('settings', t('main.projectSettings'), () => projectSettings()),
  hbtn('panelLeft', t('main.toggleExplorer'), () => togglePanel(leftPanel, 'left')),
  hbtn('panelRight', t('main.toggleSnippets'), () => togglePanel(rightPanel, 'right')),
  hbtn(pref.get('theme', 'dark') === 'dark' ? 'sun' : 'moon', t('main.theme'), e => themeMenu(e)))
const center = h('section', { class: 'center' }, tabBar, toolbar.el, editorArea)
const welcome = h('div', { class: 'welcome' })
const main = h('div', { class: 'main' }, leftPanel, center, rightPanel, welcome)
const statusbar = h('footer', { class: 'statusbar' }, statusLeft, h('span', { class: 'spacer' }), statusRight)
document.getElementById('app')!.append(titlebar, main, statusbar)
// Last side tab (the table of contents one falls back to Files when the project has none).
const savedSide = pref.get('side', 'files') as SideView
showSide(savedSide in sideViews ? savedSide : 'files', false)
let sideRestored = false

function hbtn(name: Parameters<typeof icon>[0], title: string, run: (e: MouseEvent) => void) {
  return h('button', { class: 'icon-btn title-btn', title, onclick: run }, icon(name, 17))
}

function togglePanel(panel: HTMLElement, key: string) {
  panel.hidden = !panel.hidden
  pref.set(`panel.${key}`, panel.hidden ? '0' : '1')
}
leftPanel.hidden = pref.get('panel.left', '1') === '0'
rightPanel.hidden = pref.get('panel.right', '1') === '0'

// --------------------------------------------------------------------------
// Theme
// --------------------------------------------------------------------------
const themeLinks: HTMLLinkElement[] = []
function applyTheme() {
  const theme = pref.get('theme', 'dark')
  document.documentElement.dataset.theme = theme
  // Scheme names come from the project's mkdocs.yml, so that its extra_css applies.
  const schemes = ctx.project?.colorSchemes ?? { dark: 'slate', light: 'default' }
  document.documentElement.setAttribute('data-md-color-scheme', theme === 'dark' ? schemes.dark : schemes.light)
  themeLinks.forEach(l => l.remove())
  themeLinks.length = 0
  if (pref.get('projectCss', '0') === '1' && ctx.project) {
    for (const css of ctx.project.themeCss) {
      const link = h('link', { rel: 'stylesheet', href: rawUrl(css) })
      document.head.append(link)
      themeLinks.push(link)
    }
  }
}
function themeMenu(e: MouseEvent) {
  const btn = e.currentTarget as HTMLElement
  const r = btn.getBoundingClientRect()
  const css = ctx.project?.themeCss ?? []
  popupMenu(r.left - 160, r.bottom + 4, [
    { label: t('main.themeDark'), icon: icon('moon', 14), action: () => { pref.set('theme', 'dark'); applyTheme(); btn.replaceChildren(icon('sun', 17)) } },
    { label: t('main.themeLight'), icon: icon('sun', 14), action: () => { pref.set('theme', 'light'); applyTheme(); btn.replaceChildren(icon('moon', 17)) } },
    'sep',
    {
      label: `${pref.get('projectCss', '0') === '1' ? '✓ ' : ''}${css.length ? t('main.projectCss') : t('main.projectCssNone')}`,
      disabled: !css.length,
      action: () => { pref.set('projectCss', pref.get('projectCss', '0') === '1' ? '0' : '1'); applyTheme() },
    },
    'sep',
    ...[{ code: 'auto', name: t('lang.auto') }, ...i18n.languages].map(l => ({
      label: `${i18n.setting === l.code ? '✓ ' : ''}${l.name}`,
      icon: icon('globe', 14),
      action: () => changeLanguage(l.code),
    })),
    { label: t('lang.openFolder'), icon: icon('folderOpen', 14), action: () => { api.openLanguageFolder().catch(e => toast((e as Error).message, 'error')) } },
  ])
}

/** Saves the language and reloads the window (unsaved changes trigger the usual prompt). */
async function changeLanguage(code: string) {
  if (code === i18n.setting) return
  await api.setLanguage(code)
  location.reload()
}
applyTheme()

// --------------------------------------------------------------------------
// Shared services (ctx)
// --------------------------------------------------------------------------
let fileSet = new Set<string>()

ctx.openFile = (path, anchor) => { void ws.open(normalize(path), anchor) }
ctx.setActiveEditor = editor => { ctx.activeEditor = editor; toolbar.update(); updateStatus() }
ctx.onEditorChange = () => toolbar.update()
ctx.imageUrl = (src, host) => {
  if (!src || /^(https?:|data:|blob:)/i.test(src)) return src
  return rawUrl(join(dirname(host.docPath), decodeURI(src)))
}
ctx.includePath = src => {
  const base = ctx.project?.basePath ?? '.'
  const clean = src.replace(/(\.md):[^/]*$/i, '$1') // file.md:section
  return join(base, clean)
}
ctx.includeSrc = path => relative(ctx.project?.basePath ?? '.', path)
ctx.fileExists = path => fileSet.has(normalize(path))
ctx.usageOf = path => ctx.project?.usage[path] ?? []
ctx.editSnippetLabel = path => showUsage(path)
ctx.reloadProject = async () => {
  try { applyProjectInfo(await api.project()) } catch { /* ignore */ }
}
ctx.setProject = async (info, keepTabs = false) => {
  const reopen = keepTabs ? ws.docs.map(d => d.path) : []
  const active = ws.active?.path
  ws.closeAll()
  ctx.snippets.clear()
  applyProjectInfo(info)
  for (const p of reopen) await ws.open(p)
  if (active) await ws.open(active)
}

function applyProjectInfo(info: ProjectInfo | null) {
  ctx.project = info
  fileSet = new Set(info?.files.map(f => f.path) ?? [])
  projectName.textContent = info ? info.root : ''
  document.title = info ? `${info.name} — mdEditor` : 'mdEditor'
  welcome.hidden = !!info
  main.classList.toggle('no-project', !info)
  explorer.render()
  snippetsPanel.render()
  if (currentSide === 'broken') brokenView.render()
  void tocPanel.load()
  if (info && !sideRestored) {
    sideRestored = true
    if (currentSide === 'toc' && !info.tocFile) showSide('files', false)
  }
  const nBroken = (info?.broken.length ?? 0) + (info?.orphans?.length ?? 0)
  brokenBadge.textContent = nBroken ? String(nBroken) : ''
  ws.renderTabs()
  applyTheme()
  updateStatus()
  if (!info) renderWelcome()
}

ws.onChange(() => {
  explorer.setActive(ws.active?.path ?? null)
  tocPanel.setActive(ws.active?.path ?? null)
  snippetsPanel.render()
  updateStatus()
  toolbar.update()
})

function updateStatus() {
  const d = ws.active
  const p = ctx.project
  statusLeft.replaceChildren()
  if (d) {
    statusLeft.append(h('span', null, d.path))
    if (d.kind === 'snippet') {
      const n = ctx.usageOf(d.path).length
      statusLeft.append(h('span', { class: `status-chip ${n > 1 ? 'warn' : ''}` }, t('main.snippetUsage', { n })))
    }
    const inner = ctx.activeEditor && ctx.activeEditor !== d.editor ? t('main.editingInSnippet') : ''
    if (inner) statusLeft.append(h('span', { class: 'status-chip' }, inner))
  }
  const dirty = ws.docs.filter(x => ws.hasChanges(x)).length + ctx.snippets.dirtyPaths().filter(x => !ws.find(x)).length
  statusRight.textContent = p
    ? `${t('main.fileCounts', { topics: p.files.filter(f => f.kind === 'topic').length, snippets: p.files.filter(f => f.kind === 'snippet').length })}${dirty ? ` · ${t('main.unsavedCount', { n: dirty })}` : ''}`
    : ''
}

// --------------------------------------------------------------------------
// Global actions
// --------------------------------------------------------------------------
async function openFolderDialog() {
  if (ws.anyDirty() && !(await confirmDialog(t('main.unsavedTitle'), t('main.unsavedOpenFolder'), t('main.continue'), true))) return
  const r = await api.pickFolder(t('main.pickFolderTitle'), ctx.project?.root)
  if (r.path) await openProject(r.path)
}

async function openProject(path: string) {
  try {
    const info = await api.openProject(path)
    await ctx.setProject!(info)
    const last = pref.get(`last.${info.root}`, '')
    if (last && fileSet.has(last)) ctx.openFile(last)
  } catch (e) {
    await alertDialog(t('main.openFolder'), (e as Error).message)
  }
}

async function saveActive() {
  if (ws.active) await ws.save(ws.active)
}

async function quickOpen() {
  if (!ctx.project) return
  const picked = await palette({
    title: t('main.openFileTitle'),
    placeholder: t('main.openFilePlaceholder'),
    items: ctx.project.files.map(f => ({ label: f.path.replace(/\.md$/, ''), value: f.path, badge: f.kind === 'snippet' ? 'snippet' : undefined })),
  })
  if (picked) ctx.openFile(picked.value)
}

async function buildPreview() {
  if (!ctx.project?.mkdocs) { toast(t('main.noMkdocs'), 'error'); return }
  toast(t('main.mkdocsStarting'))
  try {
    const { url } = await api.mkdocsServe()
    const d = ws.active
    let page = ''
    if (d && d.kind === 'topic') page = d.path.replace(/(^|\/)index\.md$/i, '$1').replace(/\.md$/i, '/')
    window.open(url + page, '_blank')
  } catch (e) {
    toast(t('main.mkdocsError', { error: (e as Error).message }), 'error', 7000)
  }
}

function renderWelcome() {
  api.state().then(s => {
    welcome.replaceChildren(h('div', { class: 'welcome-box' },
      h('h1', null, 'mdEditor'),
      h('p', { class: 'hint' }, t('main.tagline')),
      h('button', { class: 'btn primary big', onclick: () => openFolderDialog() }, icon('folderOpen', 18), t('main.openFolderButton')),
      s.recent.length ? h('div', { class: 'recent' },
        h('h3', null, t('main.recentFolders')),
        ...s.recent.map(r => h('button', { class: 'recent-item', onclick: () => openProject(r), title: r }, icon('folder', 14), r))) : null))
  })
}

// --------------------------------------------------------------------------
// Keyboard shortcuts
// --------------------------------------------------------------------------
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  if (mod && key === 's') { e.preventDefault(); if (e.shiftKey) ws.saveAll(); else saveActive() }
  else if (mod && key === 'p') { e.preventDefault(); quickOpen() }
  else if (mod && key === 'o') { e.preventDefault(); openFolderDialog() }
  else if (mod && key === 'k') { e.preventDefault(); cmd.editLink() }
  else if (mod && e.shiftKey && key === 'i') { e.preventDefault(); cmd.pickAndInsertSnippet() }
  else if (mod && e.shiftKey && key === 'f') { e.preventDefault(); leftPanel.hidden = false; showSide('search') }
  else if (e.altKey && key === 'w') { e.preventDefault(); if (ws.active) ws.close(ws.active) }
  else if (mod && key === 'tab') {
    e.preventDefault()
    if (ws.docs.length < 2 || !ws.active) return
    const i = ws.docs.indexOf(ws.active)
    ws.activate(ws.docs[(i + (e.shiftKey ? -1 : 1) + ws.docs.length) % ws.docs.length])
  }
  else if (e.key === 'F5' && !mod) { e.preventDefault(); ctx.reloadProject?.() } // prevents reloading the page
}, true)

// --------------------------------------------------------------------------
// Window lifecycle
// --------------------------------------------------------------------------
window.addEventListener('beforeunload', e => {
  if (ws.anyDirty()) { e.preventDefault(); e.returnValue = '' }
  if (ws.active) pref.set(`last.${ctx.project?.root}`, ws.active.path)
})
window.addEventListener('pagehide', () => navigator.sendBeacon('/api/bye'))
const ping = () => fetch('/api/ping').catch(() => undefined)
ping()
setInterval(ping, 20_000)
window.addEventListener('focus', () => { ws.checkExternalChanges(); ctx.reloadProject?.() })

api.state().then(s => applyProjectInfo(s.project)).catch(() => applyProjectInfo(null))
