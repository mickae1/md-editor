// MkDocs / pymdownx specific nodes: admonitions, tabs, anchors, raw HTML.
import { Node, mergeAttributes, type Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { NodeView, ViewMutationRecord } from '@tiptap/pm/view'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { TableCell, TableHeader } from '@tiptap/extension-table'
import { common, createLowlight } from 'lowlight'
import { h } from '../ui/dom'
import { ADMONITION_TYPES, admonitionType, icon } from '../ui/icons'
import { t } from '../i18n'

/** Enter on an empty paragraph at the end of a container: leave the container. */
function exitContainer(editor: Editor, types: string[]): boolean {
  const { state } = editor
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.name !== 'paragraph' || $from.parent.content.size) return false
  const d = $from.depth - 1
  if (d < 1) return false
  const container = $from.node(d)
  if (!types.includes(container.type.name)) return false
  if ($from.index(d) !== container.childCount - 1 || container.childCount < 2) return false
  let target = d
  // For a tab, leave the whole tab group.
  if (container.type.name === 'tab' && $from.node(d - 1).type.name === 'tabset') target = d - 1
  const after = $from.after(target)
  const tr = state.tr.delete($from.before(), $from.after())
  const pos = tr.mapping.map(after)
  tr.insert(pos, state.schema.nodes.paragraph.create())
  tr.setSelection(TextSelection.create(tr.doc, pos + 1))
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

function updateAttrs(editor: Editor, getPos: () => number | undefined, attrs: Record<string, unknown>) {
  const pos = getPos()
  if (pos === undefined) return
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }))
}

function deleteNode(editor: Editor, getPos: () => number | undefined) {
  const pos = getPos()
  if (pos === undefined) return
  const node = editor.state.doc.nodeAt(pos)
  if (node) editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
}

/** NodeView with a non-editable header (fields) and editable content. */
abstract class HeaderNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  header: HTMLElement
  constructor(protected node: PMNode, protected editor: Editor, protected getPos: () => number | undefined) {
    this.header = h('div', { class: 'block-header', contenteditable: 'false' })
    this.contentDOM = h('div', { class: 'block-body' })
    this.dom = h('div', null, this.header, this.contentDOM)
  }
  abstract render(): void
  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }
  stopEvent(event: Event) {
    return this.header.contains(event.target as globalThis.Node) && !(event.target as HTMLElement).closest('.drag-handle')
  }
  ignoreMutation(m: ViewMutationRecord) {
    return m.type !== 'selection' && this.header.contains(m.target)
  }
}

// --------------------------------------------------------------------------
// Admonitions: !!! note "Title"   /   ??? note   /   ???+ note
// --------------------------------------------------------------------------

