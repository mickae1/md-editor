// HTML comments (<!-- ... -->): notes visible in the editor only, never on the site.
// A comment on its own lines is an editable text block; a comment inside a
// paragraph is a small tag, edited with a click. Both are saved exactly as read.
import { Node } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { t } from '../i18n'
import { h } from '../ui/dom'
import { promptDialog } from '../ui/dialogs'
import { icon } from '../ui/icons'
import { TODO_RE } from './todo'

/** Text with its TODO markers emphasized (inline comment tag). */
function withTodos(text: string): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = []
  let last = 0
  for (const m of text.matchAll(TODO_RE)) {
    out.push(text.slice(last, m.index), h('b', { class: 'todo-mark' }, 'TODO'))
    last = m.index + 4
  }
  out.push(text.slice(last))
  return out
}

export const CommentBlock = Node.create({
  name: 'comment',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  addAttributes() {
    return {
      // Whitespace between "<!--" and the text, and between the text and "-->".
      pre: { default: ' ', parseHTML: el => el.getAttribute('data-pre') ?? ' ' },
      post: { default: ' ', parseHTML: el => el.getAttribute('data-post') ?? ' ' },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-comment]', preserveWhitespace: 'full', contentElement: el => (el.querySelector('pre') ?? el) as HTMLElement }]
  },
  renderHTML({ node }) {
    return ['div', { 'data-comment': '', 'data-pre': node.attrs.pre, 'data-post': node.attrs.post, class: 'comment-block' },
      ['div', { class: 'comment-label', contenteditable: 'false' }, t('editor.commentLabel')],
      ['pre', { class: 'comment-text', spellcheck: 'true' }, 0]]
  },
  addKeyboardShortcuts() {
    return {
      // Leave the comment: a paragraph after it.
      'Mod-Enter': ({ editor }) => {
        const { $from } = editor.state.selection
        if ($from.parent.type.name !== 'comment') return false
        const after = $from.after()
        return editor.chain().insertContentAt(after, { type: 'paragraph' })
          .command(({ tr }) => { tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1))); return true }).run()
      },
      // Backspace in an empty comment removes it.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection
        if (!empty || $from.parent.type.name !== 'comment' || $from.parent.content.size) return false
        return editor.commands.deleteNode('comment')
      },
    }
  },
})

export const CommentInline = Node.create({
  name: 'commentInline',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    // Everything between "<!--" and "-->", spaces included.
    return { raw: { default: ' ', parseHTML: el => el.getAttribute('data-comment-inline') ?? ' ' } }
  },
  parseHTML() { return [{ tag: 'span[data-comment-inline]' }] },
  renderHTML({ node }) { return ['span', { 'data-comment-inline': node.attrs.raw }] },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      const text = h('span', { class: 'comment-inline-text' })
      const dom = h('span', { class: 'comment-inline', title: t('editor.commentInlineTooltip') }, icon('comment', 12), text)
      const render = () => text.replaceChildren(...withTodos(current.attrs.raw.trim() || '…'))
      render()
      dom.addEventListener('click', async e => {
        e.preventDefault()
        const value = await promptDialog(t('editor.commentInlineTitle'), t('editor.commentInlineLabel'), current.attrs.raw.trim())
        const pos = getPos()
        if (value === null || pos === undefined) return
        const raw = ` ${value.replace(/--+>/g, '').trim()} `
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { raw }))
      })
      return {
        dom,
        update: updated => {
          if (updated.type !== current.type) return false
          current = updated
          render()
          return true
        },
        ignoreMutation: () => true,
      }
    }
  },
})
