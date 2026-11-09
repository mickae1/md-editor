// Open tabs, saving and detection of external changes.
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { api } from '../api'
import { ctx } from '../context'
import { createEditor } from '../editor/create'
import { markdownToHtml } from '../markdown/parser'
import { serializeDoc } from '../markdown/serializer'
import { basename, isUnder } from '../paths'
import { h } from '../ui/dom'
import { choiceDialog, confirmDialog, toast } from '../ui/dialogs'
import { icon } from '../ui/icons'
import { t } from '../i18n'

export interface Doc {
  path: string
  kind: 'topic' | 'snippet'
  editor: Editor
  container: HTMLElement
  tab: HTMLElement
  baseline: string
  mtime: number | null
  dirty: boolean
}

type Listener = () => void

export class Workspace {
  docs: Doc[] = []
  active: Doc | null = null
  private listeners = new Set<Listener>()
  private dirtyTimer = 0

  constructor(private tabBar: HTMLElement, private area: HTMLElement, private empty: HTMLElement) {
    ctx.snippets.onChange(() => this.refreshDirty())
  }

  onChange(fn: Listener) { this.listeners.add(fn) }
  emit() { this.listeners.forEach(l => l()) }

  isSnippetPath(path: string) {
    return !!ctx.project && isUnder(path, ctx.project.snippetDir)
  }

  find(path: string) { return this.docs.find(d => d.path === path) }

  async open(path: string, anchor?: string) {
    let doc = this.find(path)
    if (!doc) {
      try {
        doc = this.isSnippetPath(path) ? await this.createSnippetDoc(path) : await this.createTopicDoc(path)
      } catch (e) {
        toast(t('workspace.openError', { path, error: (e as Error).message }), 'error')
        return
      }
      // A concurrent open may have created the tab in the meantime.
      const again = this.docs.find(d => d.path === path)
      if (again && again !== doc) { this.destroyDoc(doc); doc = again } else this.docs.push(doc)
      this.renderTabs()
    }
    this.activate(doc)
    if (anchor) this.scrollToAnchor(doc, anchor)
  }

