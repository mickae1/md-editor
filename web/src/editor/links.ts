// Internal links: Ctrl+click opens the target topic, broken links are underlined.
import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ctx, type EditorHost } from '../context'
import { dirname, join } from '../paths'
import { t } from '../i18n'

export function resolveLink(href: string, host: EditorHost): { path: string; anchor?: string } | null {
  if (!href || /^[a-z][\w+.-]*:/i.test(href) || href.startsWith('#')) return null
  const [file, anchor] = href.split('#')
  if (!file.toLowerCase().endsWith('.md')) return null
  return { path: join(dirname(host.docPath), decodeURI(file)), anchor }
}

const cache = new WeakMap<PMNode, DecorationSet>()

function brokenLinks(doc: PMNode, host: EditorHost): DecorationSet {
  let set = cache.get(doc)
  if (set) return set
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const link = node.marks.find(m => m.type.name === 'link')
    if (!link) return false
    const target = resolveLink(link.attrs.href, host)
    if (target && !ctx.fileExists(target.path)) {
      decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'broken-link', title: t('editor.brokenLink', { path: target.path }) }))
    }
    return false
  })
  set = DecorationSet.create(doc, decos)
  cache.set(doc, set)
  return set
}

export function createLinkHelpers(host: EditorHost) {
  return Extension.create({
    name: 'linkHelpers',
    addProseMirrorPlugins() {
      return [new Plugin({
        key: new PluginKey('linkHelpers'),
        props: {
          decorations: state => brokenLinks(state.doc, host),
          handleClick: (view, pos, event) => {
            if (!(event.ctrlKey || event.metaKey)) return false
            const $pos = view.state.doc.resolve(pos)
            const link = $pos.marks().find(m => m.type.name === 'link')
              ?? view.state.doc.nodeAt(pos)?.marks.find(m => m.type.name === 'link')
            if (!link) return false
            const href: string = link.attrs.href
            const target = resolveLink(href, host)
            if (target) ctx.openFile(target.path, target.anchor)
            else if (/^https?:/i.test(href)) window.open(href, '_blank')
            return true
          },
        },
      })]
    },
  })
}
