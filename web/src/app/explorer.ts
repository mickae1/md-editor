// Explorer: topic tree built from file name prefixes
// (GeneralViews-EntityViewer-Analysis-*.md) and subfolders.
import { ctx, type ProjectFile } from '../context'
import { basename } from '../paths'
import { h } from '../ui/dom'
import { popupMenu } from '../ui/dialogs'
import { icon } from '../ui/icons'
import { t } from '../i18n'

interface TreeNode {
  label: string
  key: string
  children: Map<string, TreeNode>
  file?: ProjectFile
}

export class Explorer {
  el: HTMLElement
  private list: HTMLElement
  private filter: HTMLInputElement
  /** Expanded folder keys: everything is collapsed by default (the session restores them). */
  private open = new Set<string>()
  private activePath: string | null = null
  /** Path opened by a click in this tree: no reveal (the row is already visible). */
  private selfOpen: string | null = null
  /** Called when a folder is expanded or collapsed (session saving). */
  onExpandChange: () => void = () => {}

  constructor() {
    this.filter = h('input', { type: 'search', class: 'filter', placeholder: t('explorer.filterPlaceholder'), oninput: () => this.render() })
    this.list = h('div', { class: 'tree' })
    this.el = h('div', { class: 'explorer' }, this.filter, this.list)
  }

  /** Expanded folder keys, for the session. */
  expandedKeys() { return [...this.open] }

  /** Restores the expanded folders (session), without revealing anything. */
  setExpanded(keys: string[]) {
    this.open = new Set(keys)
    this.render()
  }