class AdmonitionView extends HeaderNodeView {
  kindSelect: HTMLSelectElement
  titleInput: HTMLInputElement
  modeSelect: HTMLSelectElement
  iconBox = h('span', { class: 'adm-icon' })
  constructor(node: PMNode, editor: Editor, getPos: () => number | undefined) {
    super(node, editor, getPos)
    this.kindSelect = h('select', {
      class: 'adm-kind', title: t('editor.admonitionType'),
      onchange: () => updateAttrs(editor, getPos, { kind: this.kindSelect.value }),
    }, ...ADMONITION_TYPES.map(a => h('option', { value: a.kind }, a.label)))
    this.titleInput = h('input', {
      class: 'adm-title', type: 'text', spellcheck: true,
      // Empty field: default title (null), unless the title was explicitly empty ("").
      onchange: () => updateAttrs(editor, getPos, {
        title: this.titleInput.value === '' ? (this.node.attrs.title === '' ? '' : null) : this.titleInput.value,
      }),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault()
          this.titleInput.blur()
          const pos = getPos()
          if (pos !== undefined) editor.chain().focus().setTextSelection(pos + 2).run()
        }
      },
    })
    this.modeSelect = h('select', {
      class: 'adm-mode', title: t('editor.admonitionMode'),
      onchange: () => updateAttrs(editor, getPos, { mode: this.modeSelect.value }),
    },
    h('option', { value: '!!!' }, t('editor.modeFixed')),
    h('option', { value: '???' }, t('editor.modeCollapsed')),
    h('option', { value: '???+' }, t('editor.modeExpanded')))
    const remove = h('button', { class: 'icon-btn', title: t('editor.deleteBlock'), onclick: () => deleteNode(editor, getPos) }, icon('trash', 14))
    const handle = h('span', { class: 'drag-handle', title: t('editor.move'), draggable: 'true', 'data-drag-handle': '' }, icon('grip', 14))
    this.header.append(handle, this.iconBox, this.kindSelect, this.titleInput, h('span', { class: 'spacer' }), this.modeSelect, remove)
    this.render()
  }
  render() {
    const { kind, title, mode, classes } = this.node.attrs
    const type = admonitionType(kind)
    this.dom.className = `admonition ${type.kind} ${mode !== '!!!' ? 'is-details' : ''} ${classes || ''}`
    this.iconBox.replaceChildren(icon(type.icon, 16))
    if (!ADMONITION_TYPES.some(a => a.kind === kind)) {
      if (![...this.kindSelect.options].some(o => o.value === kind)) this.kindSelect.append(h('option', { value: kind }, kind))
    }
    this.kindSelect.value = kind
    this.modeSelect.value = mode
    this.titleInput.placeholder = title === '' ? t('editor.untitled') : kind.charAt(0).toUpperCase() + kind.slice(1)
    if (document.activeElement !== this.titleInput) this.titleInput.value = title ?? ''
  }
}

export const Admonition = Node.create({
  name: 'admonition',
  group: 'block',
  content: 'block+',
  defining: true,
  draggable: true,
  addAttributes() {
    return {
      kind: { default: 'note', parseHTML: el => el.getAttribute('data-admonition') || 'note', renderHTML: a => ({ 'data-admonition': a.kind }) },
      mode: { default: '!!!', parseHTML: el => el.getAttribute('data-mode') || '!!!', renderHTML: a => ({ 'data-mode': a.mode }) },
      classes: { default: '', parseHTML: el => el.getAttribute('data-classes') || '', renderHTML: a => ({ 'data-classes': a.classes }) },
      title: {
        default: null,
        parseHTML: el => (el.hasAttribute('data-title') ? el.getAttribute('data-title') : null),
        renderHTML: a => (a.title === null ? {} : { 'data-title': a.title }),
      },
    }
  },
  parseHTML() { return [{ tag: 'div[data-admonition]' }] },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes), 0] },
  addNodeView() { return ({ node, editor, getPos }) => new AdmonitionView(node, editor, getPos) },
  addKeyboardShortcuts() {
    return { Enter: ({ editor }) => exitContainer(editor, ['admonition', 'tab']) }
  },
})

// --------------------------------------------------------------------------
// Tabs: === "Title"
// --------------------------------------------------------------------------

export const TabSet = Node.create({
  name: 'tabset',
  group: 'block',
  content: 'tab+',
  defining: true,
  parseHTML() { return [{ tag: 'div[data-tabset]' }] },
  renderHTML() { return ['div', { 'data-tabset': '', class: 'tabbed-set' }, 0] },
})

