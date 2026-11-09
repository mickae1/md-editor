// Editing commands triggered by the toolbar, menus and keyboard shortcuts.
import type { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { api } from '../api'
import { ctx } from '../context'
import { hostOf, insertImageFiles } from '../editor/create'
import { IMAGE_ACCEPT } from '../editor/image'
import { markdownToHtml } from '../markdown/parser'
import { serializeDoc } from '../markdown/serializer'
import { basename, join } from '../paths'
import { h } from '../ui/dom'
import { alertDialog, linkDialog, promptDialog, toast } from '../ui/dialogs'
import { t } from '../i18n'
import { palette } from '../ui/palette'

const ed = () => ctx.activeEditor

export function topicLinkTargets(): string[] {
  return (ctx.project?.files ?? []).filter(f => f.kind === 'topic').map(f => f.path)
}

export async function editLink(editor = ed()) {
  if (!editor) return
  const { state } = editor
  const isLink = editor.isActive('link')
  if (isLink) editor.chain().extendMarkRange('link').run()
  const { from, to, empty } = editor.state.selection
  const text = state.doc.textBetween(from, to, ' ')
  const href = isLink ? editor.getAttributes('link').href ?? '' : ''
  const result = await linkDialog({ text, href, showText: empty }, topicLinkTargets())
  if (!result) { editor.commands.focus(); return }
  if (result === 'remove') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return }
  if (empty) {
    editor.chain().focus().insertContent({ type: 'text', text: result.text, marks: [{ type: 'link', attrs: { href: result.href } }] }).run()
  } else {
    editor.chain().focus().extendMarkRange('link').setLink({ href: result.href }).run()
  }
}

