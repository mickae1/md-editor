// Markdown (MkDocs / pymdownx dialect) -> annotated HTML, then read by TipTap.
//
// MkDocs-specific constructs (snippets, admonitions, tabs...) are rendered
// as elements carrying data-* attributes that the editor nodes can read
// back. Unknown HTML is kept as is in "raw" nodes so that nothing is lost
// on save.
import markdownIt, { type MarkdownIt, type StateBlock, type StateCore, type Token } from 'markdown-it'
import { HEADING_ID_RE } from './anchors'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const SNIPPET_LINE = /^(;?)-+8<-+\s+(["'])([^"']+)\2\s*$/
const SNIPPET_BLOCK_FENCE = /^-+8<-+\s*$/
const ADMONITION_LINE = /^(!!!|\?\?\?\+?)\s+([\w-]+)((?:[ \t]+[\w-]+)*)(?:[ \t]+"(.*)")?\s*$/
const TAB_LINE = /^===([!+]*)\s+"(.*)"\s*$/

function lineText(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
}

/** Block indented by 4 spaces under a header line (admonitions, tabs). */
function containerRule(name: string, re: RegExp) {
  return (state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false
    const m = re.exec(lineText(state, startLine))
    if (!m) return false
    if (silent) return true

    const contentIndent = state.sCount[startLine] + 4
    let next = startLine + 1
    let last = startLine
    while (next < endLine) {
      if (state.isEmpty(next)) { next++; continue }
      if (state.sCount[next] < contentIndent) break
      last = next++
    }
    const end = last + 1

    const open = state.push(`${name}_open`, 'div', 1)
    open.meta = m as unknown as Record<string, unknown>
    open.map = [startLine, end]
    open.block = true

    const old = { blkIndent: state.blkIndent, parentType: state.parentType, lineMax: state.lineMax }
    state.blkIndent = contentIndent
    state.parentType = 'blockquote'
    state.lineMax = end
    state.md.block.tokenize(state, startLine + 1, end)
    state.blkIndent = old.blkIndent
    state.parentType = old.parentType
    state.lineMax = old.lineMax

    state.push(`${name}_close`, 'div', -1).block = true
    state.line = end
    return true
  }
}

function snippetRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  const text = lineText(state, startLine)

  // Block form:  --8<--  /  file1.md  /  file2.md  /  --8<--
  if (SNIPPET_BLOCK_FENCE.test(text)) {
    let close = -1
    for (let l = startLine + 1; l < endLine; l++) {
      if (SNIPPET_BLOCK_FENCE.test(lineText(state, l))) { close = l; break }
    }
    if (close < 0) return false
    if (silent) return true
    for (let l = startLine + 1; l < close; l++) {
      const src = lineText(state, l).trim()
      if (!src || src.startsWith(';')) continue
      const t = state.push('snippet', 'div', 0)
      t.meta = { src }
      t.map = [l, l + 1]
    }
    state.line = close + 1
    return true
  }

  const m = SNIPPET_LINE.exec(text)
  if (!m || m[1]) return false // ";--8<--" = disabled inclusion, left as text
  if (silent) return true
  const t = state.push('snippet', 'div', 0)
  t.meta = { src: m[3] }
  t.map = [startLine, startLine + 1]
  state.line = startLine + 1
  return true
}

/** Groups consecutive tabs (=== "...") in a container. */
function groupTabs(state: StateCore) {
  const tokens = state.tokens
  const out: Token[] = []
  const closeIndexOf = (i: number) => {
    let depth = 0
    for (let j = i; j < tokens.length; j++) {
      if (tokens[j].type === 'tab_open') depth++
      else if (tokens[j].type === 'tab_close' && --depth === 0) return j
    }
    return tokens.length - 1
  }
  const process = (from: number, to: number) => {
    let i = from
    while (i < to) {
      const t = tokens[i]
      if (t.type !== 'tab_open') { out.push(t); i++; continue }
      out.push(Object.assign(new state.Token('tabset_open', 'div', 1), { block: true }))
      let first = true
      while (i < to && tokens[i].type === 'tab_open') {
        const flags = String((tokens[i].meta as unknown as RegExpExecArray | null)?.[1] ?? '')
        if (!first && flags.includes('!')) break
        first = false
        const c = closeIndexOf(i)
        out.push(tokens[i])
        process(i + 1, c)
        out.push(tokens[c])
        i = c + 1
      }
      out.push(Object.assign(new state.Token('tabset_close', 'div', -1), { block: true }))
    }
  }
  process(0, tokens.length)
  state.tokens = out
}

/**
 * attr_list id at the end of a heading ("## Title { #my-id }"): removed from the
 * text before inline parsing and kept as data-heading-id. data-heading-id-compact
 * remembers the "{#my-id}" spelling so that unchanged headings are written back as is.
 */
function headingIds(state: StateCore) {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type !== 'heading_open' || tokens[i + 1].type !== 'inline') continue
    const inline = tokens[i + 1]
    const m = HEADING_ID_RE.exec(inline.content)
    if (!m) continue
    inline.content = inline.content.slice(0, m.index + m[1].length).replace(/\s+$/, '')
    tokens[i].attrSet('data-heading-id', m[2])
    if (!/\{\s/.test(m[0])) tokens[i].attrSet('data-heading-id-compact', '1')
  }
}

