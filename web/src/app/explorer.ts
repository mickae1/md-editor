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

const STORAGE_KEY = 'mdeditor.explorer.open'

function loadOpen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')) } catch { return new Set() }
}

export class Explorer {
  el: HTMLElement
  private list: HTMLElement
  private filter: HTMLInputElement
  private open = loadOpen()
  private activePath: string | null = null

  constructor() {
    this.filter = h('input', { type: 'search', class: 'filter', placeholder: t('explorer.filterPlaceholder'), oninput: () => this.render() })
    this.list = h('div', { class: 'tree' })
    this.el = h('div', { class: 'explorer' }, this.filter, this.list)
  }

  setActive(path: string | null) {
    this.activePath = path
    this.list.querySelectorAll('.tree-item.active').forEach(e => e.classList.remove('active'))
    if (!path) return
    const item = this.list.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`)
    if (item) { item.classList.add('active'); item.scrollIntoView({ block: 'nearest' }) }
  }

  private saveOpen() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.open])) } catch { /* storage unavailable */ }
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
        this.saveOpen()
        this.render()
      }
      const count = countFiles(n)
      const row = h('div', {
        class: `tree-item folder ${n.file ? 'has-file' : ''}`, style: `padding-left:${8 + depth * 14}px`,
        'data-path': n.file?.path ?? '', title: n.file ? t('explorer.folderFileTooltip', { path: n.file.path }) : n.key,
        onclick: (e: MouseEvent) => {
          if (n.file && !(e.target as HTMLElement).closest('.twisty')) ctx.openFile(n.file.path)
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
      onclick: () => ctx.openFile(f.path),
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
