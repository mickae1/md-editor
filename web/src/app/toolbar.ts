// Formatting toolbar (acts on the active editor: topic or snippet).
import type { Editor } from '@tiptap/core'
import { ctx } from '../context'
import { h } from '../ui/dom'
import { popupMenu } from '../ui/dialogs'
import { ADMONITION_TYPES, icon, type IconName } from '../ui/icons'
import * as cmd from './commands'
import { t } from '../i18n'

type Btn = { el: HTMLButtonElement; active?: (e: Editor) => boolean; enabled?: (e: Editor) => boolean }

export class Toolbar {
  el: HTMLElement
  private tableBar: HTMLElement
  private buttons: Btn[] = []
  private blockSelect: HTMLSelectElement
  private pending = false

  constructor(private extra: { showDiff: () => void; showSource: () => void }) {
    const e = () => ctx.activeEditor
    const btn = (name: IconName, title: string, run: () => void, active?: Btn['active'], enabled?: Btn['enabled']) => {
      const el = h('button', {
        class: 'tb-btn', title,
        onmousedown: (ev: MouseEvent) => ev.preventDefault(), // keep the editor selection
        onclick: () => run(),
      }, icon(name, 16))
      this.buttons.push({ el, active, enabled })
      return el
    }
    const sep = () => h('span', { class: 'tb-sep' })

    this.blockSelect = h('select', {
      class: 'tb-select', title: t('toolbar.paragraphStyle'),
      onchange: () => {
        const v = this.blockSelect.value
        const c = e()?.chain().focus()
        if (!c) return
        if (v === 'p') c.setParagraph().run()
        else c.setHeading({ level: Number(v) as 1 | 2 | 3 | 4 }).run()
      },
    },
    h('option', { value: 'p' }, t('toolbar.paragraph')),
    h('option', { value: '1' }, t('toolbar.heading', { level: 1 })),
    h('option', { value: '2' }, t('toolbar.heading', { level: 2 })),
    h('option', { value: '3' }, t('toolbar.heading', { level: 3 })),
    h('option', { value: '4' }, t('toolbar.heading', { level: 4 })),
    h('option', { value: 'x', hidden: true }, '—'))

    const menuBtn = (name: IconName, title: string, items: () => Parameters<typeof popupMenu>[2]) => {
      const el = btn(name, title, () => {
        const r = el.getBoundingClientRect()
        popupMenu(r.left, r.bottom + 4, items())
      })
      return el
    }

    const admonitionMenu = (mode: string) => () => ADMONITION_TYPES.map(a => ({
      label: a.label, icon: icon(a.icon, 14), action: () => cmd.insertAdmonition(a.kind, mode),
    }))

    const tablePicker = btn('table', t('toolbar.insertTable'), () => this.showTablePicker(tablePicker))

    this.tableBar = h('div', { class: 'tb-group table-tools', hidden: true },
      h('span', { class: 'tb-label' }, t('toolbar.table')),
      this.textBtn(t('toolbar.addRow'), t('toolbar.addRowTooltip'), () => e()?.chain().focus().addRowAfter().run()),
      this.textBtn(t('toolbar.addColumn'), t('toolbar.addColumnTooltip'), () => e()?.chain().focus().addColumnAfter().run()),
      this.textBtn(t('toolbar.deleteRow'), t('toolbar.deleteRowTooltip'), () => e()?.chain().focus().deleteRow().run()),
      this.textBtn(t('toolbar.deleteColumn'), t('toolbar.deleteColumnTooltip'), () => e()?.chain().focus().deleteColumn().run()),
      this.textBtn(t('toolbar.alignLeft'), t('toolbar.alignLeftTooltip'), () => cmd.setColumnAlign('left')),
      this.textBtn(t('toolbar.alignCenter'), t('toolbar.alignCenterTooltip'), () => cmd.setColumnAlign('center')),
      this.textBtn(t('toolbar.alignRight'), t('toolbar.alignRightTooltip'), () => cmd.setColumnAlign('right')),
      this.textBtn(t('toolbar.deleteTable'), t('toolbar.deleteTableTooltip'), () => e()?.chain().focus().deleteTable().run()))

    const has = (ed: Editor, type: string) => !!ed.schema.nodes[type]

    this.el = h('div', { class: 'toolbar' },
      h('div', { class: 'tb-group' },
        btn('undo', t('toolbar.undo'), () => e()?.chain().focus().undo().run(), undefined, ed => ed.can().undo()),
        btn('redo', t('toolbar.redo'), () => e()?.chain().focus().redo().run(), undefined, ed => ed.can().redo()),
        sep(),
        this.blockSelect,
        sep(),
        btn('bold', t('toolbar.bold'), () => e()?.chain().focus().toggleBold().run(), ed => ed.isActive('bold')),
        btn('italic', t('toolbar.italic'), () => e()?.chain().focus().toggleItalic().run(), ed => ed.isActive('italic')),
        btn('code', t('toolbar.inlineCode'), () => e()?.chain().focus().toggleCode().run(), ed => ed.isActive('code')),
        sep(),
        btn('list', t('toolbar.bulletList'), () => e()?.chain().focus().toggleBulletList().run(), ed => ed.isActive('bulletList')),
        btn('listOrdered', t('toolbar.orderedList'), () => e()?.chain().focus().toggleOrderedList().run(), ed => ed.isActive('orderedList')),
        btn('outdent', t('toolbar.outdent'), () => e()?.chain().focus().liftListItem('listItem').run(), undefined, ed => ed.can().liftListItem('listItem')),
        btn('indent', t('toolbar.indent'), () => e()?.chain().focus().sinkListItem('listItem').run(), undefined, ed => ed.can().sinkListItem('listItem')),
        sep(),
        btn('link', t('toolbar.link'), () => cmd.editLink(), ed => ed.isActive('link')),
        btn('anchor', t('toolbar.anchor'), () => cmd.insertAnchor()),
        btn('image', t('toolbar.image'), () => cmd.insertImage()),
        tablePicker,
        sep(),
        btn('codeBlock', t('toolbar.codeBlock'), () => e()?.chain().focus().toggleCodeBlock().run(), ed => ed.isActive('codeBlock')),
        menuBtn('info', t('toolbar.admonition'), admonitionMenu('!!!')),
        menuBtn('details', t('toolbar.collapsible'), admonitionMenu('???')),
        btn('tabs', t('toolbar.tabs'), () => cmd.insertTabs(), undefined, ed => has(ed, 'tabset')),
        btn('hr', t('toolbar.horizontalRule'), () => e()?.chain().focus().setHorizontalRule().run()),
        btn('raw', t('toolbar.rawHtml'), () => cmd.insertRawHtml()),
        sep(),
        btn('puzzle', t('toolbar.insertSnippet'), () => cmd.pickAndInsertSnippet()),
        btn('scissors', t('toolbar.extractSnippet'), () => cmd.extractSnippet())),
      this.tableBar,
      h('span', { class: 'spacer' }),
      h('div', { class: 'tb-group' },
        btn('diff', t('toolbar.showDiff'), () => this.extra.showDiff()),
        btn('braces', t('toolbar.showSource'), () => this.extra.showSource())))
  }

