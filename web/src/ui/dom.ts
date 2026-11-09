type Child = Node | string | null | undefined | false
type Props = Record<string, unknown> & { class?: string; style?: string; dataset?: Record<string, string> }

/** Concise DOM element creation: h('div', { class: 'x', onclick }, children...) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'class') el.className = String(value)
      else if (key === 'style') el.setAttribute('style', String(value))
      else if (key === 'dataset') Object.assign(el.dataset, value)
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener)
      else if (key in el && typeof value !== 'string') (el as unknown as Record<string, unknown>)[key] = value
      else el.setAttribute(key, value === true ? '' : String(value))
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    el.append(c)
  }
  return el
}

export function clear(el: Element) {
  while (el.firstChild) el.firstChild.remove()
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let t: number | undefined
  return ((...args: never[]) => {
    clearTimeout(t)
    t = window.setTimeout(() => fn(...args), ms)
  }) as T
}
