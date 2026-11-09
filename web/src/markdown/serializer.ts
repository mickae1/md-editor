// Editor document -> Markdown in the XML->MD converter format:
// HTML <img>, <a id> for anchors, <br> for line breaks, pipe tables,
// --8<-- for snippets, 4-space indentation (Python-Markdown).
import type { Mark, Node as PMNode } from '@tiptap/pm/model'

const INDENT = '    '

export function serializeDoc(doc: PMNode): string {
  const out = blocks(doc).replace(/\n{3,}/g, '\n\n').trim()
  return out ? out + '\n' : ''
}

function indent(text: string, first = INDENT, rest = INDENT): string {
  return text.split('\n').map((l, i) => (l === '' ? '' : (i === 0 ? first : rest) + l)).join('\n')
}

function blocks(parent: PMNode, sep = '\n\n'): string {
  const parts: string[] = []
  parent.forEach(child => {
    const s = block(child)
    if (s !== '') parts.push(s)
  })
  return parts.join(sep)
}

function attr(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function block(node: PMNode): string {
  switch (node.type.name) {
    case 'paragraph':
      return escapeLineStart(inline(node).trim())
    case 'heading':
      return `${'#'.repeat(node.attrs.level)} ${inline(node).trim()}`
    case 'bulletList':
    case 'orderedList':
      return list(node)
    case 'blockquote':
      return blocks(node).split('\n').map(l => (l ? `> ${l}` : '>')).join('\n')
    case 'horizontalRule':
      return '---'
    case 'codeBlock': {
      const text = node.textContent
      let fence = '```'
      while (text.includes(fence)) fence += '`'
      const info = node.attrs.info || node.attrs.language || ''
      return `${fence}${info}\n${text}\n${fence}`
    }
    case 'table':
      return table(node)
    case 'admonition': {
      const { mode, kind, classes, title } = node.attrs
      let head = `${mode} ${kind}${classes ? ' ' + classes : ''}`
      if (title !== null && title !== undefined) head += ` "${String(title).replace(/"/g, '&quot;')}"`
      const body = blocks(node)
      return body ? `${head}\n\n${indent(body)}` : head
    }
    case 'tabset': {
      const tabs: string[] = []
      node.forEach(tab => {
        const body = blocks(tab)
        const head = `===${tab.attrs.flags || ''} "${String(tab.attrs.title).replace(/"/g, '&quot;')}"`
        tabs.push(body ? `${head}\n\n${indent(body)}` : head)
      })
      return tabs.join('\n\n')
    }
    case 'snippet':
      return `--8<-- "${node.attrs.src}"`
    case 'rawBlock':
      return node.attrs.raw
    default:
      return node.isTextblock ? inline(node) : blocks(node)
  }
}

function list(node: PMNode): string {
  const ordered = node.type.name === 'orderedList'
  let n = ordered ? Number(node.attrs.start ?? 1) : 0
  // "Tight" list if each item only contains one paragraph (+ sub-lists).
  const tight = !someChild(node, item => {
    let paragraphs = 0
    item.forEach(c => { if (!c.type.name.endsWith('List')) paragraphs++ })
    return paragraphs > 1
  })
  const items: string[] = []
  node.forEach(item => {
    const marker = ordered ? `${n++}. ` : '- '
    const parts: string[] = []
    item.forEach(c => { const s = block(c); if (s !== '') parts.push(s) })
    const body = parts.join(tight ? '\n' : '\n\n') || ''
    items.push(indent(body, marker, INDENT) || marker.trimEnd())
  })
  return items.join(tight ? '\n' : '\n\n')
}

function someChild(node: PMNode, fn: (c: PMNode) => boolean): boolean {
  let found = false
  node.forEach(c => { if (!found && fn(c)) found = true })
  return found
}

function table(node: PMNode): string {
  const rows: string[][] = []
  const aligns: (string | null)[] = []
  node.forEach(row => {
    const cells: string[] = []
    row.forEach((cell, _o, i) => {
      if (rows.length === 0) aligns[i] = cell.attrs.align ?? null
      const paras: string[] = []
      cell.forEach(c => {
        const s = c.isTextblock ? inline(c).trim() : block(c).replace(/\n+/g, ' ')
        if (s) paras.push(s)
      })
      cells.push(paras.join('<br>').replace(/\|/g, '\\|'))
    })
    rows.push(cells)
  })
  if (!rows.length) return ''
  const cols = Math.max(...rows.map(r => r.length))
  for (const r of rows) while (r.length < cols) r.push('')
  const width = (s: string) => [...s].length
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...rows.map(r => width(r[c]))))
  const pad = (s: string, c: number) => s + ' '.repeat(widths[c] - width(s))
  const line = (r: string[]) => `| ${r.map(pad).join(' | ')} |`
  const sep = widths.map((w, c) => {
    const a = aligns[c]
    if (a === 'center') return ':' + '-'.repeat(w - 2) + ':'
    if (a === 'right') return '-'.repeat(w - 1) + ':'
    if (a === 'left') return ':' + '-'.repeat(w - 1)
    return '-'.repeat(w)
  })
  return [line(rows[0]), `| ${sep.join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')
}

// --------------------------------------------------------------------------
// Inline content
// --------------------------------------------------------------------------

const MARK_ORDER = ['link', 'bold', 'italic', 'code']

function open(mark: Mark, codeText = ''): string {
  switch (mark.type.name) {
    case 'bold': return '**'
    case 'italic': return '*'
    case 'code': return codeFence(codeText)
    case 'link': return '['
    default: return ''
  }
}

function close(mark: Mark, codeText = ''): string {
  switch (mark.type.name) {
    case 'bold': return '**'
    case 'italic': return '*'
    case 'code': return codeFence(codeText)
    case 'link': {
      let href: string = mark.attrs.href ?? ''
      if (/[\s()<>]/.test(href)) href = `<${href}>`
      const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : ''
      return `](${href}${title})`
    }
    default: return ''
  }
}

function codeFence(text: string): string {
  let n = 1
  while (text.includes('`'.repeat(n))) n++
  return '`'.repeat(n)
}

