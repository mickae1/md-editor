// Deleting a .md file: confirmation, with the list of what still points to it
// (links, snippet inclusions, table of contents entries).
import { api, type References } from '../api'
import { ctx } from '../context'
import { h } from '../ui/dom'
import { closeModal, confirmDialog, modal, toast } from '../ui/dialogs'
import { icon, type IconName } from '../ui/icons'
import { t } from '../i18n'

export type ApiError = Error & { status?: number; data?: { code?: string; references?: References } }

const noRefs = (path: string): References => ({ path, links: [], includes: [], toc: [], count: 0 })

/** References of a file (none if the server cannot tell). */
export async function fetchReferences(path: string): Promise<References> {
  try { return await api.references(path) } catch { return noRefs(path) }
}

/** Lists what still points to `path`; true = delete anyway. `intro` is shown first. */
export async function referencesDialog(path: string, refs: References, intro?: string): Promise<boolean> {
  let target: string | null = null
  const item = (name: IconName, label: string, file: string, line?: number, text?: string) => h('li', {
    class: 'ref-item', title: t('deleteFile.openTooltip', { file }),
    onclick: () => { target = file; closeModal() },
  }, icon(name, 13), h('span', { class: 'ref-file' }, label), line ? h('span', { class: 'line' }, `:${line}`) : null,
  text ? h('span', { class: 'ref-text' }, text.trim()) : null)
  const section = (title: string, items: HTMLElement[]) => items.length
    ? [h('div', { class: 'ref-section' }, `${title} (${items.length})`), h('ul', { class: 'ref-list' }, ...items)]
    : []
  const body = h('div', { class: 'refs-dialog' },
    intro ? h('p', { class: 'pre-wrap' }, intro) : null,
    h('p', null, t('deleteFile.refCount', { n: refs.count })),
    h('div', { class: 'ref-scroll' },
      ...section(t('deleteFile.links'), refs.links.map(r => item('link', r.file.replace(/\.md$/i, ''), r.file, r.line, r.text))),
      ...section(t('deleteFile.includes'), refs.includes.map(r => item('puzzle', r.file.replace(/\.md$/i, ''), r.file, r.line, r.text))),
      ...section(t('deleteFile.toc'), refs.toc.map(r => item('tree', r.caption, path)))))
  const r = await modal(t('deleteFile.refTitle', { file: path }), body, [
    { label: t('dialogs.cancel'), value: 'cancel', primary: true },
    { label: t('deleteFile.deleteAnyway'), value: 'delete', danger: true },
  ], { wide: true })
  if (target) ctx.openFile(target)
  return r === 'delete'
}

/**
 * Confirmation before deleting `path`: the list of references if anything
 * points to it, else a plain danger confirmation. Null = cancelled.
 */
export async function confirmDelete(path: string, opts: { refs?: References; message?: string } = {}): Promise<{ force: boolean } | null> {
  const refs = opts.refs ?? await fetchReferences(path)
  if (refs.count > 0) return (await referencesDialog(path, refs, opts.message)) ? { force: true } : null
  const ok = await confirmDialog(t('deleteFile.title'), opts.message ?? t('deleteFile.message', { file: path }), t('deleteFile.delete'), true)
  return ok ? { force: false } : null
}

/** Deletes a file after confirmation; closes its tab first, then reloads the project. */
export async function deleteFileFlow(path: string, closeFile: (path: string) => Promise<boolean>): Promise<boolean> {
  const c = await confirmDelete(path)
  if (!c || !(await closeFile(path))) return false
  let force = c.force
  for (;;) {
    try {
      await api.deleteFile(path, force)
      break
    } catch (e) {
      const err = e as ApiError
      // Referenced since the confirmation (race): show the list again.
      if (!force && err.status === 409 && err.data?.code === 'referenced' && err.data.references) {
        if (!(await referencesDialog(path, err.data.references))) return false
        force = true
        continue
      }
      toast(err.message, 'error', 6000)
      return false
    }
  }
  toast(t('deleteFile.deleted', { file: path }), 'success')
  await ctx.reloadProject?.()
  return true
}
