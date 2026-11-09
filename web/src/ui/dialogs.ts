// Modal dialogs.
import { h } from './dom'
import { t } from '../i18n'

export interface ModalButton { label: string; value: string; primary?: boolean; danger?: boolean }

export function modal(title: string, body: HTMLElement, buttons: ModalButton[], opts: { wide?: boolean; onOpen?: () => void } = {}): Promise<string | null> {
  return new Promise(resolve => {
    const prevFocus = document.activeElement as HTMLElement | null
    const close = (value: string | null) => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      prevFocus?.focus?.()
      resolve(value)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null) }
      if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const primary = buttons.find(b => b.primary)
        if (primary && !(e.target as HTMLElement).closest('.no-enter')) { e.preventDefault(); close(primary.value) }
      }
    }
    const footer = h('div', { class: 'modal-footer' },
      ...buttons.map(b => h('button', {
        class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
        onclick: () => close(b.value),
      }, b.label)))
    const box = h('div', { class: `modal ${opts.wide ? 'wide' : ''}`, role: 'dialog' },
      h('div', { class: 'modal-title' }, title), h('div', { class: 'modal-body' }, body), footer)
    const overlay = h('div', { class: 'modal-overlay', onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(null) } }, box)
    document.body.append(overlay)
    document.addEventListener('keydown', onKey, true)
    requestAnimationFrame(() => {
      const first = box.querySelector<HTMLElement>('input, textarea, select') ?? footer.querySelector<HTMLElement>('.primary')
      first?.focus()
      if (first instanceof HTMLInputElement) first.select()
      opts.onOpen?.()
    })
  })
}

/** Closes the open dialog (same as Escape). */
export function closeModal() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

export async function confirmDialog(title: string, message: string, ok = t('dialogs.ok'), danger = false): Promise<boolean> {
  const body = h('div', { class: 'pre-wrap' }, message)
  return (await modal(title, body, [{ label: t('dialogs.cancel'), value: 'cancel' }, { label: ok, value: 'ok', primary: true, danger }])) === 'ok'
}

export async function choiceDialog(title: string, message: string | HTMLElement, buttons: ModalButton[]): Promise<string | null> {
  const body = typeof message === 'string' ? h('div', { class: 'pre-wrap' }, message) : message
  return modal(title, body, buttons)
}

export function alertDialog(title: string, message: string): Promise<unknown> {
  return modal(title, h('div', { class: 'pre-wrap' }, message), [{ label: t('dialogs.ok'), value: 'ok', primary: true }])
}

export async function promptDialog(title: string, label: string, value = '', opts: { datalist?: string[]; hint?: string } = {}): Promise<string | null> {
  const listId = `dl-${Math.random().toString(36).slice(2)}`
  const input = h('input', { type: 'text', value, list: opts.datalist ? listId : undefined })
  const body = h('div', { class: 'form' },
    h('label', null, label, input),
    opts.hint ? h('div', { class: 'hint' }, opts.hint) : null,
    opts.datalist ? h('datalist', { id: listId }, ...opts.datalist.map(v => h('option', { value: v }))) : null)
  const r = await modal(title, body, [{ label: t('dialogs.cancel'), value: 'cancel' }, { label: t('dialogs.ok'), value: 'ok', primary: true }])
  return r === 'ok' ? input.value : null
}

export interface ImageAttrs { src: string; alt: string; width: string | null; height: string | null; title?: string | null }

