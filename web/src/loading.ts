// Loading overlay: covers the window (index.html shows it before any script
// runs) until the application is usable, and while a folder is being opened.

function overlay(): HTMLElement {
  let el = document.getElementById('loading')
  if (!el) {
    // Rebuilt with the same markup as index.html once the startup one is gone.
    el = document.createElement('div')
    el.id = 'loading'
    el.innerHTML = '<div class="loading-box"><div class="loading-name">mdEditor</div><div class="loading-spinner"></div><div class="loading-text"></div></div>'
    document.body.append(el)
  }
  return el
}

let hideTimer = 0
let depth = document.getElementById('loading') ? 1 : 0 // the startup overlay of index.html

/** Shows the overlay with an optional message (already translated). Pair with hideLoading(). */
export function showLoading(text = '') {
  clearTimeout(hideTimer)
  depth++
  const el = overlay()
  el.classList.remove('hiding', 'failed')
  el.querySelector('.loading-error')?.remove()
  setLoadingText(text)
}

export function setLoadingText(text: string) {
  const t = overlay().querySelector('.loading-text')
  if (t) t.textContent = text
}

/** Fades the overlay out once the last pending showLoading() is done. */
export function hideLoading() {
  depth = Math.max(0, depth - 1)
  if (depth) return
  const el = document.getElementById('loading')
  if (!el) return
  el.classList.add('hiding')
  hideTimer = window.setTimeout(() => el.remove(), 160)
}

/** Startup failed: replaces the spinner with the error and a Reload button. */
export function loadingError(message: string, reloadLabel: string) {
  clearTimeout(hideTimer)
  const el = overlay()
  el.classList.remove('hiding')
  el.classList.add('failed')
  setLoadingText('')
  el.querySelector('.loading-error')?.remove()
  const box = el.querySelector('.loading-box')
  const err = document.createElement('div')
  err.className = 'loading-error'
  const msg = document.createElement('p')
  msg.textContent = message
  const btn = document.createElement('button')
  btn.className = 'btn primary'
  btn.textContent = reloadLabel
  btn.onclick = () => location.reload()
  err.append(msg, btn)
  box?.append(err)
}
