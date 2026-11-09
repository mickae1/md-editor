// Snippet block: --8<-- "_snippets/name.md"
// The topic only stores the path; the content is shown by a
// sub-editor bound to the snippet file (see snippets/store.ts).
import { Node, type Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { NodeView } from '@tiptap/pm/view'
import { ctx, type EditorHost } from '../context'
import { basename } from '../paths'
import { h } from '../ui/dom'
import { icon } from '../ui/icons'
import { t } from '../i18n'

class SnippetView implements NodeView {
  dom: HTMLElement
  header: HTMLElement
  body: HTMLElement
  handle: HTMLElement
  badge = h('span', { class: 'snippet-usage' })
  dirtyMark = h('span', { class: 'dirty-dot', title: t('snippetBlock.unsaved') })
  warning = h('div', { class: 'snippet-warning' })
  inner: Editor | null = null
  path: string
  destroyed = false
  unsubscribe: () => void

  constructor(private node: PMNode, private outer: Editor, private getPos: () => number | undefined, host: EditorHost) {
    const src: string = node.attrs.src
    this.path = ctx.includePath(src)
    this.handle = h('span', { class: 'drag-handle', title: t('snippetBlock.move'), draggable: 'true' }, icon('grip', 14))
    const name = h('span', { class: 'snippet-name', title: t('snippetBlock.nameTooltip', { src }) }, basename(src, '.md'))
    this.header = h('div', { class: 'snippet-header' },
      this.handle, icon('puzzle', 14), name, this.dirtyMark, this.badge, h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: t('snippetBlock.openInTab'), onclick: () => ctx.openFile(this.path) }, icon('external', 14)),
      h('button', { class: 'icon-btn', title: t('snippetBlock.detach'), onclick: () => this.detach() }, icon('unlink', 14)),
      h('button', { class: 'icon-btn', title: t('snippetBlock.remove'), onclick: () => this.remove() }, icon('trash', 14)))
    this.header.addEventListener('dblclick', e => {
      if (!(e.target as HTMLElement).closest('button')) ctx.openFile(this.path)
    })
    this.body = h('div', { class: 'snippet-body' })
    this.dom = h('div', { class: 'snippet-block', contenteditable: 'false', 'data-snippet': src }, this.header, this.warning, this.body)

    if (host.ancestors.includes(this.path) || host.docPath === this.path) {
      this.showWarning(t('snippetBlock.circular', { src }))
    } else {
      this.body.append(h('div', { class: 'snippet-loading' }, t('snippetBlock.loading')))
      ctx.snippets.mount(this.path, this.body, host).then(({ editor, entry }) => {
        this.body.querySelector('.snippet-loading')?.remove()
        if (this.destroyed) { ctx.snippets.unmount(this.path, editor); return }
        this.inner = editor
        if (entry.missing) this.showWarning(t('snippetBlock.missing', { path: this.path }))
      })
    }
    this.unsubscribe = ctx.snippets.onChange(() => this.refresh())
    this.refresh()
  }

  showWarning(text: string) {
    this.warning.textContent = text
    this.dom.classList.add('has-warning')
  }

  refresh() {
    const n = ctx.usageOf(this.path).length
    this.badge.textContent = t('snippetBlock.usage', { n })
    this.badge.classList.toggle('shared', n > 1)
    this.dirtyMark.hidden = !ctx.snippets.isDirty(this.path)
  }

  detach() {
    const pos = this.getPos()
    if (pos === undefined || !this.inner) return
    const content = this.inner.getJSON().content ?? []
    this.outer.chain().focus().insertContentAt({ from: pos, to: pos + this.node.nodeSize }, content).run()
  }

  remove() {
    const pos = this.getPos()
    if (pos === undefined) return
    this.outer.view.dispatch(this.outer.state.tr.delete(pos, pos + this.node.nodeSize))
  }

  update(node: PMNode) {
    if (node.type !== this.node.type || node.attrs.src !== this.node.attrs.src) return false
    this.node = node
    return true
  }
  selectNode() { this.dom.classList.add('selected') }
  deselectNode() { this.dom.classList.remove('selected') }
  // Everything inside the block belongs to the sub-editor, except the drag handle.
  stopEvent(e: Event) { return !this.handle.contains(e.target as globalThis.Node) }
  ignoreMutation() { return true }
  destroy() {
    this.destroyed = true
    this.unsubscribe()
    if (this.inner) ctx.snippets.unmount(this.path, this.inner)
  }
}

export function createSnippet(host: EditorHost) {
  return Node.create({
    name: 'snippet',
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes() {
      return { src: { default: '', parseHTML: el => el.getAttribute('data-snippet') ?? '' } }
    },
    parseHTML() { return [{ tag: 'div[data-snippet]' }] },
    renderHTML({ node }) { return ['div', { 'data-snippet': node.attrs.src }] },
    addNodeView() { return ({ node, editor, getPos }) => new SnippetView(node, editor, getPos, host) },
  })
}
