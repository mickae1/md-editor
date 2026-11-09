// Highlights the TODO markers (whole word, case sensitive) in the text, like
// TODO_RE in server/app.py, which lists them in the TODO panel.
import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const TODO_RE = /(?<![A-Za-z0-9_])TODO(?![A-Za-z0-9_])/g

const cache = new WeakMap<PMNode, DecorationSet>()

function todoMarks(doc: PMNode): DecorationSet {
  let set = cache.get(doc)
  if (set) return set
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') return false
    if (!node.isText || node.marks.some(m => m.type.name === 'code')) return true
    for (const m of (node.text ?? '').matchAll(TODO_RE)) {
      decos.push(Decoration.inline(pos + m.index, pos + m.index + 4, { class: 'todo-mark' }))
    }
    return false
  })
  set = DecorationSet.create(doc, decos)
  cache.set(doc, set)
  return set
}

export const TodoHighlight = Extension.create({
  name: 'todoHighlight',
  addProseMirrorPlugins() {
    return [new Plugin({ key: new PluginKey('todoHighlight'), props: { decorations: state => todoMarks(state.doc) } })]
  },
})
