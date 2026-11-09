# HTTP API and MCP server

## HTTP API (`server/app.py`)

All responses are JSON (`Cache-Control: no-store`). Error: `{"error": "...", ...}` with 400/403/404/409/500.
`POST` requests are rejected (403) if the `Origin` header is not local. `path` values are relative to the project root, with `/`.
Server and MCP messages (errors, warnings) are in English only; the UI translates its own texts.

### GET

| Route | Response |
|---|---|
| `/api/ping` | `{ok}`; keeps the window alive (watchdog) |
| `/api/state` | `{project: ProjectInfo \| null, recent: string[], resume: string \| null, mkdocsAvailable}`; `resume`: folder of the last session when the server was started without a folder (returned once) |
| `/api/ui` | `{prefs: {key: string}, session: object \| null, root: string \| null}`: UI preferences and the session of the current folder |
| `/api/project` | `ProjectInfo` (recomputes files, usages, broken links) |
| `/api/file?path=` | `{path, content, mtime}`; BOM removed, CRLF → LF |
| `/api/references?path=` | `{path, links: [{file, line, text}], includes: [...], toc: [{id, caption}], count}`: everything that points to the file |
| `/api/anchors?path=` | `[{id, kind: explicit\|auto\|anchor, label}]`: link targets of a saved page, snippets expanded, in MkDocs order (explicit `{ #id }`, ids generated from the heading text with `_1` suffixes, `<a id>`) |
| `/api/todos` | `[{file, kind, line, column, text}]`: every `TODO` (whole word, case sensitive), fenced code excluded, HTML comments included |
| `/api/export` | `{mkdocs, out, pdf, hasToc, browser}`: default export locations and what is available |
| `/api/toc` | `TocState`: `{path, abs, mtime, tree, orphans, broken}` (`path: null` when there is no table of contents); see [toc.md](toc.md) |
| `/api/search?q=&regex=0\|1&case=0\|1` | `[{file, line, text}]`, 2000 results maximum |
| `/api/i18n` | `{setting, language, languages: [{code, name}], messages}`; language chosen from the saved setting, else the browser's `Accept-Language`, else `en`; `messages` = `en` merged with the chosen language |
| `/raw?path=` | Raw file (images, `extra_css` CSS) |
| `/*` | Files from `web/dist`; falls back to `index.html`; `/assets/*` cached as immutable |

### POST

