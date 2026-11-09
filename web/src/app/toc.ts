// Table of contents panel: tree of Maps/table_of_contents.xml, editing
// (drag & drop, rename, add, duplicate, move, remove, delete) and orphan topics.
import { api, type References } from '../api'
import { ctx, type TocEdit, type TocNode, type TocPosition, type TocState } from '../context'
import { basename } from '../paths'
import { h } from '../ui/dom'
import { choiceDialog, confirmDialog, modal, popupMenu, toast } from '../ui/dialogs'
import { icon } from '../ui/icons'
import { t } from '../i18n'
import { deleteFileFlow, fetchReferences, referencesDialog, type ApiError } from './deleteFile'

const TOPIC_ID_RE = /^[\w][\w.-]*(\/[\w][\w.-]*)*$/

type Drag = { kind: 'node'; id: string } | { kind: 'orphan'; path: string }

export interface TocPanelOptions {
  /** Closes the tab of a file if it is open; false if the user cancelled. */
  closeFile: (path: string) => Promise<boolean>
  /** Called with the number of broken nodes after every load. */
  onBroken: (n: number) => void
}

/** Topic ID generated from a title: "Import données" -> "Import-donnees". */
export function topicIdFromTitle(title: string) {
  const words = title.normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean)
  const id = words.join('-')
  return id ? id[0].toUpperCase() + id.slice(1) : ''
}

/** Common prefix of hyphen segments ("Workflow-") of sibling topic IDs, or ''. */
export function commonPrefix(hrefs: string[]) {
  if (!hrefs.length) return ''
  const parts = hrefs.map(x => x.split('-'))
  const max = Math.min(...parts.map(p => p.length)) - 1
  let n = 0
  while (n < max && parts.every(p => p[n] === parts[0][n])) n++
  return n ? parts[0].slice(0, n).join('-') + '-' : ''
}

function nodeKey(n: TocNode) { return n.href ?? `#${n.caption}` }
function identity(n: TocNode) { return n.attrs.id ?? `${n.href}|${n.caption}` }
function parentId(id: string) { const i = id.lastIndexOf('.'); return i < 0 ? null : id.slice(0, i) }
function isBroken(n: TocNode) { return n.href !== null && n.file !== null && !n.exists }

export class TocPanel {
  el: HTMLElement
  private body = h('div', { class: 'toc-body', tabindex: '0' })
  private toolbar: HTMLElement
  private state: TocState | null = null
  private signature = ''
  private collapsed = new Set<string>()
  private orphansOpen = true
  private selectedId: string | null = null
  private activePath: string | null = null
  private renaming = false
  private busy = false
  private drag: Drag | null = null
  private expandTimer = 0
  private expandRow: HTMLElement | null = null
  private refocusPath: string | null = null

  constructor(private opts: TocPanelOptions) {
    const tb = (name: Parameters<typeof icon>[0], title: string, run: () => void) =>
      h('button', { class: 'icon-btn', title, onclick: run }, icon(name, 15))
    this.toolbar = h('div', { class: 'toc-toolbar' },
      h('span', { class: 'toc-title' }, t('toc.title')),
      h('span', { class: 'spacer' }),
      tb('filePlus', t('toc.addTopic'), () => this.addDialog(this.selected(), this.selected() ? 'inside' : null)),
      tb('details', t('toc.collapseAll'), () => this.collapseAll()),
      tb('refresh', t('toc.refresh'), () => { this.signature = ''; void this.load() }))
    this.el = h('div', { class: 'toc-panel' }, this.toolbar, this.body)
    this.body.addEventListener('keydown', e => this.onKey(e))
    this.body.addEventListener('dragover', e => this.onBodyDragOver(e))
    this.body.addEventListener('drop', e => this.onBodyDrop(e))
    this.body.addEventListener('dragend', () => this.endDrag())
  }

  // ------------------------------------------------------------------
  // Loading and rendering
  // ------------------------------------------------------------------

  async load() {
    if (!ctx.project) { this.state = null; this.signature = ''; this.render(); this.opts.onBroken(0); return }
    let s: TocState
    try { s = await api.toc() } catch (e) {
      this.body.replaceChildren(h('div', { class: 'empty-hint error' }, (e as Error).message))
      return
    }
    this.setState(s)
  }

