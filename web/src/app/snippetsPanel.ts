// Snippets side panel: list, usage count, hover preview,
// drag and drop into the editor, context menu.
import { api } from '../api'
import { ctx } from '../context'
import { SNIPPET_MIME } from '../editor/create'
import { markdownToHtml } from '../markdown/parser'
import { basename, dirname, isUnder, relative } from '../paths'
import { h } from '../ui/dom'
import { closeModal, modal, popupMenu } from '../ui/dialogs'
import { icon } from '../ui/icons'
import { t } from '../i18n'

export class SnippetsPanel {
  el: HTMLElement
  private list: HTMLElement
  private filter: HTMLInputElement
  private preview: HTMLElement
  private previewTimer = 0
  private sort: 'name' | 'usage' = 'name'

  constructor(private actions: { insert: (path: string) => void; create: () => void; extract: () => void }) {
    this.filter = h('input', { type: 'search', class: 'filter', placeholder: t('snippetsPanel.searchPlaceholder'), oninput: () => this.render() })
    const sortBtn = h('button', {
      class: 'icon-btn', title: t('snippetsPanel.sortTooltip'),
      onclick: () => { this.sort = this.sort === 'name' ? 'usage' : 'name'; sortBtn.classList.toggle('on', this.sort === 'usage'); this.render() },
    }, icon('listOrdered', 14))
    this.list = h('div', { class: 'snippet-list' })
    this.preview = h('div', { class: 'snippet-preview md-typeset', hidden: true })
    this.el = h('div', { class: 'snippets-panel' },
      h('div', { class: 'panel-title' }, icon('puzzle', 14), h('span', null, t('snippetsPanel.title')), h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn', title: t('snippetsPanel.extractTooltip'), onclick: () => actions.extract() }, icon('scissors', 14)),
        h('button', { class: 'icon-btn', title: t('snippetsPanel.newSnippet'), onclick: () => actions.create() }, icon('plus', 14)),
        sortBtn),
      this.filter, this.list)
    document.body.append(this.preview)
  }

  snippets() {
    return (ctx.project?.files ?? []).filter(f => f.kind === 'snippet')
  }

  render() {
    const q = this.filter.value.trim().toLowerCase()
    let items = this.snippets().filter(f => !q || f.path.toLowerCase().includes(q))
    if (this.sort === 'usage') items = items.sort((a, b) => ctx.usageOf(b.path).length - ctx.usageOf(a.path).length)
    const dir = ctx.project?.snippetDir ?? ''
    this.list.replaceChildren(...items.map(f => {
      const n = ctx.usageOf(f.path).length
      const sub = isUnder(f.path, dir) ? dirname(relative(dir, f.path)) : ''
      const row = h('div', {
        class: `snippet-item ${ctx.snippets.isDirty(f.path) ? 'dirty' : ''}`, draggable: 'true', 'data-path': f.path,
        title: t('snippetsPanel.itemTooltip', { path: f.path }),
        ondblclick: () => ctx.openFile(f.path),
        ondragstart: (e: DragEvent) => {
          this.hidePreview()
          e.dataTransfer?.setData(SNIPPET_MIME, ctx.includeSrc(f.path))
          e.dataTransfer?.setData('text/plain', `--8<-- "${ctx.includeSrc(f.path)}"`)
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
        },
        onmouseenter: () => this.schedulePreview(f.path, row),
        onmouseleave: () => this.hidePreview(),
        oncontextmenu: (e: MouseEvent) => { e.preventDefault(); this.menu(e, f.path) },
      },
      icon('puzzle', 13),
      h('span', { class: 'label' }, basename(f.path, '.md'), sub && sub !== '.' ? h('span', { class: 'sub' }, ` ${sub}/`) : null),
      h('span', { class: `usage ${n > 1 ? 'shared' : ''} ${n === 0 ? 'unused' : ''}`, title: t('snippetsPanel.usageTooltip', { n }) }, String(n)))
      return row
    }))
    if (!items.length) this.list.append(h('div', { class: 'empty-hint' }, ctx.project ? t('snippetsPanel.noSnippets') : ''))
  }

  private menu(e: MouseEvent, path: string) {
    popupMenu(e.clientX, e.clientY, [
      { label: t('snippetsPanel.menuInsert'), icon: icon('plus', 14), action: () => this.actions.insert(path), disabled: !ctx.activeEditor },
      { label: t('snippetsPanel.menuOpenTab'), icon: icon('external', 14), action: () => ctx.openFile(path) },
      { label: t('snippetsPanel.menuShowUsage'), icon: icon('tree', 14), action: () => showUsage(path) },
      'sep',
      { label: t('snippetsPanel.menuCopyInclude'), icon: icon('braces', 14), action: () => navigator.clipboard.writeText(`--8<-- "${ctx.includeSrc(path)}"`) },
    ])
  }

  private schedulePreview(path: string, row: HTMLElement) {
    clearTimeout(this.previewTimer)
    this.previewTimer = window.setTimeout(async () => {
      let content: string
      try { content = (await api.readFile(path)).content } catch { return }
      if (!row.matches(':hover')) return
      // Static preview: images resolved from the project root.
      const tmp = h('div')
      tmp.innerHTML = markdownToHtml(content)
      tmp.querySelectorAll('img').forEach(img => { img.src = ctx.imageUrl(img.getAttribute('src') || '', { docPath: 'index.md', ancestors: [] }) })
      tmp.querySelectorAll('[data-snippet]').forEach(el => { el.className = 'preview-snippet'; el.textContent = `--8<-- ${el.getAttribute('data-snippet')}` })
      tmp.querySelectorAll('[data-raw-block]').forEach(el => { el.className = 'preview-raw'; el.textContent = el.getAttribute('data-raw-block') })
      tmp.querySelectorAll('[data-admonition]').forEach(el => el.classList.add('admonition', el.getAttribute('data-admonition') || 'note'))
      this.preview.replaceChildren(h('div', { class: 'preview-title' }, basename(path)), ...tmp.childNodes)
      const r = row.getBoundingClientRect()
      this.preview.hidden = false
      const pr = this.preview.getBoundingClientRect()
      this.preview.style.left = `${Math.max(8, r.left - pr.width - 8)}px`
      this.preview.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - pr.height - 8))}px`
    }, 350)
  }

  hidePreview() {
    clearTimeout(this.previewTimer)
    this.preview.hidden = true
  }
}

export async function showUsage(path: string) {
  const users = ctx.usageOf(path)
  const body = h('div', null,
    h('p', null, users.length ? t('snippetsPanel.usageIncludedIn', { name: basename(path, '.md'), n: users.length }) : t('snippetsPanel.usageNone', { name: basename(path, '.md') })),
    h('ul', { class: 'file-list clickable' }, ...users.map(u => h('li', {
      onclick: () => { closeModal(); ctx.openFile(u) },
    }, icon(isUnder(u, ctx.project?.snippetDir ?? '') ? 'puzzle' : 'file', 13), u))))
  await modal(t('snippetsPanel.usageTitle'), body, [{ label: t('snippetsPanel.close'), value: 'ok', primary: true }])
}
