// Resizable side panels: a handle on the inner edge of the panel. Drag to
// resize, double-click to reset, arrow keys when focused. The width is saved.
import { t } from '../i18n'
import { h } from '../ui/dom'

const MIN = 200
const MAX = 640
const STEP = 16
/** Width always left to the editor. */
const EDITOR_MIN = 360

interface Store { get(key: string, def: string): string; set(key: string, value: string): void }

export function makeResizable(panel: HTMLElement, side: 'left' | 'right', defaultWidth: number, store: Store) {
  const key = `panel.${side}.width`
  const handle = h('div', {
    class: `panel-resizer ${side}`,
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    'aria-valuemin': String(MIN),
    'aria-valuemax': String(MAX),
    title: t('main.resizePanel'),
  })
  panel.append(handle)

  // Widest the panel can be without squeezing the editor below EDITOR_MIN.
  const max = () => {
    const other = [...(panel.parentElement?.children ?? [])]
      .filter((el): el is HTMLElement => el !== panel && el instanceof HTMLElement && el.classList.contains('side') && !el.hidden)
      .reduce((w, el) => w + el.getBoundingClientRect().width, 0)
    return Math.max(MIN, Math.min(MAX, window.innerWidth - other - EDITOR_MIN))
  }
  const apply = (width: number, save = true) => {
    const w = Math.round(Math.min(max(), Math.max(MIN, width)))
    panel.style.width = `${w}px`
    handle.setAttribute('aria-valuenow', String(w))
    if (save) store.set(key, String(w))
    return w
  }
  const current = () => panel.getBoundingClientRect().width

  apply(Number(store.get(key, String(defaultWidth))) || defaultWidth, false)

  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = current()
    document.body.classList.add('resizing-panel')
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      apply(side === 'left' ? startW + dx : startW - dx, false)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing-panel')
      apply(current())
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  })
  handle.addEventListener('dblclick', () => apply(defaultWidth))
  handle.addEventListener('keydown', e => {
    // Arrow towards the editor widens the panel.
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft'
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight'
    if (e.key === grow) apply(current() + STEP)
    else if (e.key === shrink) apply(current() - STEP)
    else if (e.key === 'Home') apply(MIN)
    else if (e.key === 'End') apply(max())
    else return
    e.preventDefault()
  })
  // Keep the editor usable when the window gets smaller.
  window.addEventListener('resize', () => { if (!panel.hidden && current() > max()) apply(max(), false) })
}
