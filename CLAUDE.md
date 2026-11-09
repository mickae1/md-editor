# CLAUDE.md

Guidance for working on this repository. User-facing documentation is in [README.md](README.md), and the developer documentation is in [`doc/`](doc/).

## What this is

mdEditor is a WYSIWYG editor for MkDocs (pymdownx) documentation sets of several hundred topics. It is built around `--8<--` snippet inclusions and the site's table of contents (`Maps/table_of_contents.xml`).

- **Server** (`server/`): Python, standard library only. It serves the UI and a JSON API on `127.0.0.1`, and holds the project model.
- **UI** (`web/`): Vite and TypeScript with TipTap/ProseMirror, no UI framework. It is built into `web/dist` and shown in Edge in app mode.
- **MCP server** (`server/mcp_server.py`): gives Claude the same project model and rules, over stdio.
- **Release**: PyInstaller, two executables (`mdEditor.exe`, `mdeditor-mcp.exe`) sharing `_internal/`.

The requirements are in `wysiwyg-editor-spec.md`. It is a local file, deliberately not tracked by git, so it may be missing. Never commit it.

## Repository map

| Path | Role |
|---|---|
| `server/app.py` | HTTP server, `Project` (files, snippet usage, links, orphans, references), safe writes, launcher, watchdog |
| `server/toc.py` | Table of contents: detection, lossless read/write, edit operations |
| `server/mcp_server.py` | MCP tools; imports `Project` and helpers from `app.py` |
| `server/export.py`, `server/cli.py` | Website / PDF export (MkDocs, Edge) and the `mdeditor-cli` command line |
| `web/src/boot.ts` → `main.ts` | Entry point: loads the language, then the app (layout, shortcuts, `ctx` wiring) |
| `web/src/markdown/` | `parser.ts` (markdown-it + pymdownx rules → annotated HTML), `serializer.ts` (document → Markdown) |
| `web/src/editor/` | TipTap nodes and editor factory (`create.ts`) |
| `web/src/snippets/store.ts` | Shared snippet state, step replay between editors |
| `web/src/app/` | Workspace (tabs, save), panels (explorer, search, links, table of contents, snippets), toolbar, dialogs |
| `web/src/context.ts`, `api.ts` | Shared types (`ProjectInfo`, `TocState`...) and the API client: the client/server contract |
| `installer/` | `install.ps1` / `uninstall.ps1` of the compiled version (per user, shortcuts, PATH, MCP registration) |
| `CHANGELOG.md` | Changes by version: add every user-visible change under the next version |
| `lang/*.json` | Interface texts (`en.json` is the reference and the fallback) |
| `sample/Help/` | Sample project (`Md/`, `Maps/table_of_contents.xml`, `mkdocs.yml`) used by every test |

## Commands

```
# UI (in web/)
npm install
npm run typecheck
npm test                     # Markdown round trip + language files
npm run build                # -> web/dist (committed)
npm run dev                  # hot reload on :5173, proxies to a server on :8765

# Server (repo root)
python server/app.py sample/Help/Md --port 8765 --no-window
python server/test_toc.py    # table of contents, orphans, references, deletion guard, TODOs
python server/test_export.py # export; real builds need MkDocs (MDEDITOR_MKDOCS=<python.exe of a venv with mkdocs-material>)
python server/cli.py export-html <docs> <out>   # command line exports (also export-pdf <docs> <file.pdf>)
python server/test_mcp.py    # MCP tools over stdio
python server/test_ui.py     # UI preferences and session (pure functions + HTTP, temporary APPDATA)

# End to end: real UI in headless Edge, against a COPY of sample/Help, with an
# empty APPDATA (UI state lives in settings.json; the test refuses to run otherwise)
APPDATA=<tmp> python server/app.py <copy>/Help/Md --port 8799 --no-window
cd web && node tests/e2e.mjs <copy>/Help/Md <screenshots-dir>

# Release
python build.py [--skip-web]
```

## Definition of done

Run the checks for the area you changed, and report their results:

| Changed | Run |
|---|---|
| `web/src/**` | `npm run typecheck`, `npm test`, `npm run build` (commit `web/dist`), and the e2e test for visible behavior |
| `web/src/markdown/**` or `web/src/editor/**` | Also add a case to `web/tests/roundtrip.test.ts` |
| `server/**` | `python server/test_toc.py`, `python server/test_mcp.py`, `python server/test_ui.py`, and `python server/test_export.py` (with MkDocs for `export.py`) |
| API contract | Keep `Project.info()` / `toc_state()` in sync with `ProjectInfo` / `TocState` in `context.ts`, and update `doc/api.md` |
| UI text | Keys in both `lang/en.json` and `lang/fr.json` (`npm test` checks this) |
| Visible feature | `README.md`, the matching file in `doc/`, and `CHANGELOG.md` |
| `installer/*.ps1` | Run them on a fake release folder (see `doc/build-release.md`, Installer); never against the real PATH or Claude configuration |

Check UI changes on screenshots from the e2e run, not only with the type checker.

## Invariants (never break)