  private setState(s: TocState) {
    const sig = JSON.stringify(s)
    this.opts.onBroken(s.broken)
    if (sig === this.signature) return
    const prevSel = this.selected()
    this.state = s
    this.signature = sig
    // Keep the selection on the same node (ids change after edits).
    this.selectedId = prevSel ? (this.find(n => identity(n) === identity(prevSel))?.id ?? null) : null
    if (!this.renaming) this.render()
  }

  render() {
    const s = this.state
    const scroll = this.body.scrollTop
    if (!ctx.project || !s) { this.body.replaceChildren(); this.toolbar.hidden = true; return }
    if (s.path === null) {
      this.toolbar.hidden = true
      this.body.replaceChildren(h('div', { class: 'toc-empty' },
        icon('book', 28),
        h('p', null, t('toc.noToc')),
        h('p', { class: 'hint' }, t('toc.noTocHint')),
        h('button', { class: 'btn small', onclick: () => this.chooseFile() }, icon('folderOpen', 14), t('toc.chooseFile'))))
      return
    }
    this.toolbar.hidden = false
    const rows: HTMLElement[] = []
    const walk = (nodes: TocNode[], depth: number) => {
      for (const n of nodes) {
        rows.push(this.nodeRow(n, depth))
        if (n.children.length && !this.collapsed.has(nodeKey(n))) walk(n.children, depth + 1)
      }
    }
    walk(s.tree, 0)
    if (!s.tree.length) rows.push(h('div', { class: 'empty-hint' }, t('toc.emptyToc')))
    rows.push(h('div', { class: 'toc-drop-end' }))
    const orphans = this.orphanSection(s.orphans)
    this.body.replaceChildren(...rows, ...orphans)
    this.body.scrollTop = scroll
    this.highlightActive(false)
  }

  private nodeRow(n: TocNode, depth: number) {
    const broken = isBroken(n)
    const hasChildren = n.children.length > 0
    const open = !this.collapsed.has(nodeKey(n))
    const row = h('div', {
      class: `tree-item toc-item ${hasChildren ? 'has-children' : ''} ${broken ? 'broken' : ''} ${n.id === this.selectedId ? 'selected' : ''}`,
      style: `padding-left:${6 + depth * 14}px`,
      draggable: 'true',
      dataset: { id: n.id, file: n.file ?? '' },
      title: broken ? t('toc.brokenTooltip', { file: n.file ?? '' }) : (n.file ?? n.caption),
    },
    hasChildren
      ? h('span', { class: 'twisty', onclick: (e: Event) => { e.stopPropagation(); this.toggle(n) } }, icon(open ? 'chevronDown' : 'chevronRight', 14))
      : h('span', { class: 'twisty-space' }),
    icon(broken ? 'brokenLink' : hasChildren ? 'book' : 'file', 14),
    h('span', { class: 'toc-caption' }, n.caption),
    n.href ? h('span', { class: 'toc-href' }, n.href) : null)
    row.addEventListener('click', e => this.onRowClick(e, n))
    row.addEventListener('dblclick', e => { if (hasChildren && !(e.target as HTMLElement).closest('.twisty')) this.toggle(n) })
    row.addEventListener('contextmenu', e => { e.preventDefault(); this.select(n.id); this.nodeMenu(n, e.clientX, e.clientY) })
    row.addEventListener('dragstart', e => {
      this.drag = { kind: 'node', id: n.id }
      e.dataTransfer?.setData('text/plain', n.href ?? n.caption)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
      row.classList.add('dragging')
    })
    row.addEventListener('dragover', e => this.onRowDragOver(e, row, n))
    row.addEventListener('dragleave', () => this.clearIndicator(row))
    row.addEventListener('drop', e => this.onRowDrop(e, row, n))
    return row
  }

