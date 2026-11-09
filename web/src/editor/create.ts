// Editor factory: same set of extensions for topics and snippets.
import { Editor, type Content } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Table, TableRow } from '@tiptap/extension-table'
import type { Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { ctx, type EditorHost } from '../context'
import { Admonition, AnchorNode, Cell, CodeBlock, HeaderCell, RawBlock, RawInline, Tab, TabSet } from './nodes'
import { createImage, uploadImageFile } from './image'
import { createSnippet } from './snippet'
import { createLinkHelpers } from './links'
import { HeadingWithId, createHeadingMenu } from './heading'
import { LinkWithFormat } from './link'
import { TodoHighlight } from './todo'

export const SNIPPET_MIME = 'application/x-mdeditor-snippet'

export function buildExtensions(host: EditorHost) {
  return [
    StarterKit.configure({
      codeBlock: false,
      strike: false,
      underline: false,
      heading: false, // HeadingWithId (attr_list ids)
      link: false, // LinkWithFormat
      dropcursor: { color: '#c4a744', width: 2 },
    }),
    LinkWithFormat,
    TodoHighlight,
    HeadingWithId.configure({ levels: [1, 2, 3, 4, 5, 6] }),
    createHeadingMenu(host),
    CodeBlock,
    Admonition,
    TabSet,
    Tab,
    AnchorNode,
    RawBlock,
    RawInline,
    Table.configure({ resizable: true, allowTableNodeSelection: true }),
    TableRow,
    HeaderCell,
    Cell,
    createImage(host),
    createSnippet(host),
    createLinkHelpers(host),
  ]
}

/** Copies images into images/ and inserts <img> tags. */
export async function insertImageFiles(view: EditorView, files: File[], pos: number | null, host: EditorHost) {
  for (const file of files) {
    if (!/^image\/(png|jpe?g|gif|svg\+xml|webp)$/.test(file.type)) continue
    const { src, width, height } = await uploadImageFile(file, host)
    const node = view.state.schema.nodes.image.create({
      src, width, height,
      alt: file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
    })
    const at = pos ?? view.state.selection.from
    view.dispatch(view.state.tr.insert(at, node))
    pos = at + node.nodeSize
  }
}

const hosts = new WeakMap<Editor, EditorHost>()
export const hostOf = (editor: Editor): EditorHost => hosts.get(editor) ?? { docPath: 'index.md', ancestors: [] }

export function createEditor(opts: {
  element: HTMLElement
  content: Content
  host: EditorHost
  onTransaction?: (tr: Transaction) => void
}): Editor {
  const { host } = opts
  const editor = new Editor({
    element: opts.element,
    content: opts.content,
    extensions: buildExtensions(host),
    editorProps: {
      attributes: { class: 'md-content', spellcheck: 'true' },
      handleDrop(view, event, _slice, moved) {
        if (moved || !event.dataTransfer) return false
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
        const src = event.dataTransfer.getData(SNIPPET_MIME)
        if (src) {
          event.preventDefault()
          const node = view.state.schema.nodes.snippet.create({ src })
          let pos = coords?.pos ?? view.state.selection.from
          // Insert at the nearest block level.
          const $pos = view.state.doc.resolve(pos)
          if ($pos.parent.isTextblock) pos = $pos.depth > 0 ? $pos.after() : pos
          view.dispatch(view.state.tr.insert(pos, node))
          return true
        }
        const files = [...event.dataTransfer.files].filter(f => f.type.startsWith('image/'))
        if (files.length) {
          event.preventDefault()
          insertImageFiles(view, files, coords?.pos ?? null, host)
          return true
        }
        return false
      },
      handlePaste(view, event) {
        const files = [...(event.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'))
        if (!files.length) return false
        insertImageFiles(view, files, null, host)
        return true
      },
    },
    onFocus: ({ editor }) => ctx.setActiveEditor(editor),
    onTransaction: ({ transaction }) => {
      opts.onTransaction?.(transaction)
      if (ctx.activeEditor === editor) ctx.onEditorChange()
    },
  })
  hosts.set(editor, host)
  return editor
}
