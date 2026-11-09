// Export the project as a website (one .html per .md, contents page) or a PDF.
// The build runs MkDocs on the server (server/export.py) and can take a while.
import { api, type ExportResult } from '../api'
import { ctx } from '../context'
import { t } from '../i18n'
import { hideLoading, showLoading } from '../loading'
import { h } from '../ui/dom'
import { alertDialog, modal, toast } from '../ui/dialogs'

export type ExportKind = 'site' | 'pdf'

export async function exportProject(kind: ExportKind) {
  if (!ctx.project) return
  let info: Awaited<ReturnType<typeof api.exportInfo>>
  try { info = await api.exportInfo() } catch (e) { toast((e as Error).message, 'error'); return }
  if (!info.mkdocs) { await alertDialog(t('export.title'), t('export.noMkdocs')); return }
  if (kind === 'pdf' && !info.browser) { await alertDialog(t('export.title'), t('export.noBrowser')); return }

  const target = h('input', { type: 'text', value: (kind === 'site' ? info.out : info.pdf) ?? '' })
  const browse = h('button', {
    class: 'btn small', type: 'button',
    onclick: async () => {
      const r = kind === 'site'
        ? await api.pickFolder(t('export.chooseFolder'), target.value || undefined)
        : await api.pickSaveFile(t('export.choosePdf'), target.value || undefined, [['PDF', '*.pdf']], '.pdf')
      if (r.path) target.value = r.path
    },
  }, t('export.browse'))
  const useToc = h('input', { type: 'checkbox', checked: info.hasToc, disabled: !info.hasToc })
  const body = h('div', { class: 'form' },
    h('p', { class: 'hint' }, kind === 'site' ? t('export.siteIntro') : t('export.pdfIntro')),
    h('label', null, kind === 'site' ? t('export.folder') : t('export.file'), h('div', { class: 'row' }, target, browse)),
    h('label', { class: 'check' }, useToc, info.hasToc ? t('export.useToc') : t('export.noToc')),
    h('p', { class: 'hint' }, t('export.mkdocsHint')))
  const r = await modal(kind === 'site' ? t('export.siteTitle') : t('export.pdfTitle'), body, [
    { label: t('dialogs.cancel'), value: 'cancel' },
    { label: t('export.run'), value: 'ok', primary: true },
  ], { wide: true })
  if (r !== 'ok' || !target.value.trim()) return

  showLoading(kind === 'site' ? t('export.buildingSite') : t('export.buildingPdf'))
  let result: ExportResult | null = null
  let error = ''
  try {
    result = kind === 'site' ? await api.exportSite(target.value.trim(), useToc.checked) : await api.exportPdf(target.value.trim(), useToc.checked)
  } catch (e) {
    error = (e as Error).message
  }
  hideLoading()
  if (result) await showResult(kind, result)
  else await alertDialog(t('export.failedTitle'), error)
}

async function showResult(kind: ExportKind, r: ExportResult) {
  const open = kind === 'site' ? r.index ?? null : r.out
  const body = h('div', null,
    h('p', null, kind === 'site'
      ? t('export.siteDone', { n: r.pages, seconds: r.seconds })
      : t('export.pdfDone', { n: r.pages, kb: Math.round((r.bytes ?? 0) / 1024), seconds: r.seconds })),
    h('p', null, h('code', { class: 'export-path' }, r.out)),
    kind === 'site' && r.contents ? h('p', { class: 'hint' }, t('export.contentsPage', { file: r.contents })) : null,
    r.warnings.length
      ? h('details', { class: 'export-warnings' }, h('summary', null, t('export.warnings', { n: r.warnings.length })),
        h('pre', null, r.warnings.join('\n')))
      : null)
  const choice = await modal(t('export.doneTitle'), body, [
    { label: t('dialogs.ok'), value: 'ok' },
    ...(open ? [{ label: kind === 'site' ? t('export.openSite') : t('export.openPdf'), value: 'open', primary: true }] : []),
  ], { wide: true })
  if (choice === 'open' && open) api.openExport(open).catch(e => toast((e as Error).message, 'error'))
}
