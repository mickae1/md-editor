// Markdown -> editor -> Markdown round trip on the sample files.
// Run: npm test   (checks that the output is stable and the format is respected)
import { Window } from 'happy-dom'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const win = new Window()
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
Object.assign(globalThis, {
  window: win, document: win.document, Node: win.Node, HTMLElement: win.HTMLElement,
  Element: win.Element, DOMParser: win.DOMParser, getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0), MutationObserver: win.MutationObserver,
  KeyboardEvent: win.KeyboardEvent, CSS: { escape: (s: string) => s },
})

const { Editor } = await import('@tiptap/core')
const { buildExtensions } = await import('../src/editor/create.ts')
const { markdownToHtml } = await import('../src/markdown/parser.ts')
const { serializeDoc } = await import('../src/markdown/serializer.ts')
const { ctx } = await import('../src/context.ts')
Object.assign(ctx, {
  includePath: (s: string) => s, includeSrc: (s: string) => s, fileExists: () => true, usageOf: () => [],
  imageUrl: (s: string) => s, onEditorChange: () => {}, setActiveEditor: () => {},
  snippets: { mount: () => new Promise(() => {}), onChange: () => () => {}, isDirty: () => false, unmount: () => {} },
})

function roundtrip(md: string): string {
  const ed = new Editor({ extensions: buildExtensions({ docPath: 'index.md', ancestors: [] }), content: markdownToHtml(md) })
  const out = serializeDoc(ed.state.doc)
  ed.destroy()
  return out
}

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (!cond) { failures++; console.log(`FAIL ${name}\n${detail}`) } else console.log(`ok   ${name}`)
}

// 1. Sample files: stability (a 2nd pass changes nothing) + key content kept
const dirs = ['../sample/Help/Md', '../sample/Help/Md/_snippets']
for (const d of dirs) {
  for (const f of readdirSync(d).filter(f => f.endsWith('.md'))) {
    const src = readFileSync(join(d, f), 'utf8')
    const once = roundtrip(src)
    const twice = roundtrip(once)
    check(`${f} stable`, once === twice, `--- 1st pass\n${once}\n--- 2nd pass\n${twice}`)
    for (const needle of src.match(/--8<-- "[^"]+"|<img [^>]+>|<a id="[^"]+"><\/a>|!!! \w+|\?\?\? \w+|=== "[^"]+"/g) ?? []) {
      check(`${f} keeps ${needle.slice(0, 40)}`, once.includes(needle), once)
    }
  }
}

// 2. Specific cases
const cases: [string, string, string?][] = [
  ['html img', '<img src="images/a.png" alt="A" width="10" height="20">\n'],
  ['br', 'line 1<br>line 2\n'],
  ['anchor', '<a id="x"></a>\nText\n', '<a id="x"></a> Text\n'],
  ['snippet', '--8<-- "_snippets/a.md"\n'],
  ['admonition with title', '!!! note "Title"\n\n    Body **bold**.\n'],
  ['admonition without title', '!!! warning ""\n\n    Body.\n'],
  ['details', '???+ tip\n\n    Body.\n'],
  ['tabs', '=== "A"\n\n    One.\n\n=== "B"\n\n    Two.\n'],
  ['nested list', '- a\n    - b\n- c\n'],
  ['ordered list', '1. a\n2. b\n'],
  ['code', '```python\nx = 1\n```\n'],
  ['aligned table', '| A | B |\n| :-- | --: |\n| 1 | 2 |\n', '| A   | B   |\n| :-- | --: |\n| 1   | 2   |\n'],
  ['intra-word underscore', 'file_name_here and _italic_\n', 'file_name_here and *italic*\n'],
  ['literal asterisk', String.raw`a \* b` + '\n'],
  ['internal link', 'See [Topic](Topic.md#anchor).\n'],
  ['raw html', '<div markdown>\n\ntext\n\n</div>\n'],
  ['inline html', 'Press <kbd>Ctrl</kbd>\n'],
  ['bold+italic', '***x*** and **a *b* c**\n'],
  ['inline code', 'Use `a*b` here\n'],
  ['attr_list title', '## Title {#my-id}\n'],
  ['mailto Markdown link', 'Contact [Toto](mailto:toto@toto.fr).\n'],
  ['mailto autolink kept', 'Contact <mailto:toto@toto.fr>.\n'],
  ['email autolink kept', 'Contact <toto@toto.fr>.\n'],
  ['URL autolink kept', 'See <https://example.com/a_b>.\n'],
  ['HTML mailto link kept', 'Contact <a href="mailto:toto@toto.fr?subject=Help">toto@toto.fr</a>.\n'],
  ['HTML link with other attributes kept', 'Open <a class="ext" href="https://example.com" target="_blank">the **site**</a>.\n'],
  ['plain mailto text stays text', 'Write to mailto:toto@toto.fr directly.\n'],
  ['heading id (spec format)', '## Dates selection { #creatanalyss2 }\n'],
  ['heading id compact kept', '### ACC Demand Overloads {#accoverloads}\n'],
  ['heading id with marks', '## **Bold** and `code` title { #b-1 }\n'],
  ['heading literal braces escaped', '## Escaped \\{#nope}\n'],
  ['heading with only an id', '## { #only-id }\n'],
  ['heading id in an admonition', '!!! note\n\n    ## Inside { #inside }\n'],
  ['disabled snippet', ';--8<-- "x.md"\n'],
]
for (const [name, src, expected] of cases) {
  const out = roundtrip(src)
  check(name, out === (expected ?? src), `expected:\n${expected ?? src}\ngot:\n${out}`)
}