/** Opening <a ...href="..."...> tag (not an <a id> anchor). */
const HTML_LINK_OPEN = /^<a\s(?:[^>]*\s)?href\s*=\s*["']([^"']*)["'][^>]*>$/i

/** Index of the </a> closing the HTML link opened at `idx` in the same inline run, or -1. */
function htmlLinkClose(tokens: Token[], idx: number): number {
  for (let j = idx + 1; j < tokens.length; j++) {
    const t = tokens[j]
    if (t.type !== 'html_inline') continue
    if (/^<\/a\s*>$/i.test(t.content)) return j
    if (/^<a[\s>]/i.test(t.content)) return -1 // nested link: leave both as raw HTML
  }
  return -1
}

const decodeEntities = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const INLINE_HTML_ONLY = /^(\s*(<img\b[^>]*>|<br\s*\/?>|<a\s+(?:id|name)="[^"]*"\s*>\s*<\/a>)\s*)+$/i
const ANCHOR_OPEN = /^<a\s+(?:id|name)="([^"]*)"\s*>$/i

function createMarkdownIt(): MarkdownIt {
  const md = markdownIt('default', { html: true, linkify: false, typographer: false })
  md.disable(['strikethrough'])

  md.block.ruler.before('fence', 'snippet', snippetRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.block.ruler.before('fence', 'admonition', containerRule('admonition', ADMONITION_LINE), { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.block.ruler.before('fence', 'tab', containerRule('tab', TAB_LINE), { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.core.ruler.push('group_tabs', groupTabs)
  md.core.ruler.after('block', 'heading_ids', headingIds)

  const r = md.renderer.rules

  r.snippet = (tokens, idx) => `<div data-snippet="${esc(String(tokens[idx].meta?.src ?? ''))}"></div>\n`

  r.admonition_open = (tokens, idx) => {
    const m = tokens[idx].meta as unknown as RegExpExecArray
    const title = m[4] === undefined ? '' : ` data-title="${esc(m[4])}"`
    return `<div data-admonition="${esc(m[2])}" data-mode="${esc(m[1])}" data-classes="${esc((m[3] || '').trim())}"${title}>\n`
  }
  r.admonition_close = () => '</div>\n'

  r.tabset_open = () => '<div data-tabset>\n'
  r.tabset_close = () => '</div>\n'
  r.tab_open = (tokens, idx) => {
    const m = tokens[idx].meta as unknown as RegExpExecArray
    return `<div data-tab data-title="${esc(m[2])}" data-flags="${esc(m[1] || '')}">\n`
  }
  r.tab_close = () => '</div>\n'

  r.fence = (tokens, idx) => {
    const t = tokens[idx]
    const info = t.info.trim()
    const lang = info.replace(/^\{\s*\.?/, '').split(/[\s{}]+/)[0] || ''
    return `<pre data-info="${esc(info)}"><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(t.content.replace(/\n$/, ''))}</code></pre>\n`
  }
  r.code_block = (tokens, idx) =>
    `<pre data-info="" data-indented="1"><code>${esc(tokens[idx].content.replace(/\n$/, ''))}</code></pre>\n`

  r.html_block = (tokens, idx) => {
    const content = tokens[idx].content
    if (INLINE_HTML_ONLY.test(content)) return `<p>${content.trim()}</p>\n`
    return `<div data-raw-block="${esc(content.replace(/\n+$/, ''))}"></div>\n`
  }

  // Autolinks (<https://...>, <mailto:...>, <name@host>): written back in the same form.
  const linkOpen = r.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  r.link_open = (tokens, idx, options, env, self) => {
    if (tokens[idx].markup === 'autolink') tokens[idx].attrSet('data-link-format', 'auto')
    return linkOpen(tokens, idx, options, env, self)
  }

  r.html_inline = (tokens, idx) => {
    const t = tokens[idx]
    const html = t.content
    // <a href="...">text</a> in HTML: an editable link, written back as HTML.
    if (HTML_LINK_OPEN.test(html)) {
      const close = htmlLinkClose(tokens, idx)
      const href = HTML_LINK_OPEN.exec(html)![1]
      if (close > 0) {
        tokens[close].meta = { htmlLinkClose: true }
        return `<a href="${esc(decodeEntities(href))}" data-link-format="html" data-html-tag="${esc(html)}">`
      }
    }
    if (t.meta?.htmlLinkClose) return '</a>'
    if (/^<br\s*\/?>$/i.test(html)) return '<br>'
    if (/^<img\b/i.test(html)) return html
    const anchor = ANCHOR_OPEN.exec(html)
    if (anchor && tokens[idx + 1]?.type === 'html_inline' && /^<\/a>$/i.test(tokens[idx + 1].content)) {
      tokens[idx + 1].content = '' // consumes the </a>
      return `<a data-anchor="${esc(anchor[1])}"></a>`
    }
    if (html === '') return ''
    return `<span data-raw-inline="${esc(html)}"></span>`
  }

  // Column alignment kept via data-align (read by the cells).
  const cell = (tag: string) => (tokens: Token[], idx: number) => {
    const style = String(tokens[idx].attrGet('style') ?? '')
    const m = /text-align:(\w+)/.exec(style)
    return `<${tag}${m ? ` data-align="${m[1]}"` : ''}>`
  }
  r.th_open = cell('th')
  r.td_open = cell('td')

  return md
}

const md = createMarkdownIt()

export function markdownToHtml(source: string): string {
  return md.render(source.replace(/\r\n?/g, '\n'))
}
