// Access to the local server (server/app.py).
import type { ProjectInfo, TocEdit, TocState } from './context'
import { confirmDialog } from './ui/dialogs'
import { t } from './i18n'

async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data })
  return data as T
}

export interface FileData { path: string; content: string; mtime: number }
export interface Reference { file: string; line: number; text: string }
export interface References {
  path: string
  links: Reference[]
  includes: Reference[]
  toc: { id: string; caption: string }[]
  count: number
}
export interface SearchHit { file: string; line: number; text: string }

export const api = {
  state: () => call<{ project: ProjectInfo | null; recent: string[]; mkdocsAvailable: boolean }>('GET', '/api/state'),
  project: () => call<ProjectInfo>('GET', '/api/project'),
  pickFolder: (title: string, initial?: string) => call<{ path: string | null }>('POST', '/api/dialog/folder', { title, initial }),
  openProject: (path: string) => call<ProjectInfo>('POST', '/api/project/open', { path }),
  closeProject: () => call('POST', '/api/project/close'),
  projectSettings: (s: { snippetDir?: string; basePath?: string; tocFile?: string }) => call<ProjectInfo>('POST', '/api/project/settings', s),
  readFile: (path: string) => call<FileData>('GET', `/api/file?path=${encodeURIComponent(path)}`),
  stat: (paths: string[]) => call<Record<string, number | null>>('POST', '/api/stat', { paths }),
  search: (q: string, regex: boolean, cs: boolean) =>
    call<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}&regex=${regex ? 1 : 0}&case=${cs ? 1 : 0}`),
  replace: (query: string, replacement: string, files: string[], regex: boolean, cs: boolean) =>
    call<{ changed: { file: string; count: number }[] }>('POST', '/api/replace', { query, replacement, files, regex, case: cs }),
  mkdocsServe: () => call<{ url: string }>('POST', '/api/mkdocs/serve'),
  /** Everything that points to a file (links, snippet inclusions, table of contents entries). */
  references: (path: string) => call<References>('GET', `/api/references?path=${encodeURIComponent(path)}`),
  /**
   * Deletes a .md file of the project. Without `force`, fails with 409
   * `data.code === 'referenced'` and `data.references` if something still points to it.
   */
  deleteFile: (path: string, force = false) => call<{ deleted: string }>('POST', '/api/file/delete', { path, force }),
  toc: () => call<TocState>('GET', '/api/toc'),
  /**
   * Applies one edit (the file is saved at once). 409 code "conflict" / "exists";
   * op "delete" without `force`: 409 "referenced" with `data.references` (other pages still link to it).
   */
  tocEdit: (edit: TocEdit, mtime: number | null, force = false) =>
    call<{ toc: TocState; created: string | null; deleted: string | null }>('POST', '/api/toc/edit', { ...edit, mtime, force }),
  pickFile: (title: string, initial?: string, types: [string, string][] = []) =>
    call<{ path: string | null }>('POST', '/api/dialog/file', { title, initial, types }),
  setLanguage: (language: string) => call('POST', '/api/settings/language', { language }),
  openLanguageFolder: () => call<{ path: string }>('POST', '/api/lang/folder'),
  uploadImage: (name: string, data: string) => call<{ path: string }>('POST', '/api/image', { name, data }),

  /** Creates a new file (fails if it already exists). */
  createFile: (path: string, content: string) => call<FileData>('POST', '/api/file', { path, content, create: true }),

  /**
   * Writes a file. If the file changed on disk since `mtime`, asks for
   * confirmation; returns 'conflict' if the user cancels.
   */
  async writeFile(path: string, content: string, mtime: number | null, force = false): Promise<FileData | 'conflict'> {
    try {
      return await call<FileData>('POST', '/api/file', { path, content, mtime, force })
    } catch (e) {
      const err = e as { status?: number; data?: { code?: string } }
      if (err.status === 409 && err.data?.code === 'conflict') {
        const ok = await confirmDialog(t('api.conflictTitle'), t('api.conflictMessage', { path }), t('api.overwrite'), true)
        if (!ok) return 'conflict'
        return call<FileData>('POST', '/api/file', { path, content, force: true })
      }
      throw e
    }
  },
}

export function rawUrl(path: string) {
  return `/raw?path=${encodeURIComponent(path)}`
}