  private makeContainer(path: string, kind: Doc['kind']) {
    const container = h('div', { class: `doc-view ${kind}` })
    if (kind === 'snippet') {
      // {usage} is replaced by the live usage count element.
      const [before, after = ''] = t('workspace.snippetBanner', { name: basename(path) }).split('{usage}')
      container.append(h('div', { class: 'doc-banner' }, icon('puzzle', 14),
        before, h('span', { class: 'usage-count' }), after + ' ',
        h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); ctx.editSnippetLabel?.(path) } }, t('workspace.viewTopics'))))
    }
    const page = h('div', { class: 'page md-typeset' })
    container.append(page)
    this.area.append(container)
    return { container, page }
  }

  private async createTopicDoc(path: string): Promise<Doc> {
    const file = await api.readFile(path)
    const { container, page } = this.makeContainer(path, 'topic')
    const editor = createEditor({ element: page, content: markdownToHtml(file.content), host: { docPath: path, ancestors: [] } })
    const doc: Doc = { path, kind: 'topic', editor, container, tab: h('div'), baseline: '', mtime: file.mtime, dirty: false }
    doc.baseline = serializeDoc(editor.state.doc)
    editor.on('update', () => this.scheduleDirty())
    return doc
  }

  private async createSnippetDoc(path: string): Promise<Doc> {
    const { container, page } = this.makeContainer(path, 'snippet')
    // Relative paths in a snippet resolve as in a topic at the root.
    const { editor, entry } = await ctx.snippets.mount(path, page, { docPath: 'index.md', ancestors: [] })
    return { path, kind: 'snippet', editor, container, tab: h('div'), baseline: '', mtime: entry.mtime, dirty: false }
  }

  activate(doc: Doc) {
    if (this.active && this.active !== doc) this.active.container.classList.remove('active')
    this.active = doc
    doc.container.classList.add('active')
    this.empty.hidden = true
    ctx.setActiveEditor(doc.editor)
    this.renderTabs()
    this.emit()
    requestAnimationFrame(() => { if (!doc.editor.isFocused) doc.editor.commands.focus(undefined, { scrollIntoView: false }) })
  }

  private scheduleDirty() {
    clearTimeout(this.dirtyTimer)
    this.dirtyTimer = window.setTimeout(() => this.refreshDirty(), 250)
  }

  private dirtySignature = ''

  refreshDirty() {
    for (const d of this.docs) {
      d.dirty = d.kind === 'snippet' ? ctx.snippets.isDirty(d.path) : serializeDoc(d.editor.state.doc) !== d.baseline
    }
    // Tabs also depend on the modified snippets they display.
    const signature = this.docs.map(d => (this.hasChanges(d) ? '1' : '0')).join('')
    if (signature !== this.dirtySignature) {
      this.dirtySignature = signature
      this.renderTabs()
    }
    this.emit()
  }

  /** Does a document (or a snippet it displays) have changes? */
  hasChanges(doc: Doc) {
    return doc.dirty || ctx.snippets.includedIn(doc.editor.state.doc).some(p => ctx.snippets.isDirty(p))
  }

  anyDirty() {
    return this.docs.some(d => d.dirty) || ctx.snippets.dirtyPaths().length > 0
  }

  renderTabs() {
    const tabs = this.docs.map(d => {
      const dirty = this.hasChanges(d)
      const el = h('div', {
        class: `tab ${d === this.active ? 'active' : ''} ${d.kind}`, title: d.path,
        onmousedown: (e: MouseEvent) => { if (e.button === 1) { e.preventDefault(); this.close(d) } },
        onclick: () => this.activate(d),
      },
      icon(d.kind === 'snippet' ? 'puzzle' : 'file', 13),
      h('span', { class: 'tab-name' }, basename(d.path, '.md')),
      h('span', { class: `tab-dirty ${dirty ? 'on' : ''}` }),
      h('button', { class: 'tab-close', title: t('workspace.close'), onclick: (e: Event) => { e.stopPropagation(); this.close(d) } }, icon('x', 12)))
      d.tab = el
      return el
    })
    this.tabBar.replaceChildren(...tabs)
    for (const d of this.docs) {
      if (d.kind !== 'snippet') continue
      const n = ctx.usageOf(d.path).length
      const span = d.container.querySelector('.usage-count')
      if (span) span.textContent = t('workspace.topicCount', { n })
    }
    this.active?.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  async close(doc: Doc) {
    const ownDirty = doc.dirty
    // Modified snippets that will no longer be displayed anywhere after closing.
    const orphanSnippets = ctx.snippets.includedIn(doc.editor.state.doc)
      .filter(p => ctx.snippets.isDirty(p) && (ctx.snippets.entries.get(p)?.editors.size ?? 0) <= 1 && !this.find(p))
    if (ownDirty || orphanSnippets.length) {
      const r = await choiceDialog(t('workspace.unsavedTitle'),
        t('workspace.unsavedMessage', { name: basename(doc.path) }), [
          { label: t('workspace.cancel'), value: 'cancel' },
          { label: t('workspace.dontSave'), value: 'discard', danger: true },
          { label: t('workspace.save'), value: 'save', primary: true },
        ])
      if (r === 'save') { if (!(await this.save(doc))) return }
      else if (r === 'discard') {
        for (const p of orphanSnippets) await ctx.snippets.revert(p)
        if (doc.kind === 'snippet') await ctx.snippets.revert(doc.path)
      } else return
    }
    const idx = this.docs.indexOf(doc)
    this.docs.splice(idx, 1)
    this.destroyDoc(doc)
    if (this.active === doc) {
      this.active = null
      const next = this.docs[idx] ?? this.docs[idx - 1]
      if (next) this.activate(next)
      else { this.empty.hidden = false; this.emit() }
    }
    this.renderTabs()
  }

  private destroyDoc(doc: Doc) {
    if (doc.kind === 'snippet') ctx.snippets.unmount(doc.path, doc.editor)
    else doc.editor.destroy()
    doc.container.remove()
  }

  closeAll() {
    for (const d of this.docs) this.destroyDoc(d)
    this.docs = []
    this.active = null
    this.empty.hidden = false
    this.renderTabs()
    this.emit()
  }

  /**
   * Saves a document and the modified snippets it displays.
   * Warns when a modified snippet is shared by several topics.
   */
  async save(doc: Doc): Promise<boolean> {
    // The dirty flag is refreshed with a delay: recompute it (Ctrl+S right after typing).
    if (doc.kind === 'topic') doc.dirty = serializeDoc(doc.editor.state.doc) !== doc.baseline
    const snippetPaths = ctx.snippets.includedIn(doc.editor.state.doc).filter(p => ctx.snippets.isDirty(p))
    if (doc.kind === 'snippet' && ctx.snippets.isDirty(doc.path)) snippetPaths.unshift(doc.path)

    const shared = snippetPaths.map(p => ({ p, users: ctx.usageOf(p) })).filter(x => x.users.length > 1)
    if (shared.length) {
      const body = h('div', null,
        ...shared.map(s => {
          // {name} is rendered in bold.
          const [before, after = ''] = t('workspace.sharedWarning', { n: s.users.length }).split('{name}')
          return h('div', { class: 'shared-warning' },
            h('p', null, before, h('b', null, basename(s.p, '.md')), after),
            h('ul', { class: 'file-list' }, ...s.users.map(u => h('li', null, basename(u, '.md')))))
        }))
      const r = await choiceDialog(t('workspace.sharedTitle'), body, [
        { label: t('workspace.cancel'), value: 'cancel' },
        { label: t('workspace.save'), value: 'ok', primary: true },
      ])
      if (r !== 'ok') return false
    }

    try {
      for (const p of snippetPaths) if (!(await ctx.snippets.save(p))) return false
      if (doc.kind === 'topic' && doc.dirty) {
        const content = serializeDoc(doc.editor.state.doc)
        const r = await api.writeFile(doc.path, content, doc.mtime)
        if (r === 'conflict') return false
        doc.mtime = r.mtime
        doc.baseline = content
      }
    } catch (e) {
      toast(t('workspace.saveError', { error: (e as Error).message }), 'error', 6000)
      return false
    }
    this.refreshDirty()
    toast(snippetPaths.length
      ? t('workspace.savedWithSnippets', { name: basename(doc.path), n: snippetPaths.length })
      : t('workspace.saved', { name: basename(doc.path) }), 'success', 2000)
    await ctx.reloadProject?.()
    return true
  }

  async saveAll() {
    for (const d of this.docs) if (this.hasChanges(d)) if (!(await this.save(d))) return
    // Modified snippets not displayed in any open tab
    for (const p of ctx.snippets.dirtyPaths()) await ctx.snippets.save(p)
  }

  /** Checks whether open files were changed outside the editor. */
  async checkExternalChanges() {
    if (!ctx.project) return
    const topicDocs = this.docs.filter(d => d.kind === 'topic')
    const snippetPaths = [...ctx.snippets.entries.keys()]
    const paths = [...topicDocs.map(d => d.path), ...snippetPaths]
    if (!paths.length) return
    let stats: Record<string, number | null>
    try { stats = await api.stat(paths) } catch { return }

    for (const d of topicDocs) {
      const m = stats[d.path]
      if (m == null || d.mtime == null || Math.abs(m - d.mtime) < 0.001) continue
      if (d.dirty) {
        const ok = await confirmDialog(t('workspace.fileChangedTitle'),
          t('workspace.changedOutsideMessage', { path: d.path }), t('workspace.reload'), true)
        if (!ok) { d.mtime = m; continue }
      }
      await this.reloadTopic(d)
      toast(t('workspace.reloadedExternal', { name: basename(d.path) }))
    }
    for (const p of snippetPaths) {
      const entry = ctx.snippets.entries.get(p)
      const m = stats[p]
      if (!entry || m == null || entry.mtime == null || Math.abs(m - entry.mtime) < 0.001) continue
      if (ctx.snippets.isDirty(p)) {
        const ok = await confirmDialog(t('workspace.snippetChangedTitle'),
          t('workspace.changedOutsideMessage', { path: p }), t('workspace.reload'), true)
        if (!ok) { entry.mtime = m; continue }
      }
      await ctx.snippets.reload(p)
    }
    this.refreshDirty()
  }

  async reloadTopic(d: Doc) {
    const file = await api.readFile(d.path)
    d.editor.commands.setContent(markdownToHtml(file.content), { emitUpdate: false })
    d.mtime = file.mtime
    d.baseline = serializeDoc(d.editor.state.doc)
    d.dirty = false
    this.renderTabs()
  }

  scrollToAnchor(doc: Doc, anchor: string) {
    const ed = doc.editor
    let target = -1
    ed.state.doc.descendants((node, pos) => {
      if (target >= 0) return false
      if (node.type.name === 'anchor' && node.attrs.id === anchor) target = pos
      else if (node.type.name === 'heading' && slugify(node.textContent) === anchor) target = pos + 1
      return true
    })
    if (target < 0) { toast(t('workspace.anchorNotFound', { anchor })); return }
    requestAnimationFrame(() => {
      ed.chain().focus().command(({ tr }) => { tr.setSelection(TextSelection.near(tr.doc.resolve(target))); return true }).run()
      const dom = ed.view.domAtPos(target).node as HTMLElement
      ;(dom.nodeType === 1 ? dom : dom.parentElement)?.scrollIntoView({ block: 'center' })
    })
  }
}

/** ID generated by the Python-Markdown toc extension. */
export function slugify(text: string) {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[-\s]+/g, '-')
}
