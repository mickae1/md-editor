// Open tabs, saving and detection of external changes.
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { api } from '../api'
import { ctx } from '../context'
import { createEditor } from '../editor/create'
import { markdownToHtml } from '../markdown/parser'
import { serializeDoc } from '../markdown/serializer'
import { docAnchors } from '../markdown/anchors'
import { basename, isUnder } from '../paths'
import { h } from '../ui/dom'
import { choiceDialog, toast } from '../ui/dialogs'
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
  /** > 0 while the editor itself writes files: external change checks wait. */
  private busy = 0
  private checking = false
  /** When the running check started: a check stuck on a request is released after a while. */
  private checkingSince = 0
  /** External mtime the user chose to ignore (kept their own changes), by path. */
  private keptVersion = new Map<string, number>()

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
    this.busy++
    try {
      return await this.saveNow(doc)
    } finally {
      this.busy--
    }
  }

  private async saveNow(doc: Doc): Promise<boolean> {
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
    this.busy++
    try {
      for (const p of ctx.snippets.dirtyPaths()) await ctx.snippets.save(p)
    } finally {
      this.busy--
    }
  }

  /**
   * Checks the open files every `ms` while the window is visible (changes made by
   * Claude, Git or another editor while the user looks at the page), and when
   * the window gets the focus back.
   */
  startWatching(ms = 2000) {
    const tick = () => {
      if (document.visibilityState !== 'visible' || document.querySelector('.modal')) return
      void this.checkExternalChanges()
    }
    window.setInterval(tick, ms)
    window.addEventListener('focus', tick)
  }

  /**
   * Reloads the open files changed outside the editor. A file without unsaved
   * changes is reloaded at once; otherwise the user chooses between reloading
   * (losing their changes) and keeping their version (the next save then asks
   * before overwriting the other version).
   */
  async checkExternalChanges() {
    // A check waiting more than 15 s without a dialog is stuck (request lost): start again.
    const stuck = this.checking && Date.now() - this.checkingSince > 15_000 && !document.querySelector('.modal')
    if (!ctx.project || (this.checking && !stuck) || this.busy) return
    this.checking = true
    const since = this.checkingSince = Date.now()
    try {
      const topicDocs = this.docs.filter(d => d.kind === 'topic')
      const snippetPaths = [...ctx.snippets.entries.keys()]
      const paths = [...topicDocs.map(d => d.path), ...snippetPaths]
      if (!paths.length) return
      let stats: Record<string, number | null>
      try { stats = await api.stat(paths, 5000) } catch { return }
      if (this.busy) return // a save started meanwhile: its own write is not an external change

      const changed = (path: string, known: number | null) => {
        const m = stats[path]
        return m != null && known != null && Math.abs(m - known) >= 0.001 ? m : null
      }
      /**
       * Without unsaved changes: reload. With some: ask once per external version
       * (the answer "keep mine" holds until the file changes again or is saved).
       */
      const shouldReload = async (path: string, m: number, dirty: boolean) => {
        if (!dirty) return true
        if (this.keptVersion.get(path) === m) return false
        if (await this.askReload(path)) return true
        this.keptVersion.set(path, m)
        return false
      }
      let reloaded = false
      for (const d of topicDocs) {
        const m = changed(d.path, d.mtime)
        if (m == null || !this.docs.includes(d)) continue
        if (!(await shouldReload(d.path, m, serializeDoc(d.editor.state.doc) !== d.baseline))) continue
        await this.reloadTopic(d)
        this.keptVersion.delete(d.path)
        toast(t('workspace.reloadedExternal', { name: basename(d.path) }))
        reloaded = true
      }
      for (const p of snippetPaths) {
        const entry = ctx.snippets.entries.get(p)
        const m = entry ? changed(p, entry.mtime) : null
        if (m == null) continue
        if (!(await shouldReload(p, m, ctx.snippets.isDirty(p)))) continue
        await this.preservingScroll(() => ctx.snippets.reload(p))
        this.keptVersion.delete(p)
        toast(t('workspace.reloadedExternal', { name: basename(p) }))
        reloaded = true
      }
      this.refreshDirty()
      if (reloaded) await ctx.reloadProject?.()
    } finally {
      if (this.checkingSince === since) this.checking = false
    }
  }

  /** "Changed outside the editor while you have unsaved changes": true = reload. */
  private async askReload(path: string): Promise<boolean> {
    const r = await choiceDialog(t('workspace.fileChangedTitle'), t('workspace.changedOutsideMessage', { path }), [
      { label: t('workspace.keepMine'), value: 'keep', primary: true },
      { label: t('workspace.reloadLose'), value: 'reload', danger: true },
    ])
    return r === 'reload'
  }

  /** Runs `fn` keeping the scroll position of the active tab. */
  private async preservingScroll(fn: () => Promise<void> | void) {
    const view = this.active?.container
    const top = view?.scrollTop ?? 0
    await fn()
    if (view) requestAnimationFrame(() => { view.scrollTop = top })
  }

  /** Reloads a topic from the disk, keeping the scroll position and the cursor. */
  async reloadTopic(d: Doc) {
    const file = await api.readFile(d.path)
    const top = d.container.scrollTop
    const { from, to } = d.editor.state.selection
    d.editor.commands.setContent(markdownToHtml(file.content), { emitUpdate: false })
    const size = d.editor.state.doc.content.size
    try {
      d.editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) })
    } catch { /* position no longer valid */ }
    requestAnimationFrame(() => { d.container.scrollTop = top })
    d.mtime = file.mtime
    d.baseline = serializeDoc(d.editor.state.doc)
    d.dirty = false
    this.renderTabs()
  }

  /**
   * Scrolls to an anchor: explicit heading id ({ #id }), id MkDocs generates from
   * the heading text, or <a id>. Anchors inside the snippets shown by the page count.
   */
  scrollToAnchor(doc: Doc, anchor: string) {
    // The page and, after it, the snippet editors displayed in this tab.
    const editors = [doc.editor, ...[...ctx.snippets.entries.values()]
      .flatMap(e => [...e.editors]).filter(ed => !ed.isDestroyed && doc.container.contains(ed.view.dom))]
    const all = docAnchors(...editors.map(ed => ed.state.doc))
    const hit = all.find(a => a.id === anchor)
    if (!hit) { toast(t('workspace.anchorNotFound', { anchor })); return }
    const ed = editors[hit.doc]
    const target = hit.pos + (hit.kind === 'anchor' ? 0 : 1)
    requestAnimationFrame(() => {
      ed.chain().focus().command(({ tr }) => { tr.setSelection(TextSelection.near(tr.doc.resolve(target))); return true }).run()
      const dom = ed.view.domAtPos(target).node as HTMLElement
      ;(dom.nodeType === 1 ? dom : dom.parentElement)?.scrollIntoView({ block: 'center' })
    })
  }
}
