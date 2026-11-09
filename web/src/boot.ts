// Entry point: loads the interface language, then starts the application.
// The language is fixed for the lifetime of the page (changing it reloads).
import { i18n, setMessages, type LanguageInfo } from './i18n'

interface I18nResponse { setting: string; language: string; languages: LanguageInfo[]; messages: Record<string, string> }

try {
  const res = await fetch('/api/i18n')
  if (res.ok) {
    const data = await res.json() as I18nResponse
    setMessages(data.messages)
    Object.assign(i18n, { setting: data.setting, language: data.language, languages: data.languages })
  }
} catch { /* server unreachable: English */ }
document.documentElement.lang = i18n.language

await import('./main')