  private orphanSection(orphans: string[]): HTMLElement[] {
    if (!orphans.length) return []
    const header = h('div', { class: 'toc-orphans-title', onclick: () => { this.orphansOpen = !this.orphansOpen; this.render() } },
      icon(this.orphansOpen ? 'chevronDown' : 'chevronRight', 14),
      h('span', null, t('toc.orphans', { n: orphans.length })))
    if (!this.orphansOpen) return [header]
    return [header, ...orphans.map(path => {
      const row = h('div', {
        class: 'tree-item toc-orphan', draggable: 'true', dataset: { file: path }, title: t('toc.orphanTooltip', { file: path }),
        onclick: () => ctx.openFile(path),
      },
      icon('file', 14),
      h('span', { class: 'label' }, path.replace(/\.md$/i, '')),
      h('button', { class: 'icon-btn row-btn', title: t('toc.addToMenu'), onclick: (e: Event) => { e.stopPropagation(); void this.addOrphan(path, this.selected(), 'inside') } }, icon('plus', 13)),
      h('button', { class: 'icon-btn row-btn', title: t('toc.deleteFile'), onclick: (e: Event) => { e.stopPropagation(); void this.deleteOrphan(path) } }, icon('trash', 13)))
      row.addEventListener('contextmenu', e => {
        e.preventDefault()
        popupMenu(e.clientX, e.clientY, [
          { label: t('toc.menuOpen'), icon: icon('file', 14), action: () => ctx.openFile(path) },
          { label: t('toc.addToMenu'), icon: icon('plus', 14), action: () => void this.addOrphan(path, this.selected(), 'inside') },
          'sep',
          { label: t('toc.deleteFile'), icon: icon('trash', 14), action: () => void this.deleteOrphan(path) },
        ])
      })
      row.addEventListener('dragstart', e => {
        this.drag = { kind: 'orphan', path }
        e.dataTransfer?.setData('text/plain', path)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove'
      })
      return row
    })]
  }

  // ------------------------------------------------------------------
  // Selection, active topic, expand/collapse
  // ------------------------------------------------------------------

  private find(pred: (n: TocNode) => boolean, nodes = this.state?.tree ?? []): TocNode | null {
    for (const n of nodes) {
      if (pred(n)) return n
      const c = this.find(pred, n.children)
      if (c) return c
    }
    return null
  }

  private byId(id: string | null) { return id === null ? null : this.find(n => n.id === id) }
  private selected() { return this.byId(this.selectedId) }

  private siblings(id: string | null): TocNode[] {
    if (id === null) return this.state?.tree ?? []
    const p = parentId(id)
    return p === null ? this.state?.tree ?? [] : this.byId(p)?.children ?? []
  }

  private select(id: string | null) {
    this.selectedId = id
    this.body.querySelectorAll('.toc-item.selected').forEach(e => e.classList.remove('selected'))
    if (id !== null) this.rowOf(id)?.classList.add('selected')
  }

  private rowOf(id: string) { return this.body.querySelector<HTMLElement>(`.toc-item[data-id="${CSS.escape(id)}"]`) }

  /** Highlights the node of the active topic; expands its ancestors and scrolls it into view. */
  setActive(path: string | null) {
    if (path && path === this.refocusPath) { this.refocusPath = null; this.keepFocus() }
    if (path === this.activePath) return
    this.activePath = path
    if (!path || !this.state) { this.highlightActive(false); return }
    const node = this.find(n => n.file?.toLowerCase() === path.toLowerCase())
    if (node) {
      let changed = false
      for (let p = parentId(node.id); p !== null; p = parentId(p)) {
        const anc = this.byId(p)
        if (anc && this.collapsed.delete(nodeKey(anc))) changed = true
      }
      if (changed && !this.renaming) this.render()
    }
    this.highlightActive(true)
  }

  private highlightActive(scroll: boolean) {
    this.body.querySelectorAll('.tree-item.active').forEach(e => e.classList.remove('active'))
    const path = this.activePath?.toLowerCase()
    if (!path) return
    let first: HTMLElement | null = null
    this.body.querySelectorAll<HTMLElement>('.tree-item[data-file]').forEach(r => {
      if (r.dataset.file?.toLowerCase() === path) { r.classList.add('active'); first ??= r }
    })
    if (scroll && first && this.el.isConnected) (first as HTMLElement).scrollIntoView({ block: 'nearest' })
  }

  /** Focuses the tree after the editor took the focus (Workspace.activate focuses it in a frame). */
  private keepFocus() {
    requestAnimationFrame(() => requestAnimationFrame(() => { if (!this.renaming && this.el.isConnected) this.body.focus({ preventScroll: true }) }))
  }

