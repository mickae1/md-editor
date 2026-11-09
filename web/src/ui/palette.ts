// Quick search palette (open a topic, insert a snippet...).
import { h } from './dom'
import { t } from '../i18n'

export interface PaletteItem { label: string; detail?: string; value: string; badge?: string }

export function palette(opts: {
  title: string
  placeholder: string
  items: PaletteItem[]
  preview?: (item: PaletteItem, el: HTMLElement) => void
}): Promise<PaletteItem | null> {
  return new Promise(resolve => {
    let selected = 0
    let filtered: PaletteItem[] = []
    const input = h('input', { type: 'search', class: 'palette-input', placeholder: opts.placeholder })
    const list = h('div', { class: 'palette-list' })
    const preview = opts.preview ? h('div', { class: 'palette-preview md-typeset' }) : null
    const box = h('div', { class: `palette ${preview ? 'with-preview' : ''}` },
      h('div', { class: 'palette-title' }, opts.title), input,
      h('div', { class: 'palette-main' }, list, preview))
    const overlay = h('div', { class: 'modal-overlay top', onmousedown: (e: MouseEvent) => { if (e.target === overlay) done(null) } }, box)

    const done = (item: PaletteItem | null) => {
      overlay.remove()
      resolve(item)
    }
    let previewTimer = 0
    const render = () => {
      const words = input.value.toLowerCase().split(/\s+/).filter(Boolean)
      filtered = opts.items.filter(it => {
        const hay = `${it.label} ${it.detail ?? ''}`.toLowerCase()
        return words.every(w => hay.includes(w))
      }).slice(0, 300)
      selected = Math.min(selected, Math.max(0, filtered.length - 1))
      list.replaceChildren(...filtered.map((it, i) => h('div', {
        class: `palette-item ${i === selected ? 'selected' : ''}`,
        onmousedown: (e: MouseEvent) => { e.preventDefault(); done(it) },
        onmousemove: () => { if (selected !== i) { selected = i; highlight() } },
      }, h('span', { class: 'label' }, it.label), it.badge ? h('span', { class: 'badge' }, it.badge) : null,
      it.detail ? h('span', { class: 'detail' }, it.detail) : null)))
      if (!filtered.length) list.append(h('div', { class: 'empty-hint' }, t('palette.noResults')))
      updatePreview()
    }
    const highlight = () => {
      list.querySelectorAll('.palette-item').forEach((el, i) => el.classList.toggle('selected', i === selected))
      list.children[selected]?.scrollIntoView({ block: 'nearest' })
      updatePreview()
    }
    const updatePreview = () => {
      if (!preview || !opts.preview) return
      clearTimeout(previewTimer)
      const it = filtered[selected]
      if (!it) { preview.replaceChildren(); return }
      previewTimer = window.setTimeout(() => opts.preview!(it, preview), 80)
    }
    input.addEventListener('input', () => { selected = 0; render() })
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(filtered.length - 1, selected + 1); highlight() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, selected - 1); highlight() }
      else if (e.key === 'Enter') { e.preventDefault(); if (filtered[selected]) done(filtered[selected]) }
      else if (e.key === 'Escape') { e.preventDefault(); done(null) }
    })
    document.body.append(overlay)
    render()
    input.focus()
  })
}