export async function imageDialog(attrs: ImageAttrs & { naturalWidth?: number; naturalHeight?: number }): Promise<ImageAttrs | null> {
  const src = h('input', { type: 'text', value: attrs.src })
  const alt = h('input', { type: 'text', value: attrs.alt ?? '' })
  const title = h('input', { type: 'text', value: attrs.title ?? '' })
  const width = h('input', { type: 'number', min: '1', value: attrs.width ?? '' })
  const height = h('input', { type: 'number', min: '1', value: attrs.height ?? '' })
  const keep = h('input', { type: 'checkbox', checked: true })
  const ratio = () => {
    const w = Number(attrs.width), hh = Number(attrs.height)
    if (w && hh) return hh / w
    if (attrs.naturalWidth && attrs.naturalHeight) return attrs.naturalHeight / attrs.naturalWidth
    return 0
  }
  width.addEventListener('input', () => { if (keep.checked && ratio()) height.value = String(Math.round(Number(width.value) * ratio())) })
  height.addEventListener('input', () => { if (keep.checked && ratio()) width.value = String(Math.round(Number(height.value) / ratio())) })
  const natural = attrs.naturalWidth
    ? h('button', {
      class: 'btn small', type: 'button',
      onclick: () => { width.value = String(attrs.naturalWidth); height.value = String(attrs.naturalHeight) },
    }, t('dialogs.imageOriginalSize', { width: attrs.naturalWidth, height: String(attrs.naturalHeight) }))
    : null
  const body = h('div', { class: 'form' },
    h('label', null, t('dialogs.imageSrc'), src),
    h('label', null, t('dialogs.imageAlt'), alt),
    h('label', null, t('dialogs.imageTitle'), title),
    h('div', { class: 'row' }, h('label', null, t('dialogs.width'), width), h('label', null, t('dialogs.height'), height)),
    h('label', { class: 'check' }, keep, t('dialogs.keepRatio')),
    natural)
  const r = await modal(t('dialogs.image'), body, [{ label: t('dialogs.cancel'), value: 'cancel' }, { label: t('dialogs.ok'), value: 'ok', primary: true }])
  if (r !== 'ok') return null
  return { src: src.value.trim(), alt: alt.value, width: width.value || null, height: height.value || null, title: title.value || null }
}

export async function linkDialog(init: { text: string; href: string; showText: boolean }, topics: string[]): Promise<{ text: string; href: string } | 'remove' | null> {
  const listId = 'dl-topics'
  const text = h('input', { type: 'text', value: init.text })
  const href = h('input', { type: 'text', value: init.href, list: listId, placeholder: t('dialogs.linkPlaceholder') })
  const body = h('div', { class: 'form' },
    init.showText ? h('label', null, t('dialogs.linkText'), text) : null,
    h('label', null, t('dialogs.linkTarget'), href),
    h('div', { class: 'hint' }, t('dialogs.linkHint')),
    h('datalist', { id: listId }, ...topics.map(topic => h('option', { value: topic }))))
  const buttons: ModalButton[] = [{ label: t('dialogs.cancel'), value: 'cancel' }]
  if (init.href) buttons.push({ label: t('dialogs.removeLink'), value: 'remove', danger: true })
  buttons.push({ label: t('dialogs.ok'), value: 'ok', primary: true })
  const r = await modal(t('dialogs.link'), body, buttons, { onOpen: () => (init.showText && !init.text ? text : href).focus() })
  if (r === 'remove') return 'remove'
  if (r !== 'ok' || !href.value.trim()) return null
  return { text: text.value || href.value, href: href.value.trim() }
}

/** Small floating menu (context or drop-down menu). */
export function popupMenu(x: number, y: number, items: ({ label: string; action: () => void; icon?: Node; disabled?: boolean } | 'sep')[]) {
  document.querySelector('.popup-menu')?.remove()
  const menu = h('div', { class: 'popup-menu' },
    ...items.map(it => it === 'sep'
      ? h('div', { class: 'sep' })
      : h('button', {
        class: 'menu-item', disabled: it.disabled,
        onclick: () => { menu.remove(); it.action() },
      }, it.icon ?? null, it.label)))
  // Do not steal the focus from the editor: the command applies to its selection.
  menu.addEventListener('mousedown', e => e.preventDefault())
  document.body.append(menu)
  const r = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`
  const close = (e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== 'Escape') return
    if (e.type === 'mousedown' && menu.contains(e.target as Node)) return
    menu.remove()
    document.removeEventListener('mousedown', close, true)
    document.removeEventListener('keydown', close, true)
  }
  setTimeout(() => {
    document.addEventListener('mousedown', close, true)
    document.addEventListener('keydown', close, true)
  })
  return menu
}

let toastBox: HTMLElement | null = null
export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info', ms = 3500) {
  if (!toastBox) { toastBox = h('div', { class: 'toasts' }); document.body.append(toastBox) }
  const el = h('div', { class: `toast ${kind}` }, message)
  toastBox.append(el)
  setTimeout(() => el.remove(), ms)
}