  private toggle(n: TocNode) {
    const k = nodeKey(n)
    if (!this.collapsed.delete(k)) this.collapsed.add(k)
    this.render()
  }

  private collapseAll() {
    const walk = (nodes: TocNode[]) => nodes.forEach(n => { if (n.children.length) { this.collapsed.add(nodeKey(n)); walk(n.children) } })
    walk(this.state?.tree ?? [])
    this.render()
  }

  private onRowClick(e: MouseEvent, n: TocNode) {
    if ((e.target as HTMLElement).closest('.twisty')) return
    const wasSelected = this.selectedId === n.id
    this.select(n.id)
    this.body.focus({ preventScroll: true })
    if (wasSelected && (e.target as HTMLElement).closest('.toc-caption') && e.detail === 1) {
      // Same as a file manager: a click on the caption of the selected node renames it.
      this.startRename(n)
      return
    }
    // Opening a topic focuses its editor: keep the keyboard in the tree (F2, Alt+arrows).
    this.refocusPath = n.exists ? n.file : null
    this.open(n)
    this.keepFocus()
  }

  private open(n: TocNode) {
    if (!n.file) { if (n.children.length) this.toggle(n); return }
    if (!n.exists) { toast(t('toc.brokenToast', { file: n.file }), 'error'); return }
    ctx.openFile(n.file)
  }

  // ------------------------------------------------------------------
  // Keyboard
  // ------------------------------------------------------------------