export async function insertAnchor(editor = ed()) {
  if (!editor) return
  const id = await promptDialog(t('commands.anchorTitle'), t('commands.anchorPrompt'), '', { hint: t('commands.anchorHint') })
  if (!id?.trim()) return
  editor.chain().focus().insertContent({ type: 'anchor', attrs: { id: id.trim().replace(/^#/, '').replace(/\s+/g, '-') } }).run()
}

export function insertImage(editor = ed()) {
  if (!editor) return
  const input = h('input', { type: 'file', accept: IMAGE_ACCEPT, multiple: true })
  input.onchange = () => {
    const files = [...(input.files ?? [])]
    if (files.length) insertImageFiles(editor.view, files, null, hostOf(editor)).catch(e => toast((e as Error).message, 'error'))
  }
  input.click()
}

export function insertTable(rows: number, cols: number, editor = ed()) {
  editor?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run()
}

export function setColumnAlign(align: 'left' | 'center' | 'right' | null, editor = ed()) {
  if (!editor) return
  // Alignment applies to the whole column (Markdown syntax).
  const { state } = editor
  const $from = state.selection.$from
  let cellDepth = -1
  for (let d = $from.depth; d > 0; d--) if (/^table(Cell|Header)$/.test($from.node(d).type.name)) { cellDepth = d; break }
  if (cellDepth < 0) return
  const col = $from.index(cellDepth - 1)
  const tablePos = $from.before(cellDepth - 2)
  const table = $from.node(cellDepth - 2)
  const tr = state.tr
  table.forEach((row, rowOffset) => {
    row.forEach((cell, off, i) => {
      if (i === col) tr.setNodeMarkup(tablePos + 1 + rowOffset + 1 + off, undefined, { ...cell.attrs, align })
    })
  })
  editor.view.dispatch(tr)
  editor.commands.focus()
}

export function insertAdmonition(kind: string, mode = '!!!', editor = ed()) {
  if (!editor) return
  if (!editor.chain().focus().wrapIn('admonition', { kind, mode }).run()) {
    editor.chain().focus().insertContent({ type: 'admonition', attrs: { kind, mode }, content: [{ type: 'paragraph' }] }).run()
  }
}

export function insertTabs(editor = ed()) {
  editor?.chain().focus().insertContent({
    type: 'tabset',
    content: [
      { type: 'tab', attrs: { title: t('commands.tabTitle', { index: 1 }) }, content: [{ type: 'paragraph' }] },
      { type: 'tab', attrs: { title: t('commands.tabTitle', { index: 2 }) }, content: [{ type: 'paragraph' }] },
    ],
  }).run()
}

export function insertRawHtml(editor = ed()) {
  editor?.chain().focus().insertContent({ type: 'rawBlock', attrs: { raw: '<div markdown>\n\n</div>' } }).run()
}

export function insertSnippetAt(path: string, editor = ed()) {
  if (!editor) { toast(t('commands.openTopicFirst')); return }
  editor.chain().focus().insertContent({ type: 'snippet', attrs: { src: ctx.includeSrc(path) } }).run()
}

/** Snippet insertion palette with preview. */
export async function pickAndInsertSnippet() {
  const editor = ed()
  if (!editor) { toast(t('commands.openTopicFirst')); return }
  const items = (ctx.project?.files ?? []).filter(f => f.kind === 'snippet').map(f => {
    const n = ctx.usageOf(f.path).length
    return { label: basename(f.path, '.md'), detail: f.path, value: f.path, badge: `${n}` }
  })
  const picked = await palette({
    title: t('commands.insertSnippetTitle'),
    placeholder: t('commands.searchSnippetPlaceholder'),
    items,
    preview: async (item, el) => {
      try {
        const { content } = await api.readFile(item.value)
        const tmp = h('div')
        tmp.innerHTML = markdownToHtml(content)
        tmp.querySelectorAll('img').forEach(img => { img.src = ctx.imageUrl(img.getAttribute('src') || '', { docPath: 'index.md', ancestors: [] }) })
        tmp.querySelectorAll('[data-snippet]').forEach(e => { e.className = 'preview-snippet'; e.textContent = `--8<-- ${e.getAttribute('data-snippet')}` })
        tmp.querySelectorAll('[data-admonition]').forEach(e => e.classList.add('admonition', e.getAttribute('data-admonition') || 'note'))
        el.replaceChildren(...tmp.childNodes)
      } catch { el.textContent = t('commands.previewUnavailable') }
    },
  })
  if (picked) insertSnippetAt(picked.value, editor)
}

function slug(text: string) {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

/** "Extract to snippet": selected blocks -> new file + include. */
export async function extractSnippet(editor: Editor | null = ed()) {
  if (!editor || !ctx.project) return
  const { state } = editor
  const { $from, $to } = state.selection
  const range = $from.blockRange($to)
  if (!range || range.parent.type.name === 'tabset') {
    await alertDialog(t('commands.extractTitle'), t('commands.extractSelectBlocks'))
    return
  }
  const blocks: ReturnType<typeof range.parent.child>[] = []
  for (let i = range.startIndex; i < range.endIndex; i++) blocks.push(range.parent.child(i))
  // List items cannot become a snippet on their own: take the whole list.
  if (blocks.some(b => b.type.name === 'listItem')) {
    await alertDialog(t('commands.extractTitle'), t('commands.extractSelectWholeList'))
    return
  }
  const tmpDoc = state.schema.topNodeType.create(null, Fragment.fromArray(blocks))
  const markdown = serializeDoc(tmpDoc)
  if (!markdown.trim()) { toast(t('commands.emptySelection')); return }

  const firstText = blocks.map(b => b.textContent).find(s => s.trim()) ?? 'snippet'
  const name = await promptDialog(t('commands.extractTitle'), t('commands.fileNamePrompt', { dir: ctx.project.snippetDir }), `snippet-${slug(firstText)}`,
    { hint: t('commands.extractHint') })
  if (!name?.trim()) return
  const file = name.trim().replace(/\.md$/i, '') + '.md'
  const path = join(ctx.project.snippetDir, file)
  try {
    await api.createFile(path, markdown)
  } catch (e) {
    await alertDialog(t('commands.extractTitle'), (e as Error).message)
    return
  }
  const node = state.schema.nodes.snippet.create({ src: ctx.includeSrc(path) })
  editor.view.dispatch(editor.state.tr.replaceWith(range.start, range.end, node))
  await ctx.reloadProject?.()
  toast(t('commands.snippetCreated', { path }), 'success')
}

export async function createSnippet() {
  if (!ctx.project) return
  const name = await promptDialog(t('commands.newSnippetTitle'), t('commands.fileNamePrompt', { dir: ctx.project.snippetDir }), 'snippet-')
  if (!name?.trim()) return
  const path = join(ctx.project.snippetDir, name.trim().replace(/\.md$/i, '') + '.md')
  try {
    await api.createFile(path, '')
  } catch (e) {
    await alertDialog(t('commands.newSnippetTitle'), (e as Error).message)
    return
  }
  await ctx.reloadProject?.()
  ctx.openFile(path)
}
