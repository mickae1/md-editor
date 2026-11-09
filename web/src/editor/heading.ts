// Headings with an attr_list anchor id ("## Title { #my-id }"). The id is not
// part of the editable text: it is a node attribute, shown as a badge (CSS) and
// edited from the heading's context menu.
import { Extension } from '@tiptap/core'
import Heading from '@tiptap/extension-heading'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { EditorHost } from '../context'
import { t } from '../i18n'
import { ANCHOR_ID_RE, docAnchors, slugify } from '../markdown/anchors'
import { basename } from '../paths'
import { alertDialog, confirmDialog, popupMenu, promptDialog, toast } from '../ui/dialogs'
import { icon } from '../ui/icons'

/** Number of headings carrying each id. */
function headingIds(doc: PMNode): Map<string, number> {
  const ids = new Map<string, number>()
  doc.descendants(node => {
    if (node.type.name === 'heading' && node.attrs.id) ids.set(node.attrs.id, (ids.get(node.attrs.id) ?? 0) + 1)
    return node.type.name !== 'heading'
  })
  return ids
}

export const HeadingWithId = Heading.extend({
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), new Plugin({
      key: new PluginKey('headingIdUnique'),
      // Splitting a heading in the middle (Enter) or pasting one copies its id:
      // an id that was unique stays on its first heading only.
      appendTransaction: (trs, oldState, newState) => {
        if (!trs.some(tr => tr.docChanged)) return null
        const before = headingIds(oldState.doc)
        const dup = [...headingIds(newState.doc)].filter(([id, n]) => n > 1 && (before.get(id) ?? 0) <= 1).map(([id]) => id)
        if (!dup.length) return null
        const tr = newState.tr
        const seen = new Set<string>()
        newState.doc.descendants((node, pos) => {
          if (node.type.name !== 'heading') return true
          const id = node.attrs.id
          if (id && dup.includes(id)) {
            if (seen.has(id)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: null, idCompact: false })
            seen.add(id)
          }
          return false
        })
        return tr.setMeta('addToHistory', false)
      },
    })]
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      id: {
        default: null,
        // Enter in the middle of a heading must not duplicate its id.
        keepOnSplit: false,
        parseHTML: el => el.getAttribute('data-heading-id'),
        renderHTML: attrs => attrs.id
          ? { 'data-heading-id': attrs.id, title: t('editor.headingIdTooltip', { id: attrs.id }) }
          : {},
      },
      idCompact: {
        default: false,
        keepOnSplit: false,
        parseHTML: el => el.hasAttribute('data-heading-id-compact'),
        renderHTML: () => ({}),
      },
    }
  },
})

/** The heading node containing a DOM element of this view, with its position. */
function headingAt(view: EditorView, target: EventTarget | null): { node: PMNode; pos: number } | null {
  const el = (target as HTMLElement | null)?.closest?.('h1, h2, h3, h4, h5, h6')
  if (!el || el.closest('.ProseMirror') !== view.dom) return null
  const $pos = view.state.doc.resolve(view.posAtDOM(el, 0))
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'heading') return { node: $pos.node(d), pos: $pos.before(d) }
  }
  return null
}

/** Asks for a new id; null = cancelled, '' = remove. */
async function askId(view: EditorView, node: PMNode, pos: number): Promise<string | null> {
  const auto = slugify(node.textContent)
  let value: string = node.attrs.id ?? auto
  for (;;) {
    const r = await promptDialog(t('editor.headingIdTitle'), t('editor.headingIdLabel'), value,
      { hint: t('editor.headingIdHint', { auto: auto || '—' }) })
    if (r === null) return null
    value = r.trim().replace(/^#/, '')
    if (!value) return ''
    if (!ANCHOR_ID_RE.test(value)) { await alertDialog(t('editor.headingIdTitle'), t('editor.headingIdInvalid', { id: value })); continue }
    const taken = docAnchors(view.state.doc).find(a => a.id === value && a.pos !== pos)
    if (taken && !(await confirmDialog(t('editor.headingIdTitle'),
      t('editor.headingIdDuplicate', { id: value, label: taken.label || `<a id="${value}">` }), t('editor.headingIdUseAnyway')))) continue
    return value
  }
}

function setId(view: EditorView, pos: number, id: string | null) {
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, id, idCompact: id ? node.attrs.idCompact : false }))
}

export function createHeadingMenu(host: EditorHost) {
  return Extension.create({
    name: 'headingMenu',
    addProseMirrorPlugins() {
      return [new Plugin({
        key: new PluginKey('headingMenu'),
        props: {
          handleDOMEvents: {
            contextmenu: (view, event) => {
              const hit = headingAt(view, event.target)
              if (!hit) return false
              event.preventDefault()
              const { node, pos } = hit
              const id: string | null = node.attrs.id
              const anchor = id || docAnchors(view.state.doc).find(a => a.pos === pos)?.id || slugify(node.textContent)
              popupMenu(event.clientX, event.clientY, [
                {
                  label: id ? t('editor.headingIdEdit', { id }) : t('editor.headingIdAdd'),
                  icon: icon('anchor', 14),
                  action: async () => {
                    const r = await askId(view, node, pos)
                    if (r !== null) setId(view, pos, r || null)
                    view.focus()
                  },
                },
                { label: t('editor.headingIdRemove'), icon: icon('x', 14), disabled: !id, action: () => { setId(view, pos, null); view.focus() } },
                'sep',
                {
                  label: t('editor.headingCopyLink', { anchor }),
                  icon: icon('link', 14),
                  action: () => {
                    navigator.clipboard.writeText(`[${node.textContent.trim()}](${basename(host.docPath)}#${anchor})`)
                      .then(() => toast(t('editor.headingLinkCopied')), () => undefined)
                  },
                },
              ])
              return true
            },
          },
        },
      })]
    },
  })
}