class TabView extends HeaderNodeView {
  titleInput: HTMLInputElement
  constructor(node: PMNode, editor: Editor, getPos: () => number | undefined) {
    super(node, editor, getPos)
    this.dom.className = 'tabbed-block'
    this.titleInput = h('input', {
      class: 'tab-title', type: 'text', placeholder: t('editor.tabTitlePlaceholder'),
      onchange: () => updateAttrs(editor, getPos, { title: this.titleInput.value }),
    })
    const add = h('button', {
      class: 'icon-btn', title: t('editor.addTabAfter'),
      onclick: () => {
        const pos = getPos()
        if (pos === undefined) return
        const n = editor.state.doc.nodeAt(pos)
        if (!n) return
        const { schema } = editor.state
        const tab = schema.nodes.tab.create({ title: t('editor.newTab') }, schema.nodes.paragraph.create())
        editor.chain().focus().command(({ tr }) => { tr.insert(pos + n.nodeSize, tab); return true })
          .setTextSelection(pos + n.nodeSize + 2).run()
      },
    }, icon('plus', 14))
    const remove = h('button', {
      class: 'icon-btn', title: t('editor.deleteTab'),
      onclick: () => {
        const pos = getPos()
        if (pos === undefined) return
        const $pos = editor.state.doc.resolve(pos)
        if ($pos.parent.type.name === 'tabset' && $pos.parent.childCount === 1) {
          const setPos = $pos.before()
          editor.view.dispatch(editor.state.tr.delete(setPos, setPos + $pos.parent.nodeSize))
        } else deleteNode(editor, getPos)
      },
    }, icon('trash', 14))
    this.header.append(icon('tabs', 14), this.titleInput, h('span', { class: 'spacer' }), add, remove)
    this.render()
  }
  render() {
    if (document.activeElement !== this.titleInput) this.titleInput.value = this.node.attrs.title
  }
}

export const Tab = Node.create({
  name: 'tab',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      title: { default: t('editor.tabDefault'), parseHTML: el => el.getAttribute('data-title') ?? '', renderHTML: a => ({ 'data-title': a.title }) },
      flags: { default: '', parseHTML: el => el.getAttribute('data-flags') ?? '', renderHTML: a => ({ 'data-flags': a.flags }) },
    }
  },
  parseHTML() { return [{ tag: 'div[data-tab]' }] },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-tab': '' }), 0] },
  addNodeView() { return ({ node, editor, getPos }) => new TabView(node, editor, getPos) },
})

// --------------------------------------------------------------------------
// Anchors <a id="..."></a>
// --------------------------------------------------------------------------

export const AnchorNode = Node.create({
  name: 'anchor',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { id: { default: '', parseHTML: el => el.getAttribute('data-anchor') ?? el.getAttribute('id') ?? el.getAttribute('name') ?? '' } }
  },
  parseHTML() {
    return [
      { tag: 'a[data-anchor]' },
      { tag: 'a[id]', getAttrs: el => (el.hasAttribute('href') ? false : null) },
    ]
  },
  renderHTML({ node }) { return ['a', { 'data-anchor': node.attrs.id }] },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = h('span', { class: 'anchor-chip', title: t('editor.anchorTooltip', { id: node.attrs.id }) }, icon('anchor', 12))
      dom.addEventListener('dblclick', () => {
        const id = window.prompt(t('editor.anchorPrompt'), node.attrs.id)
        if (id !== null) updateAttrs(editor, getPos, { id: id.trim() })
      })
      return { dom }
    }
  },
})

// --------------------------------------------------------------------------
// Raw HTML kept as is
// --------------------------------------------------------------------------

class RawBlockView implements NodeView {
  dom: HTMLElement
  area: HTMLTextAreaElement
  constructor(private node: PMNode, editor: Editor, getPos: () => number | undefined) {
    this.area = h('textarea', {
      class: 'raw-area', spellcheck: false, rows: 1,
      oninput: () => { this.autosize() },
      onchange: () => updateAttrs(editor, getPos, { raw: this.area.value }),
    })
    this.dom = h('div', { class: 'raw-block', contenteditable: 'false' },
      h('div', { class: 'raw-label' }, icon('raw', 12), t('editor.rawLabel'),
        h('button', { class: 'icon-btn', title: t('editor.delete'), onclick: () => deleteNode(editor, getPos) }, icon('trash', 12))),
      this.area)
    this.area.value = node.attrs.raw
    requestAnimationFrame(() => this.autosize())
  }
  autosize() {
    this.area.style.height = 'auto'
    this.area.style.height = `${this.area.scrollHeight + 2}px`
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    if (document.activeElement !== this.area && this.area.value !== node.attrs.raw) {
      this.area.value = node.attrs.raw
      this.autosize()
    }
    return true
  }
  stopEvent(e: Event) { return e.target === this.area || (e.target as HTMLElement).closest?.('button') != null }
  ignoreMutation() { return true }
}

