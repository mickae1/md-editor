// Link targets of a page, computed like MkDocs: explicit heading ids from
// attr_list ("## Title { #my-id }"), ids generated from the heading text by the
// toc extension, and <a id> anchors. Same rules as markdown_anchors() in server/app.py.
import type { Node as PMNode } from '@tiptap/pm/model'

/** attr_list id at the end of a heading line (not preceded by a backslash). */
export const HEADING_ID_RE = /(^|[^\\])\{\s*#([A-Za-z0-9_-]+)\s*\}\s*$/
/** Characters allowed in an id. */
export const ANCHOR_ID_RE = /^[A-Za-z0-9_-]+$/

/** Python-Markdown toc default slugify. */
export function slugify(text: string): string {
  return text.normalize('NFKD').replace(/[^\x00-\x7f]/g, '')
    .replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[-\s]+/g, '-')
}

/** Python-Markdown toc unique(): foo, foo_1, foo_2... */
export function unique(id: string, used: Set<string>): string {
  while (!id || used.has(id)) {
    const m = /^(.*)_([0-9]+)$/.exec(id)
    id = m ? `${m[1]}_${Number(m[2]) + 1}` : `${id}_1`
  }
  used.add(id)
  return id
}

export interface Anchor {
  id: string
  kind: 'explicit' | 'auto' | 'anchor'
  /** Heading text (empty for <a id> anchors). */
  label: string
  /** Position of the node in its document. */
  pos: number
  /** Index of that document in the docAnchors() arguments. */
  doc: number
}

/** Anchors of one or more documents (a page and the snippets it shows), in MkDocs order. */
export function docAnchors(...docs: PMNode[]): Anchor[] {
  const headings: { label: string; id: string | null; pos: number; doc: number }[] = []
  const tags: Anchor[] = []
  docs.forEach((d, i) => {
    d.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        headings.push({ label: node.textContent.trim(), id: node.attrs.id || null, pos, doc: i })
        return false
      }
      if (node.type.name === 'anchor' && node.attrs.id) tags.push({ id: node.attrs.id, kind: 'anchor', label: '', pos, doc: i })
      return true
    })
  })
  const used = new Set(headings.filter(x => x.id).map(x => x.id as string))
  const out: Anchor[] = headings.map(x => x.id
    ? { id: x.id, kind: 'explicit', label: x.label, pos: x.pos, doc: x.doc }
    : { id: unique(slugify(x.label), used), kind: 'auto', label: x.label, pos: x.pos, doc: x.doc })
  return [...out, ...tags]
}