  /**
   * Highlights the active topic. When it changes and `reveal` is set, expands
   * its parent folders, unless it was opened from this tree.
   */
  setActive(path: string | null, reveal = true) {
    const changed = path !== this.activePath
    this.activePath = path
    if (changed && reveal && path && path !== this.selfOpen && this.revealPath(path)) this.render()
    this.selfOpen = null
    this.list.querySelectorAll('.tree-item.active').forEach(e => e.classList.remove('active'))
    if (!path) return
    const item = this.list.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`)
    if (item) { item.classList.add('active'); item.scrollIntoView({ block: 'nearest' }) }
  }

  /** Expands the folders containing `path`; true if something changed. */
  private revealPath(path: string) {
    if (!ctx.project) return false
    const tree = this.build(ctx.project.files.filter(f => f.kind === 'topic'))
    const chain: string[] = []
    const walk = (n: TreeNode): boolean => {
      for (const c of n.children.values()) {
        if (c.file?.path === path) return true
        if (c.children.size) {
          chain.push(c.key)
          if (walk(c)) return true
          chain.pop()
        }
      }
      return false
    }
    if (!walk(tree)) return false
    let changed = false
    for (const k of chain) if (!this.open.has(k)) { this.open.add(k); changed = true }
    if (changed) this.onExpandChange()
    return changed
  }

  private openFromTree(path: string) {
    this.selfOpen = path
    ctx.openFile(path)
  }

  private build(files: ProjectFile[]): TreeNode {
    const root: TreeNode = { label: '', key: '', children: new Map() }
    for (const f of files) {
      const dirs = f.path.split('/').slice(0, -1)
      const parts = [...dirs.map(d => d + '/'), ...basename(f.path, '.md').split('-')]
      let node = root
      let key = ''
      for (const part of parts) {
        key += (key && !key.endsWith('/') ? '-' : '') + part
        let child = node.children.get(part)
        if (!child) { child = { label: part.replace(/\/$/, ''), key, children: new Map() }; node.children.set(part, child) }
        node = child
      }
      node.file = f
    }
    // Merge single-child chains without a file: "A" > "B" becomes "A-B".
    const compact = (n: TreeNode): TreeNode => {
      for (const [k, c] of n.children) n.children.set(k, compact(c))
      if (!n.file && n.children.size === 1 && n.label) {
        const [only] = n.children.values()
        if (only.children.size) return { ...only, label: `${n.label}-${only.label}` }
      }
      return n
    }
    return compact(root)
  }

  render() {
    const project = ctx.project
    if (!project) { this.list.replaceChildren(); return }
    const topics = project.files.filter(f => f.kind === 'topic')
    const q = this.filter.value.trim().toLowerCase()
    if (q) {
      const words = q.split(/\s+/)
      const hits = topics.filter(f => words.every(w => f.path.toLowerCase().includes(w)))
      this.list.replaceChildren(...hits.slice(0, 500).map(f => this.fileItem(f, f.path.replace(/\.md$/, ''), 0)))
      if (!hits.length) this.list.append(h('div', { class: 'empty-hint' }, t('explorer.noTopics')))
    } else {
      const tree = this.build(topics)
      this.list.replaceChildren(...this.renderChildren(tree, 0))
    }
    this.setActive(this.activePath)
  }

  private renderChildren(node: TreeNode, depth: number): HTMLElement[] {
    const nodes = [...node.children.values()].sort((a, b) => {
      const fa = a.children.size > 0, fb = b.children.size > 0
      if (fa !== fb) return fa ? -1 : 1
      return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })
    })
    const out: HTMLElement[] = []
    for (const n of nodes) {
      if (!n.children.size && n.file) { out.push(this.fileItem(n.file, n.label, depth)); continue }
      const isOpen = this.open.has(n.key)
      const toggle = () => {
        if (this.open.has(n.key)) this.open.delete(n.key)
        else this.open.add(n.key)
        this.onExpandChange()
        this.render()
      }
      const count = countFiles(n)
      const row = h('div', {
        class: `tree-item folder ${n.file ? 'has-file' : ''} ${isOpen ? 'open' : ''}`, style: `padding-left:${8 + depth * 14}px`,
        'data-path': n.file?.path ?? '', title: n.file ? t('explorer.folderFileTooltip', { path: n.file.path }) : n.key,
        onclick: (e: MouseEvent) => {
          if (n.file && !(e.target as HTMLElement).closest('.twisty')) this.openFromTree(n.file.path)
          else toggle()
        },
      },
      h('span', { class: 'twisty', onclick: (e: Event) => { e.stopPropagation(); toggle() } }, icon(isOpen ? 'chevronDown' : 'chevronRight', 14)),
      icon(n.file ? 'file' : 'folder', 14),
      h('span', { class: 'label' }, n.label),
      h('span', { class: 'count' }, String(count)))
      if (n.file) this.attachMenu(row, n.file)
      out.push(row)
      if (isOpen) out.push(...this.renderChildren(n, depth + 1))
    }
    return out
  }

  private fileItem(f: ProjectFile, label: string, depth: number) {
    const row = h('div', {
      class: 'tree-item file', style: `padding-left:${22 + depth * 14}px`, 'data-path': f.path, title: f.path,
      onclick: () => this.openFromTree(f.path),
    }, icon('file', 14), h('span', { class: 'label' }, label))
    this.attachMenu(row, f)
    return row
  }

  private attachMenu(row: HTMLElement, f: ProjectFile) {
    row.addEventListener('contextmenu', e => {
      e.preventDefault()
      popupMenu(e.clientX, e.clientY, [
        { label: t('explorer.menuOpen'), icon: icon('file', 14), action: () => ctx.openFile(f.path) },
        { label: t('explorer.menuCopyLink'), icon: icon('link', 14), action: () => navigator.clipboard.writeText(`[${basename(f.path, '.md')}](${f.path})`) },
        { label: t('explorer.menuCopyPath'), icon: icon('file', 14), action: () => navigator.clipboard.writeText(f.path) },
      ])
    })
  }
}

function countFiles(n: TreeNode): number {
  let c = n.file ? 1 : 0
  for (const child of n.children.values()) c += countFiles(child)
  return c
}
