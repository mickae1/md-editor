// Secondary views: project search, broken links, settings,
// diff of changes, generated Markdown.
import { diffLines } from 'diff'
import { api, type SearchHit } from '../api'
import { ctx } from '../context'
import { serializeDoc } from '../markdown/serializer'
import { basename } from '../paths'
import { h } from '../ui/dom'
import { confirmDialog, modal, popupMenu, toast } from '../ui/dialogs'
import { icon } from '../ui/icons'
import type { Workspace } from './workspace'
import { relativeToRoot } from './toc'
import { deleteFileFlow } from './deleteFile'
import { t } from '../i18n'

export class SearchView {
  el: HTMLElement
  private query = h('input', { type: 'search', placeholder: t('views.searchPlaceholder') })
  private replacement = h('input', { type: 'text', placeholder: t('views.replacePlaceholder') })
  private regex = h('input', { type: 'checkbox' })
  private caseSens = h('input', { type: 'checkbox' })
  private results = h('div', { class: 'search-results' })
  private hits: SearchHit[] = []

  constructor(private ws: Workspace) {
    this.query.addEventListener('keydown', e => { if (e.key === 'Enter') this.run() })
    this.el = h('div', { class: 'search-view' },
      h('div', { class: 'search-form' },
        this.query,
        h('div', { class: 'row' },
          h('label', { class: 'check' }, this.caseSens, 'Aa'),
          h('label', { class: 'check' }, this.regex, '.* regex'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', onclick: () => this.run() }, t('views.search'))),
        this.replacement,
        h('div', { class: 'row' }, h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', onclick: () => this.replaceAll() }, t('views.replaceAll')))),
      this.results)
  }

  focus() { this.query.focus(); this.query.select() }

  async run() {
    const q = this.query.value
    if (!q) { this.results.replaceChildren(); return }
    try {
      this.hits = await api.search(q, this.regex.checked, this.caseSens.checked)
    } catch (e) {
      this.results.replaceChildren(h('div', { class: 'empty-hint error' }, (e as Error).message))
      return
    }
    const byFile = new Map<string, SearchHit[]>()
    for (const hit of this.hits) byFile.set(hit.file, [...(byFile.get(hit.file) ?? []), hit])
    this.results.replaceChildren(
      h('div', { class: 'search-summary' }, t('views.searchSummary', { results: t('views.resultCount', { n: this.hits.length }), files: t('views.fileCount', { n: byFile.size }) })),
      ...[...byFile].map(([file, hits]) => h('div', { class: 'search-file' },
        h('div', { class: 'search-file-name', onclick: () => ctx.openFile(file) }, icon(this.ws.isSnippetPath(file) ? 'puzzle' : 'file', 13), basename(file, '.md'), h('span', { class: 'count' }, String(hits.length))),
        ...hits.slice(0, 50).map(hit => h('div', {
          class: 'search-hit', title: t('views.lineTooltip', { line: hit.line }),
          onclick: async () => { await ctx.openFile(file); this.selectInEditor(q) },
        }, h('span', { class: 'line' }, String(hit.line)), hit.text)))))
  }

  /** Selects the first occurrence in the active editor. */
  private selectInEditor(q: string) {
    const ed = ctx.activeEditor
    if (!ed || this.regex.checked) return
    const needle = this.caseSens.checked ? q : q.toLowerCase()
    let found = -1
    ed.state.doc.descendants((node, pos) => {
      if (found >= 0 || !node.isText) return found < 0
      const text = this.caseSens.checked ? node.text! : node.text!.toLowerCase()
      const i = text.indexOf(needle)
      if (i >= 0) found = pos + i
      return false
    })
    if (found >= 0) {
      ed.chain().focus().setTextSelection({ from: found, to: found + q.length }).scrollIntoView().run()
    }
  }

  async replaceAll() {
    const q = this.query.value
    if (!q) return
    await this.run()
    const files = [...new Set(this.hits.map(h => h.file))]
    const blocked = files.filter(f => this.ws.find(f)?.dirty || ctx.snippets.isDirty(f))
    const todo = files.filter(f => !blocked.includes(f))
    if (!todo.length) { toast(t('views.noFilesToChange')); return }
    const ok = await confirmDialog(t('views.replaceAll'),
      t('views.replaceConfirm', { search: q, replacement: this.replacement.value, files: t('views.fileCount', { n: todo.length }) }) +
      (blocked.length ? '\n\n' + t('views.replaceSkipped', { n: blocked.length }) : '') +
      '\n\n' + t('views.replaceWarning'), t('views.replace'), true)
    if (!ok) return
    const { changed } = await api.replace(q, this.replacement.value, todo, this.regex.checked, this.caseSens.checked)
    toast(t('views.replaceSummary', { replacements: t('views.replacementCount', { n: changed.reduce((s, c) => s + c.count, 0) }), files: t('views.fileCount', { n: changed.length }) }), 'success')
    await this.ws.checkExternalChanges()
    await ctx.reloadProject?.()
    await this.run()
  }
}

export interface BrokenLinksOptions {
  /** Adds an existing topic to the table of contents. */
  addToToc: (path: string) => void
  closeFile: (path: string) => Promise<boolean>
}

export class BrokenLinksView {
  el = h('div', { class: 'broken-view' })
  constructor(private opts: BrokenLinksOptions) {}

  render() {
    const broken = ctx.project?.broken ?? []
    const orphans = ctx.project?.orphans ?? []
    if (!broken.length && !orphans.length) { this.el.replaceChildren(h('div', { class: 'empty-hint' }, t('views.nothingToReport'))); return }
    this.el.replaceChildren(
      h('div', { class: 'side-section-title' }, icon('brokenLink', 13), t('views.brokenCount', { n: broken.length })),
      ...(broken.length ? broken.map(b => h('div', {
        class: 'search-hit', title: `${b.file}:${b.line}`,
        onclick: () => ctx.openFile(b.file),
      }, icon(b.type === 'snippet' ? 'puzzle' : 'brokenLink', 13),
      h('span', { class: 'broken-file' }, basename(b.file, '.md')), h('span', { class: 'line' }, `:${b.line}`), ' → ', h('code', null, b.target)))
        : [h('div', { class: 'empty-hint small' }, t('views.noBrokenLinks'))]),
      h('div', { class: 'side-section-title' }, icon('fileX', 13), t('views.orphanCount', { n: orphans.length })),
      h('div', { class: 'side-section-hint' }, t('views.orphanHint')),
      ...(orphans.length ? orphans.map(o => this.orphanRow(o))
        : [h('div', { class: 'empty-hint small' }, t('views.noOrphans'))]))
  }

  private orphanRow(o: { file: string; type: 'topic' | 'snippet' }) {
    const row = h('div', {
      class: 'search-hit orphan-file', title: o.file, dataset: { file: o.file },
      onclick: () => ctx.openFile(o.file),
    }, icon(o.type === 'snippet' ? 'puzzle' : 'file', 13), h('span', { class: 'broken-file' }, o.file.replace(/\.md$/i, '')))
    row.addEventListener('contextmenu', e => {
      e.preventDefault()
      popupMenu(e.clientX, e.clientY, [
        { label: t('views.menuOpen'), icon: icon('file', 14), action: () => ctx.openFile(o.file) },
        ...(o.type === 'topic' ? [{ label: t('views.menuAddToToc'), icon: icon('plus', 14), disabled: !ctx.project?.tocFile, action: () => this.opts.addToToc(o.file) }] : []),
        { label: t('views.menuCopyPath'), icon: icon('copy', 14), action: () => { void navigator.clipboard.writeText(o.file) } },
        'sep',
        { label: t('views.menuDeleteFile'), icon: icon('trash', 14), action: () => { void deleteFileFlow(o.file, this.opts.closeFile) } },
      ])
    })
    return row
  }
}

export async function projectSettings() {
  const p = ctx.project
  if (!p) return
  if (ctx.snippets.dirtyPaths().length || document.querySelector('.tab-dirty.on')) {
    toast(t('views.saveBeforeSettings'), 'error', 5000)
    return
  }
  const snippetDir = h('input', { type: 'text', value: p.snippetDir })
  const basePath = h('input', { type: 'text', value: p.basePath })
  const browse = (input: HTMLInputElement, title: string) => h('button', {
    class: 'btn small', type: 'button',
    onclick: async () => {
      const r = await api.pickFolder(title, p.root)
      if (r.path) {
        // Path relative to the root when possible
        const root = p.root.replace(/\/$/, '')
        const abs = r.path.replace(/\\/g, '/')
        input.value = abs.toLowerCase().startsWith(root.toLowerCase() + '/') ? abs.slice(root.length + 1) : abs.toLowerCase() === root.toLowerCase() ? '.' : abs
      }
    },
  }, t('views.browse'))
  // Table of contents: undefined = unchanged, '' = automatic detection.
  let tocFile: string | undefined
  const tocLabel = h('span', { class: 'toc-file-value' }, p.tocFile ?? t('views.tocNone'))
  const tocRow = h('div', { class: 'row' },
    tocLabel,
    h('span', { class: 'spacer' }),
    h('button', {
      class: 'btn small', type: 'button',
      onclick: async () => {
        const r = await api.pickFile(t('views.tocPickTitle'), p.tocFileAbs ?? p.root, [['XML', '*.xml']])
        if (r.path) { tocFile = relativeToRoot(p.root, r.path); tocLabel.textContent = tocFile }
      },
    }, t('views.tocChoose')),
    h('button', {
      class: 'btn small', type: 'button', title: t('views.tocAutoHint'),
      onclick: () => { tocFile = ''; tocLabel.textContent = t('views.tocAutoValue') },
    }, t('views.tocAuto')))
  const body = h('div', { class: 'form' },
    h('div', { class: 'kv' }, h('b', null, t('views.openedFolder') + ' '), p.root),
    h('div', { class: 'kv' }, h('b', null, t('views.mkdocsFile') + ' '), p.mkdocs ?? t('views.notFound')),
    h('label', null, t('views.snippetDir'), h('div', { class: 'row' }, snippetDir, browse(snippetDir, t('views.snippetDir')))),
    h('div', { class: 'hint' }, t('views.snippetDirHint')),
    h('label', null, t('views.basePath'), h('div', { class: 'row' }, basePath, browse(basePath, t('views.basePathPickTitle')))),
    h('div', { class: 'hint' },
      t('views.basePathHint') + ' ',
      p.detectedBasePath ? t('views.basePathDetected', { path: p.detectedBasePath }) : t('views.basePathDefault')),
    h('div', { class: 'field' }, h('span', null, t('views.tocFile')), tocRow),
    h('div', { class: 'hint' }, t('views.tocHint')),
    h('div', { class: 'hint' }, t('views.settingsStoredHint')))
  const r = await modal(t('views.settingsTitle'), body, [
    { label: t('views.defaults'), value: 'reset' },
    { label: t('views.cancel'), value: 'cancel' },
    { label: t('views.save'), value: 'ok', primary: true },
  ], { wide: true })
  if (r === 'ok') {
    await applySettings({ snippetDir: snippetDir.value.trim(), basePath: basePath.value.trim(), ...(tocFile !== undefined ? { tocFile } : {}) })
  } else if (r === 'reset') {
    await applySettings({ snippetDir: '', basePath: '', tocFile: '' })
  }
}

async function applySettings(s: { snippetDir: string; basePath: string; tocFile?: string }) {
  try {
    const info = await api.projectSettings(s)
    await ctx.setProject?.(info, true)
    toast(t('views.settingsSaved'), 'success')
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}

function renderDiff(before: string, after: string): HTMLElement {
  const parts = diffLines(before, after)
  const out = h('div', { class: 'diff' })
  let changed = false
  for (const part of parts) {
    const cls = part.added ? 'add' : part.removed ? 'del' : 'same'
    if (part.added || part.removed) changed = true
    const lines = part.value.replace(/\n$/, '').split('\n')
    // Reduced context around changes
    if (cls === 'same' && lines.length > 8) {
      for (const l of lines.slice(0, 3)) out.append(h('div', { class: 'diff-line same' }, '  ' + l))
      out.append(h('div', { class: 'diff-line skip' }, t('views.unchangedLines', { n: lines.length - 6 })))
      for (const l of lines.slice(-3)) out.append(h('div', { class: 'diff-line same' }, '  ' + l))
      continue
    }
    for (const l of lines) out.append(h('div', { class: `diff-line ${cls}` }, (part.added ? '+ ' : part.removed ? '- ' : '  ') + l))
  }
  if (!changed) out.replaceChildren(h('div', { class: 'empty-hint' }, t('views.noChanges')))
  return out
}

/** Diff between the files on disk and the Markdown that will be saved. */
export async function showDiff(ws: Workspace) {
  const doc = ws.active
  if (!doc) return
  const sections: HTMLElement[] = []
  const files: { path: string; after: string }[] = []
  if (doc.kind === 'topic') files.push({ path: doc.path, after: serializeDoc(doc.editor.state.doc) })
  const snippetPaths = ctx.snippets.includedIn(doc.editor.state.doc)
  if (doc.kind === 'snippet') snippetPaths.unshift(doc.path)
  for (const p of snippetPaths) {
    const e = ctx.snippets.entries.get(p)
    if (e && e.current !== e.baseline) files.push({ path: p, after: e.current })
  }
  for (const f of files) {
    let disk = ''
    try { disk = (await api.readFile(f.path)).content } catch { /* new file */ }
    sections.push(h('div', { class: 'diff-file' }, h('div', { class: 'diff-title' }, f.path), renderDiff(disk, f.after)))
  }
  if (!sections.length) sections.push(h('div', { class: 'empty-hint' }, t('views.noChanges')))
  await modal(t('views.diffTitle'), h('div', null,
    h('div', { class: 'hint' }, t('views.diffHint')),
    ...sections), [{ label: t('views.close'), value: 'ok', primary: true }], { wide: true })
}

export async function showSource(ws: Workspace) {
  const doc = ws.active
  if (!doc) return
  const md = serializeDoc(doc.editor.state.doc)
  const pre = h('pre', { class: 'source-view' }, md)
  const r = await modal(t('views.sourceTitle', { name: basename(doc.path) }), pre, [
    { label: t('views.copy'), value: 'copy' },
    { label: t('views.close'), value: 'ok', primary: true },
  ], { wide: true })
  if (r === 'copy') { await navigator.clipboard.writeText(md); toast(t('views.copied')) }
}