  private onKey(e: KeyboardEvent) {
    if (this.renaming || (e.target as HTMLElement).tagName === 'INPUT') return
    const n = this.selected()
    const rows = [...this.body.querySelectorAll<HTMLElement>('.toc-item')]
    const idx = n ? rows.findIndex(r => r.dataset.id === n.id) : -1
    const key = e.key
    if (e.altKey && n && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
      e.preventDefault()
      if (key === 'ArrowUp') void this.moveUp(n)
      else if (key === 'ArrowDown') void this.moveDown(n)
      else if (key === 'ArrowRight') void this.indent(n)
      else void this.outdent(n)
    } else if (key === 'F2' && n) { e.preventDefault(); this.startRename(n) }
    else if (key === 'Enter' && n) { e.preventDefault(); this.open(n) }
    else if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault()
      const next = rows[Math.max(0, Math.min(rows.length - 1, idx + (key === 'ArrowDown' ? 1 : -1)))]
      if (next) { this.select(next.dataset.id!); next.scrollIntoView({ block: 'nearest' }) }
    } else if ((key === 'ArrowRight' || key === 'ArrowLeft') && n && n.children.length) {
      e.preventDefault()
      const isOpen = !this.collapsed.has(nodeKey(n))
      if (isOpen !== (key === 'ArrowRight')) this.toggle(n)
    } else if (key === 'Delete' && n) { e.preventDefault(); void this.removeNode(n) }
    else if (key === 'ContextMenu' && n) {
      e.preventDefault()
      const r = this.rowOf(n.id)?.getBoundingClientRect()
      if (r) this.nodeMenu(n, r.left + 24, r.bottom)
    }
  }

  // ------------------------------------------------------------------
  // Context menu
  // ------------------------------------------------------------------

  private nodeMenu(n: TocNode, x: number, y: number) {
    const sibs = this.siblings(n.id)
    const i = sibs.findIndex(s => s.id === n.id)
    popupMenu(x, y, [
      { label: t('toc.menuOpen'), icon: icon('file', 14), disabled: !n.file || !n.exists, action: () => this.open(n) },
      { label: t('toc.menuRename'), icon: icon('pencil', 14), action: () => this.startRename(n) },
      'sep',
      { label: t('toc.menuAddInside'), icon: icon('filePlus', 14), action: () => void this.addDialog(n, 'inside') },
      { label: t('toc.menuAddAfter'), icon: icon('plus', 14), action: () => void this.addDialog(n, 'after') },
      { label: t('toc.menuDuplicate'), icon: icon('copy', 14), disabled: !n.href, action: () => void this.duplicate(n) },
      'sep',
      { label: t('toc.menuMoveUp'), icon: icon('arrowUp', 14), disabled: i <= 0, action: () => void this.moveUp(n) },
      { label: t('toc.menuMoveDown'), icon: icon('arrowDown', 14), disabled: i >= sibs.length - 1, action: () => void this.moveDown(n) },
      { label: t('toc.menuIndent'), icon: icon('indent', 14), disabled: i <= 0, action: () => void this.indent(n) },
      { label: t('toc.menuOutdent'), icon: icon('outdent', 14), disabled: parentId(n.id) === null, action: () => void this.outdent(n) },
      'sep',
      { label: t('toc.menuRemove'), icon: icon('listRemove', 14), action: () => void this.removeNode(n) },
      { label: t('toc.menuDelete'), icon: icon('trash', 14), action: () => void this.deleteNode(n) },
    ])
  }

  // ------------------------------------------------------------------
  // Edits
  // ------------------------------------------------------------------

  /** Sends an edit; re-renders from the returned state. Null on error (already reported). */
  private async edit(edit: TocEdit, opts: { reload?: boolean; force?: boolean; onReferenced?: (refs: References) => Promise<boolean> } = {}) {
    if (!this.state || this.busy) return null
    this.busy = true
    try {
      let r
      try {
        r = await api.tocEdit(edit, this.state.mtime, opts.force)
      } catch (e) {
        // Delete of a file that something still points to: confirm with the list.
        const err = e as ApiError
        const refs = err.data?.references
        if (!(err.status === 409 && err.data?.code === 'referenced' && refs && opts.onReferenced)) throw e
        this.busy = false
        if (!(await opts.onReferenced(refs))) return null
        this.busy = true
        r = await api.tocEdit(edit, this.state.mtime, true)
      }
      this.setState(r.toc)
      if (opts.reload || r.created || r.deleted) await ctx.reloadProject?.()
      return r
    } catch (e) {
      const err = e as ApiError
      if (err.status === 409 && err.data?.code === 'conflict') {
        toast(t('toc.conflict'), 'error', 6000)
        this.signature = ''
        await this.load()
      } else {
        toast(t('toc.editError', { error: err.message }), 'error', 6000)
        if (err.status === 404) { this.signature = ''; await this.load() }
      }
      return null
    } finally {
      this.busy = false
    }
  }

  private async move(n: TocNode, target: string, position: TocPosition) {
    if (target === n.id || target.startsWith(n.id + '.')) return
    const r = await this.edit({ op: 'move', id: n.id, target, position })
    if (r) {
      const moved = this.find(x => identity(x) === identity(n))
      if (moved) { this.select(moved.id); this.rowOf(moved.id)?.scrollIntoView({ block: 'nearest' }) }
    }
  }

  private async moveUp(n: TocNode) {
    const sibs = this.siblings(n.id)
    const i = sibs.findIndex(s => s.id === n.id)
    if (i > 0) await this.move(n, sibs[i - 1].id, 'before')
  }

  private async moveDown(n: TocNode) {
    const sibs = this.siblings(n.id)
    const i = sibs.findIndex(s => s.id === n.id)
    if (i >= 0 && i < sibs.length - 1) await this.move(n, sibs[i + 1].id, 'after')
  }

  private async indent(n: TocNode) {
    const sibs = this.siblings(n.id)
    const i = sibs.findIndex(s => s.id === n.id)
    if (i <= 0) return
    this.collapsed.delete(nodeKey(sibs[i - 1]))
    await this.move(n, sibs[i - 1].id, 'inside')
  }

  private async outdent(n: TocNode) {
    const p = parentId(n.id)
    if (p !== null) await this.move(n, p, 'after')
  }

  private startRename(n: TocNode) {
    const row = this.rowOf(n.id)
    const cap = row?.querySelector<HTMLElement>('.toc-caption')
    if (!row || !cap) return
    this.renaming = true
    const input = h('input', { type: 'text', class: 'toc-rename', value: n.caption })
    let done = false
    const finish = async (save: boolean) => {
      if (done) return
      done = true
      const value = input.value.trim()
      this.renaming = false
      if (save && value && value !== n.caption) await this.edit({ op: 'rename', id: n.id, caption: value })
      this.render()
      this.body.focus({ preventScroll: true })
    }
    input.addEventListener('keydown', e => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); void finish(true) }
      else if (e.key === 'Escape') { e.preventDefault(); void finish(false) }
    })
    input.addEventListener('blur', () => void finish(true))
    input.addEventListener('click', e => e.stopPropagation())
    input.addEventListener('mousedown', e => e.stopPropagation())
    row.draggable = false
    cap.replaceWith(input)
    row.querySelector('.toc-href')?.remove()
    input.focus()
    input.select()
  }

  /** Siblings at an insertion point (for the topic ID prefix). */
  private siblingsAt(target: TocNode | null, position: TocPosition | null) {
    if (!target) return this.state?.tree ?? []
    return position === 'inside' ? target.children : this.siblings(target.id)
  }

  private async addDialog(target: TocNode | null, position: TocPosition | null) {
    if (!this.state?.path) return
    const prefix = commonPrefix(this.siblingsAt(target, position).map(s => s.href).filter((x): x is string => !!x))
    const r = await this.topicDialog(t('toc.addTitle'), { caption: '', href: '' }, prefix, t('toc.add'))
    if (!r) return
    const res = await this.edit({ op: 'add', target: target?.id ?? null, position: position ?? 'inside', caption: r.caption, href: r.href, create: true })
    if (target && position === 'inside') this.collapsed.delete(nodeKey(target))
    if (res?.created) { this.selectNewNode(r.href); ctx.openFile(res.created) }
  }

  private async duplicate(n: TocNode) {
    if (!n.href) return
    const files = new Set((ctx.project?.files ?? []).map(f => f.path.toLowerCase()))
    let href = `${n.href}-copy`
    for (let k = 2; files.has(`${href}.md`.toLowerCase()); k++) href = `${n.href}-copy-${k}`
    const r = await this.topicDialog(t('toc.duplicateTitle'), { caption: t('toc.copyCaption', { caption: n.caption }), href }, '', t('toc.duplicate'))
    if (!r) return
    const res = await this.edit({ op: 'duplicate', id: n.id, caption: r.caption, href: r.href })
    if (res?.created) { this.selectNewNode(r.href); ctx.openFile(res.created) }
  }

  private selectNewNode(href: string) {
    const node = this.find(x => x.href === href)
    if (!node) return
    this.select(node.id)
    this.rowOf(node.id)?.scrollIntoView({ block: 'nearest' })
  }

  /** Title + Topic ID dialog; the ID follows the title until it is edited. */
  private async topicDialog(title: string, init: { caption: string; href: string }, prefix: string, okLabel: string): Promise<{ caption: string; href: string } | null> {
    const caption = h('input', { type: 'text', value: init.caption })
    const href = h('input', { type: 'text', value: init.href, spellcheck: false })
    const file = h('div', { class: 'hint' })
    const error = h('div', { class: 'form-error' })
    let edited = !!init.href
    const files = new Set((ctx.project?.files ?? []).map(f => f.path.toLowerCase()))
    const generate = () => {
      const id = topicIdFromTitle(caption.value)
      return id && prefix && !id.startsWith(prefix) ? prefix + id : id
    }
    const validate = () => {
      const id = href.value.trim()
      file.textContent = id ? t('toc.fileName', { file: `${id}.md` }) : ''
      let msg = ''
      if (!caption.value.trim()) msg = t('toc.errorNoTitle')
      else if (!id) msg = t('toc.errorNoId')
      else if (!TOPIC_ID_RE.test(id) || id.split('/').includes('..')) msg = t('toc.errorBadId')
      else if (files.has(`${id}.md`.toLowerCase())) msg = t('toc.errorExists', { file: `${id}.md` })
      return msg
    }
    caption.addEventListener('input', () => { if (!edited) href.value = generate(); error.textContent = ''; validate() })
    href.addEventListener('input', () => { edited = href.value.trim() !== ''; error.textContent = ''; validate() })
    validate()
    const body = h('div', { class: 'form' },
      h('label', null, t('toc.fieldTitle'), caption),
      h('label', null, t('toc.fieldId'), href),
      file,
      h('div', { class: 'hint' }, t('toc.idHint')),
      error)
    for (;;) {
      const r = await modal(title, body, [
        { label: t('dialogs.cancel'), value: 'cancel' },
        { label: okLabel, value: 'ok', primary: true },
      ])
      if (r !== 'ok') return null
      const msg = validate()
      if (!msg) return { caption: caption.value.trim(), href: href.value.trim() }
      error.textContent = msg
    }
  }

  private async removeNode(n: TocNode) {
    let keepChildren = true
    if (n.children.length) {
      const r = await choiceDialog(t('toc.removeTitle'), t('toc.removeChildren', { caption: n.caption, n: n.children.length }), [
        { label: t('dialogs.cancel'), value: 'cancel' },
        { label: t('toc.removeAll'), value: 'all', danger: true },
        { label: t('toc.keepChildren'), value: 'keep', primary: true },
      ])
      if (r !== 'all' && r !== 'keep') return
      keepChildren = r === 'keep'
    }
    await this.edit({ op: 'remove', id: n.id, keepChildren })
  }

  private async deleteNode(n: TocNode) {
    if (!n.file) { await this.removeNode(n); return }
    const file = n.file
    // Another node uses the same file: the server keeps it (only this entry goes).
    const shared = this.countRefs(file) > 1
    const message = shared ? t('toc.deleteShared', { caption: n.caption, file }) : t('toc.deleteMessage', { caption: n.caption, file })
    let force = shared
    if (n.exists && !shared) {
      const refs = await fetchReferences(file)
      refs.toc = refs.toc.filter(x => x.id !== n.id)
      refs.count = refs.links.length + refs.includes.length + refs.toc.length
      if (refs.count) {
        if (!(await referencesDialog(file, refs, message))) return
        force = true
      }
    }
    let keepChildren = true
    if (n.children.length) {
      const r = await choiceDialog(t('toc.deleteTitle'), (force && !shared ? '' : message + '\n\n') + t('toc.deleteChildren', { n: n.children.length }), [
        { label: t('dialogs.cancel'), value: 'cancel' },
        { label: t('toc.deleteRemoveAll'), value: 'all', danger: true },
        { label: t('toc.deleteKeepChildren'), value: 'keep', primary: true, danger: true },
      ])
      if (r !== 'all' && r !== 'keep') return
      keepChildren = r === 'keep'
    } else if (!force || shared) {
      if (!(await confirmDialog(t('toc.deleteTitle'), message, t('toc.delete'), true))) return
    }
    if (n.exists && !shared && !(await this.opts.closeFile(file))) return
    const r = await this.edit({ op: 'delete', id: n.id, keepChildren }, { force, onReferenced: refs => referencesDialog(file, refs, message) })
    if (r?.deleted) toast(t('toc.deleted', { file: r.deleted }), 'success')
  }

  private countRefs(file: string) {
    let c = 0
    const walk = (nodes: TocNode[]) => nodes.forEach(x => { if (x.file?.toLowerCase() === file.toLowerCase()) c++; walk(x.children) })
    walk(this.state?.tree ?? [])
    return c
  }

  /** Caption of an orphan: its first "# " heading, else its file name. */
  private async orphanCaption(path: string) {
    try {
      const m = (await api.readFile(path)).content.match(/^#\s+(.+?)\s*#*\s*$/m)
      if (m) return m[1]
    } catch { /* unreadable: use the name */ }
    return basename(path, '.md')
  }

  /** Adds an existing topic to the menu (end of the root, or inside the selected node). */
  async addOrphan(path: string, target: TocNode | null = this.selected(), position: TocPosition = 'inside') {
    const caption = await this.orphanCaption(path)
    const href = path.replace(/\.md$/i, '')
    if (target && position === 'inside') this.collapsed.delete(nodeKey(target))
    const r = await this.edit({ op: 'add', target: target?.id ?? null, position, caption, href, create: false }, { reload: true })
    if (r) this.selectNewNode(href)
  }

  private async deleteOrphan(path: string) {
    await deleteFileFlow(path, this.opts.closeFile) // the project reload also reloads the panel
  }

  private async chooseFile() {
    const p = ctx.project
    if (!p) return
    const r = await api.pickFile(t('toc.chooseFile'), p.root, [['XML', '*.xml']])
    if (!r.path) return
    try {
      const info = await api.projectSettings({ tocFile: relativeToRoot(p.root, r.path) })
      await ctx.setProject?.(info, true)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  // ------------------------------------------------------------------
  // Drag & drop
  // ------------------------------------------------------------------

  private dropPosition(e: DragEvent, row: HTMLElement): TocPosition {
    const r = row.getBoundingClientRect()
    const y = (e.clientY - r.top) / r.height
    return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside'
  }

  private canDrop(n: TocNode) {
    const d = this.drag
    if (!d) return false
    return d.kind === 'orphan' || (n.id !== d.id && !n.id.startsWith(d.id + '.'))
  }

  private clearIndicator(row?: HTMLElement) {
    const rows = row ? [row] : [...this.body.querySelectorAll<HTMLElement>('.drop-before, .drop-after, .drop-inside, .drop-end')]
    rows.forEach(r => r.classList.remove('drop-before', 'drop-after', 'drop-inside', 'drop-end'))
    if (!row || row === this.expandRow) { clearTimeout(this.expandTimer); this.expandRow = null }
  }

  private onRowDragOver(e: DragEvent, row: HTMLElement, n: TocNode) {
    if (!this.canDrop(n)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = this.drag?.kind === 'orphan' ? 'copy' : 'move'
    const pos = this.dropPosition(e, row)
    this.body.querySelectorAll('.drop-before, .drop-after, .drop-inside, .drop-end').forEach(r => { if (r !== row) r.classList.remove('drop-before', 'drop-after', 'drop-inside', 'drop-end') })
    row.classList.toggle('drop-before', pos === 'before')
    row.classList.toggle('drop-after', pos === 'after')
    row.classList.toggle('drop-inside', pos === 'inside')
    // Hovering a collapsed section opens it after a while.
    if (n.children.length && this.collapsed.has(nodeKey(n)) && this.expandRow !== row) {
      clearTimeout(this.expandTimer)
      this.expandRow = row
      this.expandTimer = window.setTimeout(() => {
        this.expandRow = null
        this.collapsed.delete(nodeKey(n))
        this.render()
      }, 600)
    }
  }

  private async onRowDrop(e: DragEvent, row: HTMLElement, n: TocNode) {
    const d = this.drag
    if (!d || !this.canDrop(n)) return
    e.preventDefault()
    e.stopPropagation()
    const pos = this.dropPosition(e, row)
    this.endDrag()
    if (pos === 'inside') this.collapsed.delete(nodeKey(n))
    if (d.kind === 'orphan') await this.addOrphan(d.path, n, pos)
    else { const src = this.byId(d.id); if (src) await this.move(src, n.id, pos) }
  }

  /** Below the last node: drop at the end of the root. */
  private onBodyDragOver(e: DragEvent) {
    if (!this.drag || !this.state?.path) return
    const end = (e.target as HTMLElement).closest('.toc-drop-end')
    if (!end) return
    e.preventDefault()
    end.classList.add('drop-end')
  }

  private async onBodyDrop(e: DragEvent) {
    const d = this.drag
    if (!d || !(e.target as HTMLElement).closest('.toc-drop-end')) return
    e.preventDefault()
    this.endDrag()
    const roots = this.state?.tree ?? []
    if (d.kind === 'orphan') await this.addOrphan(d.path, null, 'inside')
    else {
      const src = this.byId(d.id)
      const last = roots[roots.length - 1]
      if (src && last && last.id !== src.id) await this.move(src, last.id, 'after')
    }
  }

  private endDrag() {
    this.drag = null
    this.clearIndicator()
    this.body.querySelectorAll('.dragging').forEach(r => r.classList.remove('dragging'))
  }
}

/** Absolute path -> path relative to the project root when inside it (or "../x" for a sibling folder). */
export function relativeToRoot(root: string, abs: string) {
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  const a = abs.replace(/\\/g, '/')
  if (a.toLowerCase().startsWith(r.toLowerCase() + '/')) return a.slice(r.length + 1)
  const parent = r.slice(0, r.lastIndexOf('/'))
  if (parent && a.toLowerCase().startsWith(parent.toLowerCase() + '/')) return '../' + a.slice(parent.length + 1)
  return a
}
