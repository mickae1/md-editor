# Markdown format and round trip

The editor reads the Markdown, shows it in TipTap, then writes it back. The MkDocs rendering must stay identical and the output must match the format of the existing XML → MD converter.

```
.md file ──parser.ts──> annotated HTML (data-*) ──node parseHTML──> ProseMirror document
ProseMirror document ──serializer.ts──> Markdown ──normalize_markdown (Python)──> disk
```

## Guaranteed output format

| Element | Output |
|---|---|
| Image | `<img src="..." alt="..." width="..." height="...">` (never `![]()`) |
| Anchor | `<a id="..."></a>` |
| Line break inside a paragraph | `<br>` |
| Table | Pipe, aligned columns, `:---:` according to alignment; multiple paragraphs in a cell joined with `<br>` |
| Snippet | `--8<-- "path"` (path relative to `base_path`) |
| Admonition | `!!! type "Title"` / `??? type` / `???+ type`, content indented by 4 spaces |
| Tabs | `=== "Title"` (`!` / `+` flags preserved), content indented by 4 spaces |
| Lists | `- ` or `1. `, continuation indented by 4 spaces (Python-Markdown), tight list if every item has a single paragraph |
| Code | ``` fence lengthened if the content already contains backticks; info string (`python`, `{ .py }`...) preserved |
| Bold / italic | `**...**` / `*...*` |
| Unknown HTML | Kept as is (`rawBlock` / `rawInline`) |
| File | UTF-8 without BOM, LF, no trailing spaces, a single final newline, no front matter |

Normalization may change the source on the first save (table alignment, `_` → `*`, escapes) without changing the rendering. Only modified files are rewritten.

## Parser (`web/src/markdown/parser.ts`)

markdown-it (`html: true`, `linkify: false`, `typographer: false`, strikethrough disabled) with block rules added before `fence`:

- `snippet`: line form `--8<-- "x.md"` and block form `--8<--` / list of files / `--8<--`. `;--8<--` (disabled inclusion) stays as text.
- `admonition` and `tab`: `containerRule()` reads a header, then the block indented by 4 spaces, and tokenizes it recursively.
- `group_tabs` (core rule): groups consecutive tabs into a `tabset`; a `!` flag starts a new group.

Rendered as annotated HTML read by the TipTap nodes:

| Construct | Intermediate HTML |
|---|---|
| Snippet | `<div data-snippet="src">` |
| Admonition | `<div data-admonition data-mode data-classes data-title>` |
| Tabs | `<div data-tabset>` > `<div data-tab data-title data-flags>` |
| Code | `<pre data-info="...">` |
| Block HTML | `<div data-raw-block="...">` unless it only contains `<img>`, `<br>`, anchors (then a paragraph) |
| Inline HTML | `<br>` and `<img>` kept, anchor → `<a data-anchor>`, the rest → `<span data-raw-inline>` |
| Aligned cell | `data-align` |

## Serializer (`web/src/markdown/serializer.ts`)

- `block()`: one case per node type. Every new node must have its case there, otherwise it is reduced to its text.
- `inline()`: opens/closes marks in the order `link, bold, italic, code`, moves edge spaces outside the marks (otherwise `** bold**` is not recognized).
- `escapeText()`: escapes `\ * \` [ ]`, `<` before a tag, `&` before an entity; `_` only at the start/end of a word (Python-Markdown rule).
- `escapeLineStart()`: escapes anything that would be read back as a heading, list, quote, admonition, tab, snippet or horizontal rule.

## Adding a construct

1. Rule and `data-*` rendering in `parser.ts`.
2. TipTap node (`parseHTML` on the attribute, `renderHTML`, NodeView if needed) in `editor/nodes.ts` or a dedicated file, added to `buildExtensions()` in `editor/create.ts`.
3. Case in `block()` or `inlineAtom()` of `serializer.ts`.
4. Case in `web/tests/roundtrip.test.ts`: the output must be stable (a second pass changes nothing) and keep the key elements.
5. If the construct also concerns the server (index, links), check the regexes in `server/app.py`.

## Tests

`npm test` (`web/tests/roundtrip.test.ts`, happy-dom):
- all files in `sample/Help/Md` and `_snippets/`: stability and preservation of key elements;
- targeted format cases.

The test replaces `ctx.snippets` with a fake store: snippets are not expanded, only the `--8<--` line is checked.

## Heading identifiers (`{ #id }`)

attr_list ids at the end of a heading line, `## Dates selection { #creatanalyss2 }` or `{#accoverloads}`:

- **Parser**: the `heading_ids` core rule (before inline parsing) removes the id from the heading text. It sets `data-heading-id`, plus `data-heading-id-compact` for the `{#id}` spelling. `\{#x}` (escaped) stays text. The regex is `HEADING_ID_RE` in `web/src/markdown/anchors.ts`, the same as in `server/app.py`.
- **Node**: `HeadingWithId` (`web/src/editor/heading.ts`) adds the `id` and `idCompact` attributes. A plugin keeps every id on one heading only: Enter in the middle of a heading and paste both copy attributes. The badge is a CSS `::after` (`content.css`), outside the editable text. The context menu edits the id, checks its characters and warns about duplicates.
- **Serializer**: `## Title { #id }` (spec format), or `{#id}` when the heading was read that way. A literal `{#x}` at the end of a heading text is escaped (`\{#x}`).
- **Anchors**: `docAnchors()` (TS) and `markdown_anchors()` (Python) compute the targets of a page like MkDocs. Explicit ids come first, then ids generated from the text (`slugify` of Python-Markdown's toc, `_1`, `_2` for duplicates), then `<a id>` anchors. They feed the link dialog, scrolling to an anchor and `/api/anchors`. Both implementations must stay identical.

## Links

The link mark (`web/src/editor/link.ts`) has a `format` attribute that keeps the original form:

| Source | `format` | Saved as |
|---|---|---|
| `[text](target)` | none | `[text](target)` |
| `<https://...>`, `<name@host>`, `<mailto:...>` | `auto` | the same autolink while its text is still its target, otherwise `[text](target)` |
| `<a href="..." ...>text</a>` (inline HTML) | `html` | the original opening tag, with all its attributes, while the target is unchanged; otherwise `<a href="new">` |

HTML links are real links in the editor, not raw HTML. Their text is still Markdown, as in Python-Markdown. An `<a>` without `href` (`<a id>`), or nested links, stay raw. Plain text such as `mailto:x@y` is not a link on the site, so it stays text.