  private textBtn(label: string, title: string, run: () => void) {
    return h('button', { class: 'tb-text', title, onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: run }, label)
  }

  private showTablePicker(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect()
    const size = h('div', { class: 'grid-size' }, t('toolbar.tableSize'))
    const cells: HTMLElement[] = []
    const grid = h('div', { class: 'grid-picker' })
    for (let row = 1; row <= 8; row++) {
      for (let col = 1; col <= 8; col++) {
        const c = h('div', {
          class: 'grid-cell',
          onmouseenter: () => {
            size.textContent = t('toolbar.tableSizeValue', { rows: row, cols: col })
            cells.forEach(x => x.classList.toggle('on', Number(x.dataset.r) <= row && Number(x.dataset.c) <= col))
          },
          onclick: () => { menu.remove(); cmd.insertTable(row, col) },
        })
        c.dataset.r = String(row)
        c.dataset.c = String(col)
        cells.push(c)
        grid.append(c)
      }
    }
    const menu = popupMenu(r.left, r.bottom + 4, [])
    menu.append(grid, size)
  }

  /** Updates the button states (at most once per frame). */
  update() {
    if (this.pending) return
    this.pending = true
    requestAnimationFrame(() => {
      this.pending = false
      const ed = ctx.activeEditor
      this.el.classList.toggle('disabled', !ed || ed.isDestroyed)
      if (!ed || ed.isDestroyed) return
      for (const b of this.buttons) {
        b.el.classList.toggle('on', !!b.active?.(ed))
        b.el.disabled = b.enabled ? !b.enabled(ed) : false
      }
      const level = [1, 2, 3, 4].find(l => ed.isActive('heading', { level: l }))
      this.blockSelect.value = level ? String(level) : ed.isActive('paragraph') ? 'p' : 'x'
      this.tableBar.hidden = !ed.isActive('table')
    })
  }
}
