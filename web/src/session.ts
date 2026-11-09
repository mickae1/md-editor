// UI state kept by the server (settings.json): global preferences and the
// session of the current project (open tabs, scroll, expanded tree nodes).
// Not localStorage: the app starts on a new port, hence a new origin, at every launch.

export interface SessionTab { path: string; scroll: number; sel?: [number, number] }

export interface Session {
  tabs: SessionTab[]
  active: string | null
  /** Explorer folder keys that are expanded. */
  explorer: string[]
  /** Table of contents node keys (href) that are expanded. */
  toc: string[]
  tocOrphans?: boolean
  side?: string
  snippetFilter?: string
}

interface UiResponse { prefs: Record<string, string>; session: Session | null; root: string | null }

let prefData: Record<string, string> = {}
let pendingPrefs: Record<string, string | null> = {}
let prefTimer = 0
/** Session of the project open when the page loaded (consumed by main.ts). */
let startSession: { root: string; session: Session } | null = null

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(res.statusText)
}

/** Loads the preferences and the session once, at startup (boot.ts). */
export async function loadUi() {
  try {
    const res = await fetch('/api/ui')
    if (!res.ok) return
    const data = await res.json() as UiResponse
    prefData = { ...data.prefs }
    if (data.root && data.session) startSession = { root: data.root, session: data.session }
    if (!Object.keys(prefData).length) migrateLocalStorage()
  } catch { /* server unreachable: defaults */ }
}

/** One time: preferences saved by earlier versions in localStorage (same origin only). */
function migrateLocalStorage() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k?.startsWith('mdeditor.')) continue
      const key = k.slice('mdeditor.'.length)
      if (key.startsWith('last.') || key === 'explorer.open') continue
      const v = localStorage.getItem(k)
      if (v !== null) prefs.set(key, v)
    }
  } catch { /* storage unavailable */ }
}

/** Global UI preferences: synchronous reads, debounced writes. */
export const prefs = {
  get(key: string, def: string) { return prefData[key] ?? def },
  set(key: string, value: string | null) {
    if (value === null) delete prefData[key]
    else if (prefData[key] === value) return
    else prefData[key] = value
    pendingPrefs[key] = value
    clearTimeout(prefTimer)
    prefTimer = window.setTimeout(flushPrefs, 300)
  },
}

function flushPrefs(beacon = false) {
  clearTimeout(prefTimer)
  if (!Object.keys(pendingPrefs).length) return
  const body = pendingPrefs
  pendingPrefs = {}
  if (beacon) navigator.sendBeacon('/api/ui/prefs', new Blob([JSON.stringify(body)], { type: 'application/json' }))
  else post('/api/ui/prefs', body).catch(() => { pendingPrefs = { ...body, ...pendingPrefs } })
}

/** Returns (once) the session saved for `root`, when that project was open at startup. */
export function takeStartSession(root: string): Session | null {
  const s = startSession?.root === root ? startSession.session : null
  startSession = null
  return s
}

export async function fetchSession(): Promise<Session | null> {
  try {
    const res = await fetch('/api/ui')
    if (!res.ok) return null
    return (await res.json() as UiResponse).session
  } catch { return null }
}

// --------------------------------------------------------------------------
// Session saving
// --------------------------------------------------------------------------
let collect: (() => { root: string; session: Session } | null) | null = null
let sessionTimer = 0
let lastSaved = ''

/** Registers the function that describes the current session (main.ts). */
export function setSessionSource(fn: typeof collect) { collect = fn }

/**
 * Saves the session within a second of a change. Not reset by later changes:
 * the workspace emits changes all the time (dirty checks, file polling).
 */
export function scheduleSessionSave() {
  if (sessionTimer) return
  sessionTimer = window.setTimeout(() => { void saveSession() }, 1000)
}

/** Saves now (before opening another folder: awaited) or with a beacon (page closing). */
export async function saveSession(beacon = false) {
  clearTimeout(sessionTimer)
  sessionTimer = 0
  const data = collect?.()
  if (!data) return
  const json = JSON.stringify(data)
  if (json === lastSaved) return
  lastSaved = json
  if (beacon) { navigator.sendBeacon('/api/ui/session', new Blob([json], { type: 'application/json' })); return }
  try { await post('/api/ui/session', data) } catch { lastSaved = '' }
}

/** Page closing: sends what is pending. */
export function flushUi() {
  flushPrefs(true)
  void saveSession(true)
}
