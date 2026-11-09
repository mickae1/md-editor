// TODO panel: every TODO marker of the project (GET /api/todos), grouped by
// page. A click opens the page and selects that TODO.
import type { Editor } from '@tiptap/core'
import { api, type Todo } from '../api'
import { ctx } from '../context'
import { hostOf } from '../editor/create'
import { TODO_RE } from '../editor/todo'
import { t } from '../i18n'
import { basename } from '../paths'
import { h } from '../ui/dom'
import { toast } from '../ui/dialogs'
import { icon } from '../ui/icons'

/** Text after the first TODO of a line, without Markdown/HTML punctuation, to find it in the editor. */
function hintAfter(text: string): string {
  const i = text.search(/(?<![A-Za-z0-9_])TODO(?![A-Za-z0-9_])/)
  return (i < 0 ? '' : text.slice(i + 4)).replace(/[*_`[\]()<>!#|\\-]|-->/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24)
}

const flat = (s: string) => s.replace(/[*_`[\]()<>!#|\\-]/g, ' ').replace(/\s+/g, ' ').trim()

/** Selects, in the editor, the TODO that matches the listed line. False if it is not visible (HTML comment...). */
function selectTodo(ed: Editor, todo: Todo): boolean {
  const hint = hintAfter(todo.text)
  const hits: { from: number; after: string }[] = []
  ed.state.doc.descendants((node, pos) => {
    if (!node.isText) return true
    for (const m of (node.text ?? '').matchAll(TODO_RE)) hits.push({ from: pos + m.index, after: '' })
    return false
  })
  for (const hit of hits) hit.after = flat(ed.state.doc.textBetween(hit.from + 4, Math.min(ed.state.doc.content.size, hit.from + 80), ' '))
  const hit = (hint && hits.find(x => x.after.startsWith(hint))) || (!hint && hits[0]) || null
  if (hit) {
    ed.chain().focus().setTextSelection({ from: hit.from, to: hit.from + 4 }).scrollIntoView().run()
    return true
  }
  // TODO inside a comment within a paragraph (<!-- TODO ... -->): select that comment tag.
  let comment = -1
  ed.state.doc.descendants((node, pos) => {
    if (comment >= 0) return false
    if (node.type.name === 'commentInline' && TODO_RE.test(node.attrs.raw)) {
      TODO_RE.lastIndex = 0
      if (!hint || flat(node.attrs.raw.slice(node.attrs.raw.indexOf('TODO') + 4)).startsWith(hint)) comment = pos
    }
    TODO_RE.lastIndex = 0
    return true
  })
  if (comment < 0) return false
  ed.chain().focus().setNodeSelection(comment).scrollIntoView().run()
  return true
}

export class TodoView {
  el = h('div', { class: 'todo-view' })
  private list = h('div', { class: 'todo-list' })
  private filter = h('input', { type: 'search', class: 'filter', placeholder: t('todos.filter') })
  private todos: Todo[] = []
  private listeners = new Set<(n: number) => void>()

  constructor() {
    this.filter.addEventListener('input', () => this.render())
    this.el.append(
      h('div', { class: 'todo-head' },
        this.filter,
        h('button', { class: 'icon-btn', title: t('todos.refresh'), onclick: () => { void this.load() } }, icon('refresh', 14))),
      this.list)
  }

  /** Called with the number of TODOs after every load. */
  onCount(fn: (n: number) => void) { this.listeners.add(fn) }

  async load() {
    if (!ctx.project) { this.todos = []; this.render(); return }
    try { this.todos = await api.todos() } catch { this.todos = [] }
    this.listeners.forEach(fn => fn(this.todos.length))
    // Hidden panel: only the badge is updated; the list is drawn when the tab is shown.
    if (this.el.isConnected) this.render()
  }

  /** Pages whose TODOs are shown (collapsed by default, like the trees). */
  private expanded = new Set<string>()

  render() {
    const words = this.filter.value.toLowerCase().split(/\s+/).filter(Boolean)
    const shown = this.todos.filter(x => words.every(w => `${x.file} ${x.text}`.toLowerCase().includes(w)))
    if (!shown.length) {
      this.list.replaceChildren(h('div', { class: 'empty-hint' }, this.todos.length ? t('todos.noMatch') : t('todos.none')))
      return
    }
    const byFile = new Map<string, Todo[]>()
    for (const x of shown) {
      const items = byFile.get(x.file)
      if (items) items.push(x)
      else byFile.set(x.file, [x])
    }
    // Few results or a filter: everything open. Otherwise only the pages the user opened:
    // a large project has thousands of TODOs, their rows are built on demand.
    const allOpen = words.length > 0 || shown.length <= 60
    const list = this.list
    list.replaceChildren(
      h('div', { class: 'search-summary' }, t('todos.summary', { todos: t('todos.count', { n: shown.length }), pages: t('todos.pages', { n: byFile.size }) })),
      ...[...byFile].map(([file, items]) => {
        const open = allOpen || this.expanded.has(file)
        const group = h('div', { class: `todo-file ${open ? 'open' : ''}` })
        const rows = () => items.map(x => h('div', { class: 'search-hit todo-hit', title: t('todos.lineTitle', { file, line: x.line }), onclick: () => this.goTo(x) },
          h('span', { class: 'line' }, String(x.line)), highlight(x.text)))
        const toggle = (e: Event) => {
          e.stopPropagation()
          if (allOpen) return
          if (this.expanded.has(file)) this.expanded.delete(file)
          else this.expanded.add(file)
          const top = list.scrollTop
          this.render()
          list.scrollTop = top
        }
        group.append(
          h('div', { class: 'search-file-name', title: file, onclick: () => ctx.openFile(file) },
            h('span', { class: 'twisty', onclick: toggle }, icon(open ? 'chevronDown' : 'chevronRight', 13)),
            icon(items[0].kind === 'snippet' ? 'puzzle' : 'file', 13), h('span', { class: 'label' }, basename(file, '.md')),
            h('span', { class: 'count' }, String(items.length))),
          ...(open ? rows() : []))
        return group
      }))
  }

  /** Opens the page and selects the TODO once its editor is ready. */
  goTo(todo: Todo) {
    ctx.openFile(todo.file)
    const deadline = Date.now() + 4000
    const attempt = () => {
      const ed = ctx.activeEditor
      if (ed && !ed.isDestroyed && hostOf(ed).docPath === todo.file) {
        requestAnimationFrame(() => { if (!selectTodo(ed, todo)) toast(t('todos.hidden', { line: todo.line })) })
      } else if (Date.now() < deadline) setTimeout(attempt, 50)
    }
    attempt()
  }
}

/** The line with its TODO markers emphasized. */
function highlight(text: string): HTMLElement {
  const out = h('span', { class: 'todo-text' })
  let last = 0
  for (const m of text.matchAll(TODO_RE)) {
    out.append(text.slice(last, m.index), h('b', { class: 'todo-mark' }, 'TODO'))
    last = m.index + 4
  }
  out.append(text.slice(last))
  return out
}