| Route | Body | Response |
|---|---|---|
| `/api/bye` | — | `{ok}`; signals that the window is closing |
| `/api/dialog/folder` | `{title, initial}` | `{path \| null}` (native tkinter picker) |
| `/api/project/open` | `{path}` | `ProjectInfo`; adds to recent folders (10 max) |
| `/api/project/close` | — | `{ok}` |
| `/api/project/settings` | `{snippetDir?, basePath?, tocFile?}` (`""` = default value) | `ProjectInfo` |
| `/api/file` | `{path, content, mtime?, force?, create?}` | normalized `{path, mtime, content}`; 409 `code: "conflict"` if `mtime` differs, `code: "exists"` if `create` and the file exists |
| `/api/stat` | `{paths: []}` | `{path: mtime \| null}` |
| `/api/file/delete` | `{path, force?}` | `{deleted}`; `.md` files of the project only; without `force`, 409 `code: "referenced"` + `references` if something still points to it |
| `/api/export` | `{out, useToc}` | `{out, pages, index, contents, seconds, navFromToc, warnings}`; website, one `.html` per `.md` (see [build-release.md](build-release.md#exporting)); 400/409 `unsafe` / `not_empty` for the output folder |
| `/api/export/pdf` | `{out, useToc}` | `{out, pages, bytes, seconds, navFromToc, warnings}` |
| `/api/export/open` | `{path}` | `{ok}`; opens an exported site or PDF with the default program; only paths produced by an export of this session (403 otherwise) |
| `/api/dialog/save` | `{title, initial, types, extension}` | `{path \| null}` (native "Save as") |
| `/api/toc/edit` | `{op, mtime, force?, ...}` (see [toc.md](toc.md)) | `{toc: TocState, created, deleted}`; saved at once; 409 `conflict` / `exists`, and `referenced` for `delete` without `force` |
| `/api/dialog/file` | `{title, initial, types: [[label, pattern]]}` | `{path \| null}` (native tkinter picker) |
| `/api/image` | `{name, data (base64), dir?}` | `{path}`; sanitized name, `-2`, `-3`... suffix if already taken, `images` folder by default |
| `/api/replace` | `{query, replacement, files, regex, case}` | `{changed: [{file, count}]}` |
| `/api/mkdocs/serve` | — | `{url}`; runs `python -m mkdocs serve` on a free port (waits 120 s maximum), reuses the existing process |
| `/api/settings/language` | `{language}` (code or `"auto"`) | `{ok}` |
| `/api/lang/folder` | — | `{path}`; creates `%APPDATA%\mdEditor\lang` and opens it in Explorer |
| `/api/ui/prefs` | `{key: value \| null}` | `{prefs}`; merged into the preferences (`null` deletes, values stored as strings); 413 above 64 KB |
| `/api/ui/session` | `{root?, session}` | `{saved}`; session of the current folder (opaque object, 413 above 256 KB); ignored without a folder or when `root` is not the current one |

`ProjectInfo` is described in `web/src/context.ts`; it must stay in sync with `Project.info()`.

## MCP server (`server/mcp_server.py`)

JSON-RPC 2.0, one message per line over stdio (batches accepted). Methods: `initialize`, `ping`, `tools/list`, `tools/call`. The `instructions` field of `initialize` restates the format rules.

Folder at startup: `--root`, else `MDEDITOR_ROOT`, else the editor's first recent folder.

| Tool | Read-only | Purpose |
|---|---|---|
| `set_project(path)` | no | Opens a folder |
| `project_info()` | yes | Root, `mkdocs.yml`, snippet folder, `base_path`, counts |
| `list_files(kind, filter)` | yes | Topics/snippets; for a snippet: `usedBy` and `include` line |
| `read_file(path, expand_snippets)` | yes | Content, `mtime`, and expanded content if requested |
| `write_file(path, content, expected_mtime)` | no | Replaces an existing `.md`; refuses if `mtime` changed; warns if the snippet is shared |
| `create_snippet(name, content)` | no | Creates `<snippetDir>/<name>.md`, returns the `--8<--` line |
| `snippet_usage(path)` | yes | Files that include the snippet |
| `insert_snippet(topic, snippet, line, expected_mtime)` | no | Inserts the inclusion before `line` or at the end |
| `extract_to_snippet(path, start_line, end_line, name, expected_mtime)` | no | Moves lines into a new snippet |
| `search(query, regex, case_sensitive, kind)` | yes | Search in `.md` files |
| `check_links()` | yes | Broken links and inclusions; `orphans`: topics linked from nowhere and absent from the table of contents, unused snippets |
| `list_todos(filter)` | yes | TODO markers: file, line, column, text; optional words to find in the path or the line |
| `find_references(path)` | yes | Links, snippet inclusions and table of contents entries pointing to a file |
| `get_toc()` | yes | Table of contents tree, broken nodes, topics not in it |
| `edit_toc(op, id, target, position, caption, href, create, keep_children, expected_mtime, force)` | no | Table of contents edit (see [toc.md](toc.md)); `delete` refused with the list of references unless `force` |

Adding a tool: `t_<name>` method on `Server`, entry in `TOOLS` (name, description, schema, read-only), case in `server/test_mcp.py`.
All writes go through `Server.write()`, which rejects YAML front matter and `![]()` images, then applies `normalize_markdown()`.
Business errors raise `ToolError` (returned with `isError: true`, not as a JSON-RPC error).

Test: `python server/test_mcp.py` (temporary copy of `sample/Help`). For the executable: `MDEDITOR_MCP_EXE=release/mdEditor/mdeditor-mcp.exe python server/test_mcp.py`.
