// Entry point: loads the interface language and the UI preferences/session,
// then starts the application. The language is fixed for the lifetime of the
// page (changing it reloads). The loading overlay (index.html) stays until
// main.ts has opened the project and restored the session.
import { i18n, setMessages, t, type LanguageInfo } from './i18n'
import { hideLoading, loadingError, setLoadingText } from './loading'
import { loadUi } from './session'

interface I18nResponse { setting: string; language: string; languages: LanguageInfo[]; messages: Record<string, string> }

async function loadLanguage() {
  try {
    const res = await fetch('/api/i18n')
    if (res.ok) {
      const data = await res.json() as I18nResponse
      setMessages(data.messages)
      Object.assign(i18n, { setting: data.setting, language: data.language, languages: data.languages })
    }
  } catch { /* server unreachable: English */ }
  document.documentElement.lang = i18n.language
}

const started = performance.now()
try {
  await Promise.all([loadLanguage(), loadUi()])
  setLoadingText(t('loading.starting'))
  const main = await import('./main')
  await main.start()
  hideLoading()
  ;(window as { mdeditorReadyMs?: number }).mdeditorReadyMs = Math.round(performance.now() - started)
} catch (e) {
  console.error(e)
  loadingError(t('loading.failed', { error: (e as Error)?.message ?? String(e) }), t('loading.reload'))
}