- **Python standard library only.** Nothing is installed on workstations; PyInstaller runs only on the build machine. `mkdocs.yml` is read with regexes, without PyYAML.
- **Offline.** No network access at runtime. Fonts (`@fontsource`) and icons (`lucide`) are bundled.
- **Markdown output format** ([doc/markdown-format.md](doc/markdown-format.md)):
  - HTML `<img>`, never `![]()`;
  - `<a id="..."></a>` anchors, `<br>` line breaks, pipe tables;
  - `--8<-- "..."` inclusions, 4-space indentation;
  - no front matter;
  - UTF-8 without BOM, LF line endings, no trailing spaces.

  Every Markdown write goes through `normalize_markdown()`.
- **No silent data loss.**
  - Writes carry the known `mtime`; the server answers 409 `conflict` if the file changed on disk.
  - Deleting a file that something still references fails with 409 `referenced` and the list of references, unless `force` is set after the user confirms.
  - A shared snippet asks for confirmation before it is saved.
- **The table of contents XML is only edited through `server/toc.py`.** It keeps every attribute, comment, the prologue (declaration, DOCTYPE) and the BOM. An unchanged file must round-trip byte for byte.
- **Paths** in the API and the UI are POSIX and relative to the project root. `Project.resolve()` rejects anything outside the allowed roots.
- **Settings** live in `%APPDATA%\mdEditor\settings.json`, never in the documentation folder.
- The editor does not generate the MkDocs `nav` (the documentation build does) and never touches the topic XML sources.
- **Never write to `sample/` from a test**: tests work on a temporary copy.

## Pitfalls

- Rules implemented twice must stay identical:
  - snippet inclusion: `SNIPPET_RE` (`server/app.py`) and `SNIPPET_LINE` (`web/src/markdown/parser.ts`);
  - heading ids and anchors: `HEADING_ID_RE` / `markdown_anchors()` (`server/app.py`) and `web/src/markdown/anchors.ts`;
  - TODO markers: `TODO_RE` (`server/app.py`) and `web/src/editor/todo.ts`.
- When patching files from a shell heredoc, backslashes may be altered on the way (`\\` becomes `\`). Write scripts or regexes with a file-writing tool instead, and check regexes after an edit.
- A new Markdown construct needs four changes: a rule and its rendering in `parser.ts`, a node registered in `editor/create.ts`, a case in `serializer.ts`, and a round-trip test.
- Table of contents node ids are index paths (`"0.2.1"`) recomputed on every load. Always use the ids of the last state the server returned.
- `server/mcp_server.py` imports from `app.py`: changing the signature of a `Project` method breaks the MCP server.
- In the frozen executable, `sys.executable` is `mdEditor.exe`. Use `sys.frozen` / `_MEIPASS` for bundled files, and never run `sys.executable -m ...` (see `mkdocs_command()`).
- External changes are polled every 2 s (`Workspace.startWatching`). Any code path that writes an open file must go through `Workspace.save` / `saveAll` (which set `busy`) or update the known `mtime` right after writing; otherwise the editor reloads, or asks about, its own write.
- Side panels are flex columns with `overflow: auto`. Their rows need `flex: none`, otherwise rows with `overflow: hidden` collapse instead of scrolling.
- UI state must not use `localStorage`: the origin changes with the port at every launch. Use the preferences/session store (`web/src/session.ts`, saved in `settings.json`).
- The language is fixed for the page's lifetime (`boot.ts` loads it before importing `main.ts`). Changing it reloads the window.
- `web/dist` is committed and served as is. A forgotten `npm run build` ships the old UI.

## Conventions

- **English everywhere** in the repository: code, comments, docs, commit messages, server and MCP messages.
- **UI text is never hard-coded.** It goes through `t('area.key', params)` (`web/src/i18n.ts`). Use placeholders rather than string concatenation, and `<key>.one` for singular forms ([doc/i18n.md](doc/i18n.md)).
- **TypeScript:**
  - DOM built with `h()` (`web/src/ui/dom.ts`);
  - shared services go through `ctx` (`web/src/context.ts`) to avoid circular imports;
  - no semicolons, single quotes, 2-space indentation.
- **Python:** 4 spaces, type annotations, `from __future__ import annotations`. Business errors raise `ApiError` / `TocError` (HTTP) or `ToolError` (MCP).
- **Comments** are short, and explain why rather than what.

## Documentation index

| File | Read before touching |
|---|---|
| [doc/architecture.md](doc/architecture.md) | Module boundaries, open → edit → save flow, window life cycle |
| [doc/markdown-format.md](doc/markdown-format.md) | `web/src/markdown/`, `web/src/editor/` |
| [doc/snippets.md](doc/snippets.md) | Snippet paths, `base_path`, `SnippetStore` |
| [doc/toc.md](doc/toc.md) | `server/toc.py`, table of contents panel, orphans, deletion guard |
| [doc/api.md](doc/api.md) | HTTP routes, MCP tools |
| [doc/i18n.md](doc/i18n.md) | Language files, `t()` |
| [doc/build-release.md](doc/build-release.md) | `build.py`, packaging, release checklist |