function inlineAtom(node: PMNode): string {
  switch (node.type.name) {
    case 'hardBreak':
      return '<br>'
    case 'image': {
      const { src, alt, width, height, title, extra } = node.attrs
      let s = `<img src="${attr(src)}" alt="${attr(alt)}"`
      if (width) s += ` width="${attr(width)}"`
      if (height) s += ` height="${attr(height)}"`
      if (title) s += ` title="${attr(title)}"`
      if (extra) s += ` ${extra}`
      return s + '>'
    }
    case 'anchor':
      return `<a id="${attr(node.attrs.id)}"></a>`
    case 'rawInline':
      return node.attrs.raw
    default:
      return node.textContent
  }
}

export function inline(parent: PMNode): string {
  const children: PMNode[] = []
  parent.forEach(c => children.push(c))
  let out = ''
  let active: Mark[] = []
  let pendingSpace = ''
  const sorted = (marks: readonly Mark[]) =>
    marks.filter(m => MARK_ORDER.includes(m.type.name))
      .sort((a, b) => MARK_ORDER.indexOf(a.type.name) - MARK_ORDER.indexOf(b.type.name))

  // Full text of a code run (over several consecutive nodes).
  const codeRun = (from: number) => {
    let s = ''
    for (let j = from; j < children.length && children[j].marks.some(m => m.type.name === 'code'); j++) s += children[j].text ?? ''
    return s
  }

  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    let marks = sorted(child.marks)
    let text = child.isText ? (child.text ?? '').replace(/\n/g, ' ') : null
    let lead = ''
    let trail = ''
    if (text !== null && marks.length && !marks.some(m => m.type.name === 'code')) {
      if (text.trim() === '') {
        // Marked whitespace only: does not change the active marks.
        marks = active.filter(m => m.isInSet(child.marks))
      } else {
        lead = /^\s*/.exec(text)![0]
        trail = /\s*$/.exec(text)![0]
        text = text.slice(lead.length, text.length - trail.length)
      }
    }

    // Close the marks that do not continue.
    let keep = 0
    while (keep < active.length && active[keep].isInSet(marks)) keep++
    const closing = active.slice(keep)
    for (let k = closing.length - 1; k >= 0; k--) {
      const m = closing[k]
      out += close(m, m.type.name === 'code' ? codeRun(i - 1 - backtrack(children, i - 1)) : '')
    }
    active = active.slice(0, keep)
    out += pendingSpace + lead
    pendingSpace = ''

    for (const m of marks) {
      if (!m.isInSet(active)) {
        out += open(m, m.type.name === 'code' ? codeRun(i) : '')
        active.push(m)
      }
    }

    if (text !== null) {
      out += active.some(m => m.type.name === 'code') ? text : escapeText(text)
    } else {
      out += inlineAtom(child)
    }
    pendingSpace = trail
  }
  for (let k = active.length - 1; k >= 0; k--) {
    const m = active[k]
    out += close(m, m.type.name === 'code' ? codeRun(children.length - 1 - backtrack(children, children.length - 1)) : '')
  }
  return out + pendingSpace
}

/** Number of consecutive code nodes before the index (to find the start). */
function backtrack(children: PMNode[], idx: number): number {
  let n = 0
  while (idx - n - 1 >= 0 && children[idx - n - 1].marks.some(m => m.type.name === 'code')) n++
  return n
}

function escapeText(text: string): string {
  let s = text
    .replace(/\\/g, '\\\\')
    .replace(/([*`[\]])/g, '\\$1')
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
    .replace(/&(?=#?\w+;)/g, '&amp;')
  // "_" is only emphasis at the start/end of a word for Python-Markdown.
  s = s.replace(/_/g, (m, offset: number, str: string) => {
    const before = str[offset - 1] ?? ''
    const after = str[offset + 1] ?? ''
    return /\w/.test(before) && /\w/.test(after) ? '_' : '\\_'
  })
  return s
}

function escapeLineStart(text: string): string {
  return text
    .replace(/^(#{1,6})(\s|$)/, '\\$1$2')
    .replace(/^([-+])(\s)/, '\\$1$2')
    .replace(/^(\d+)\.(\s)/, '$1\\.$2')
    .replace(/^>/, '\\>')
    .replace(/^(!!!|\?\?\?|===)/, '\\$1')
    .replace(/^(-+8<)/, '\\$1')
    .replace(/^(-{3,}|_{3,}|={3,})$/, m => '\\' + m)
}