// 3. Heading anchor ids ({ #id }): not part of the visible text, written back at the end
{
  const ed = new Editor({ extensions: buildExtensions({ docPath: 'index.md', ancestors: [] }), content: markdownToHtml('## Dates selection { #creatanalyss2 }\n') })
  const h = ed.state.doc.firstChild!
  check('heading id: not in the visible text', h.textContent === 'Dates selection', h.textContent)
  check('heading id: kept as an attribute', h.attrs.id === 'creatanalyss2', String(h.attrs.id))
  // Enter in the middle of the heading: the id stays on the first part only.
  ed.commands.setTextSelection(6)
  ed.commands.splitBlock()
  const out = serializeDoc(ed.state.doc)
  check('heading id: not duplicated when splitting', (out.match(/\{ #creatanalyss2 \}/g) ?? []).length === 1, out)
  ed.destroy()

  const ed2 = new Editor({ extensions: buildExtensions({ docPath: 'index.md', ancestors: [] }), content: '<h2 data-heading-id="new-id">Title</h2><h3>Plain</h3>' })
  check('heading id: new id written in the spec format', serializeDoc(ed2.state.doc) === '## Title { #new-id }\n\n### Plain\n', serializeDoc(ed2.state.doc))
  ed2.commands.command(({ tr }) => { tr.setNodeMarkup(0, undefined, { ...tr.doc.firstChild!.attrs, id: null }); return true })
  check('heading id: removed', serializeDoc(ed2.state.doc) === '## Title\n\n### Plain\n', serializeDoc(ed2.state.doc))
  ed2.destroy()
}

// 3b. HTML links are real links (not raw HTML) and keep their form
{
  const ed = new Editor({ extensions: buildExtensions({ docPath: 'index.md', ancestors: [] }), content: markdownToHtml('Contact <a href="mailto:toto@toto.fr">Toto</a>.\n') })
  let link: { href: string; text: string } | null = null
  ed.state.doc.descendants(n => { const m = n.marks.find(x => x.type.name === 'link'); if (m) link = { href: m.attrs.href, text: n.text ?? '' }; return true })
  check('HTML mailto link: editable link, no raw HTML', JSON.stringify(link) === JSON.stringify({ href: 'mailto:toto@toto.fr', text: 'Toto' }) && !JSON.stringify(ed.getJSON()).includes('rawInline'), JSON.stringify(ed.getJSON()))
  // Changing the target of an HTML link writes a new <a href> tag.
  ed.commands.setTextSelection({ from: 10, to: 12 })
  ed.chain().extendMarkRange('link').updateAttributes('link', { href: 'mailto:other@toto.fr' }).run()
  check('HTML link: new target written', serializeDoc(ed.state.doc) === 'Contact <a href="mailto:other@toto.fr">Toto</a>.\n', serializeDoc(ed.state.doc))
  ed.destroy()
}

// 4. Anchors computed like MkDocs (same rules as markdown_anchors() in server/app.py)
{
  const { docAnchors, slugify } = await import('../src/markdown/anchors.ts')
  const md = '# Analysis\n\n## Dates selection { #creatanalyss2 }\n\n## Dates selection\n\n## Dates selection\n\n## Élan & **bold**\n\n<a id="intro"></a> text\n'
  const ed = new Editor({ extensions: buildExtensions({ docPath: 'index.md', ancestors: [] }), content: markdownToHtml(md) })
  const ids = docAnchors(ed.state.doc).map(a => a.id).join(' ')
  check('anchors: explicit, generated, unique suffixes, <a id>', ids === 'analysis creatanalyss2 dates-selection dates-selection_1 elan-bold intro', ids)
  check('anchors: slugify like Python-Markdown', slugify(' Hello, World — v2.0! ') === 'hello-world-v20', slugify(' Hello, World — v2.0! '))
  ed.destroy()
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll OK')
process.exit(failures ? 1 : 0)
