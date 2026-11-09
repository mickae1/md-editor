// Shared snippet state: one in-memory content per file, shown by as many
// editors as needed (in several topics, or in a dedicated tab). Changes made
// in one editor are replayed in the others.
import { Editor, type JSONContent } from '@tiptap/core'
import { Step } from '@tiptap/pm/transform'
import type { Transaction } from '@tiptap/pm/state'
import { api } from '../api'
import { ctx, type EditorHost } from '../context'
import { createEditor } from '../editor/create'
import { markdownToHtml } from '../markdown/parser'
import { serializeDoc } from '../markdown/serializer'

const SYNC = 'snippet-sync'

export interface SnippetEntry {
  path: string
  mtime: number | null
  missing: boolean
  /** Markdown as serialized when opened / last saved. */
  baseline: string
  current: string
  json: JSONContent | null
  html: string
  editors: Set<Editor>
}

type Listener = () => void

export class SnippetStore {
  entries = new Map<string, SnippetEntry>()
  private loading = new Map<string, Promise<SnippetEntry>>()
  private listeners = new Set<Listener>()

  onChange(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  private emit() { this.listeners.forEach(l => l()) }

  async load(path: string): Promise<SnippetEntry> {
    const existing = this.entries.get(path)
    if (existing) return existing
    let p = this.loading.get(path)
    if (!p) {
      p = (async () => {
        let content = ''
        let mtime: number | null = null
        let missing = false
        try {
          const f = await api.readFile(path)
          content = f.content
          mtime = f.mtime
        } catch {
          missing = true
        }
        const entry: SnippetEntry = { path, mtime, missing, baseline: '', current: '', json: null, html: markdownToHtml(content), editors: new Set() }
        this.entries.set(path, entry)
        this.loading.delete(path)
        return entry
      })()
      this.loading.set(path, p)
    }
    return p
  }

  /** Creates an editor bound to the snippet, mounted in `element`. */
  async mount(path: string, element: HTMLElement, host: EditorHost): Promise<{ editor: Editor; entry: SnippetEntry }> {
    const entry = await this.load(path)
    const live = [...entry.editors][0]
    const content = live ? live.getJSON() : entry.json ?? entry.html
    const editor = createEditor({
      element,
      content,
      host: { docPath: host.docPath, ancestors: [...host.ancestors, path] },
      onTransaction: tr => this.propagate(entry, editor, tr),
    })
    if (!entry.baseline && !live && !entry.json) {
      entry.baseline = entry.current = serializeDoc(editor.state.doc)
    }
    entry.editors.add(editor)
    return { editor, entry }
  }

  unmount(path: string, editor: Editor) {
    const entry = this.entries.get(path)
    if (!entry) return
    if (entry.editors.delete(editor) && entry.editors.size === 0) {
      // No view left: keep the unsaved content in memory.
      entry.json = editor.getJSON()
    }
    editor.destroy()
  }

  private propagate(entry: SnippetEntry, source: Editor, tr: Transaction) {
    if (!tr.docChanged || tr.getMeta(SYNC)) return
    const steps = tr.steps.map(s => s.toJSON())
    for (const other of entry.editors) {
      if (other === source || other.isDestroyed) continue
      const otr = other.state.tr
      try {
        for (const s of steps) otr.step(Step.fromJSON(other.schema, s))
      } catch {
        // States out of sync: copy the whole document.
        other.chain().setMeta(SYNC, true).setMeta('addToHistory', false).setContent(source.getJSON(), { emitUpdate: false }).run()
        continue
      }
      otr.setMeta(SYNC, true).setMeta('addToHistory', false)
      other.view.dispatch(otr)
    }
    entry.current = serializeDoc(source.state.doc)
    entry.json = null
    this.emit()
    ctx.onEditorChange()
  }

  isDirty(path: string): boolean {
    const e = this.entries.get(path)
    return !!e && e.current !== e.baseline
  }

  dirtyPaths(): string[] {
    return [...this.entries.values()].filter(e => e.current !== e.baseline).map(e => e.path)
  }

  /** Snippets included (recursively) in a document. */
  includedIn(doc: Editor['state']['doc'], seen = new Set<string>()): string[] {
    doc.descendants(node => {
      if (node.type.name !== 'snippet') return true
      const path = ctx.includePath(node.attrs.src)
      if (!seen.has(path)) {
        seen.add(path)
        const live = [...(this.entries.get(path)?.editors ?? [])][0]
        if (live) this.includedIn(live.state.doc, seen)
      }
      return false
    })
    return [...seen]
  }

  /** Saves a snippet. Returns false if the user cancels (conflict). */
  async save(path: string, force = false): Promise<boolean> {
    const entry = this.entries.get(path)
    if (!entry) return true
    const result = await api.writeFile(path, entry.current, entry.missing ? null : entry.mtime, force)
    if (result === 'conflict') return false
    entry.mtime = result.mtime
    entry.missing = false
    entry.baseline = entry.current
    this.emit()
    ctx.onEditorChange()
    return true
  }

  /** Reloads from disk (external change). */
  async reload(path: string) {
    const entry = this.entries.get(path)
    if (!entry) return
    const f = await api.readFile(path)
    entry.mtime = f.mtime
    entry.html = markdownToHtml(f.content)
    entry.json = null
    let first = true
    for (const ed of entry.editors) {
      ed.chain().setMeta(SYNC, true).setMeta('addToHistory', false).setContent(entry.html, { emitUpdate: false }).run()
      if (first) { entry.baseline = entry.current = serializeDoc(ed.state.doc); first = false }
    }
    if (first) { this.entries.delete(path) }
    this.emit()
    ctx.onEditorChange()
  }

  /** Discards the unsaved changes of a snippet. */
  async revert(path: string) { await this.reload(path) }

  forget(path: string) {
    const e = this.entries.get(path)
    if (e && e.editors.size === 0 && e.current === e.baseline) this.entries.delete(path)
  }

  clear() {
    for (const e of this.entries.values()) for (const ed of e.editors) ed.destroy()
    this.entries.clear()
    this.emit()
  }
}