export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { raw: { default: '', parseHTML: el => el.getAttribute('data-raw-block') ?? '' } }
  },
  parseHTML() { return [{ tag: 'div[data-raw-block]' }] },
  renderHTML({ node }) { return ['div', { 'data-raw-block': node.attrs.raw }] },
  addNodeView() { return ({ node, editor, getPos }) => new RawBlockView(node, editor, getPos) },
})

export const RawInline = Node.create({
  name: 'rawInline',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { raw: { default: '', parseHTML: el => el.getAttribute('data-raw-inline') ?? '' } }
  },
  parseHTML() { return [{ tag: 'span[data-raw-inline]' }] },
  renderHTML({ node }) { return ['span', { 'data-raw-inline': node.attrs.raw }] },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = h('span', { class: 'raw-inline', title: t('editor.rawInlineTooltip') }, node.attrs.raw)
      dom.addEventListener('dblclick', () => {
        const raw = window.prompt(t('editor.rawInlinePrompt'), node.attrs.raw)
        if (raw !== null) updateAttrs(editor, getPos, { raw })
      })
      return { dom }
    }
  },
})

// --------------------------------------------------------------------------
// Code blocks with highlighting and language choice
// --------------------------------------------------------------------------

export const lowlight = createLowlight(common)
export const CODE_LANGUAGES = ['', ...lowlight.listLanguages().sort()]

class CodeBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  select: HTMLSelectElement
  constructor(private node: PMNode, editor: Editor, getPos: () => number | undefined) {
    this.select = h('select', {
      class: 'code-lang', title: t('editor.codeLanguage'),
      onchange: () => updateAttrs(editor, getPos, { language: this.select.value || null, info: this.select.value }),
    }, ...CODE_LANGUAGES.map(l => h('option', { value: l }, l || t('editor.plainText'))))
    this.contentDOM = h('code')
    this.dom = h('div', { class: 'code-wrap' },
      h('div', { class: 'code-toolbar', contenteditable: 'false' }, this.select),
      h('pre', null, this.contentDOM))
    this.render()
  }
  render() {
    const lang = this.node.attrs.language || ''
    if (![...this.select.options].some(o => o.value === lang)) this.select.append(h('option', { value: lang }, lang))
    this.select.value = lang
    this.contentDOM.className = lang ? `hljs language-${lang}` : 'hljs'
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }
  stopEvent(e: Event) { return e.target === this.select }
  ignoreMutation(m: ViewMutationRecord) { return m.type !== 'selection' && !this.contentDOM.contains(m.target) }
}

export const CodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      info: { default: '', parseHTML: el => el.getAttribute('data-info') ?? '', renderHTML: a => ({ 'data-info': a.info }) },
    }
  },
  addNodeView() { return ({ node, editor, getPos }) => new CodeBlockView(node, editor, getPos) },
}).configure({ lowlight, defaultLanguage: null })

// --------------------------------------------------------------------------
// Table cells with alignment
// --------------------------------------------------------------------------

const alignAttr = {
  align: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-align') || el.style.textAlign || null,
    renderHTML: (a: Record<string, unknown>) => (a.align ? { style: `text-align:${a.align}`, 'data-align': a.align } : {}),
  },
}

export const Cell = TableCell.extend({ addAttributes() { return { ...this.parent?.(), ...alignAttr } } })
export const HeaderCell = TableHeader.extend({ addAttributes() { return { ...this.parent?.(), ...alignAttr } } })
