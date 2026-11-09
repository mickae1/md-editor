// Translations. The reference language file is lang/en.json (bundled, used as
// fallback); other languages are served by the local server (/api/i18n) and
// loaded by boot.ts before the application starts.
import en from '../../lang/en.json'

export type MessageKey = Exclude<keyof typeof en, '@name'>
export type Params = Record<string, string | number>

export interface LanguageInfo { code: string; name: string }

let messages: Record<string, string> = { ...en }

export const i18n = {
  /** Setting saved by the user: a language code or 'auto'. */
  setting: 'auto',
  /** Language actually displayed. */
  language: 'en',
  languages: [{ code: 'en', name: en['@name'] }] as LanguageInfo[],
}

export function setMessages(extra: Record<string, string>) {
  messages = { ...en, ...extra }
}

/**
 * Translated text for `key`, with `{name}` placeholders replaced by `params`.
 * When `params.n === 1` and a `key.one` variant exists, it is used (singular).
 */
export function t(key: MessageKey, params?: Params): string {
  let text = (params?.n === 1 && messages[`${key}.one`]) || messages[key] || key
  if (params) text = text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
  return text
}
