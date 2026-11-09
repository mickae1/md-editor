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
  ['disabled snippet', ';--8<-- "x.md"\n'],
]
for (const [name, src, expected] of cases) {
  const out = roundtrip(src)
  check(name, out === (expected ?? src), `expected:\n${expected ?? src}\ngot:\n${out}`)
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll OK')
process.exit(failures ? 1 : 0)
