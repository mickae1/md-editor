# Architecture

## Overview

```
mdeditor.pyw ──> server/app.py ── HTTP 127.0.0.1:<free port> ──> Edge --app=<url>
                     │                                              │
                     │  /api/*  (JSON)   <───────────────────────── web/dist (TipTap)
                     │  /raw?path=...  (images, project CSS)
                     │  /*  static files from web/dist
                     ▼
               documentation folder (Help/Md)
                     ▲
server/mcp_server.py ┘  (stdio, for Claude; reuses Project from app.py)
```

- `mdeditor.pyw`: console-less launcher; adds `server/` to `sys.path` and calls `app.main()`.
- `server/app.py`: HTTP server (`ThreadingHTTPServer`), global `STATE`, `Project` class, Edge window launch and watchdog.
- `server/mcp_server.py`: JSON-RPC MCP server over stdio, independent of the UI.
- `web/`: Vite + TypeScript application, built into `web/dist`.
- `lang/`: interface language files (`en.json`, `fr.json`), see [i18n.md](i18n.md).

## Server (`server/app.py`)

| Element | Role |
|---|---|
| `Project` | Root, `mkdocs.yml` found (folder or up to 2 parents), `base_path`, `snippet_dir`, `extra_css` CSS. `files()` lists `.md` files and images, `scan()` builds the snippet usage index, the link index and the list of broken links, `orphans()` lists the files nothing points to, `info()` sends everything to the client. `toc_state()` / `toc_edit()` delegate to `toc.py`. |
| `server/toc.py` | Table of contents `Maps/table_of_contents.xml`: detection, reading, edits saved at once (attributes, comments and prologue kept). See [toc.md](toc.md). |
| `State` | Current project, settings (`settings.json`), window ping/bye, `mkdocs serve` process. |
| `Handler` | `GET`/`POST` routes (see [api.md](api.md)). Errors are converted to JSON (`ApiError`, `PermissionError` → 403, `FileNotFoundError` → 404). |
| `load_languages` / `pick_language` | Load and merge the `lang/*.json` files (bundled, then next to the executable, then `%APPDATA%\mdEditor\lang`); choose the language from the setting, else `Accept-Language`, else English. |
| `pick_folder` | Native folder picker via `tkinter`. |
| `open_window` / `watchdog` | Opens Edge (else Chrome, else the default browser) with a dedicated profile; stops the server when the window is closed. |

### Window lifecycle

- The UI sends `GET /api/ping` every 20 s and `POST /api/bye` (sendBeacon) on `pagehide`.
- The watchdog stops the server if: `bye` was received and no ping arrived within the next 4 s (a reload sends a ping), no ping for 180 s, or no connection within 90 s after startup.
- With `--no-window` (development), there is no window and no watchdog.

### Security

- Listens on `127.0.0.1` only.
- `check_origin()` rejects `POST` requests whose `Origin` header is not `127.0.0.1`/`localhost`.
- `Project.resolve()` only accepts paths under the root, the snippet folder, `base_path` or the `mkdocs.yml` folder.

## UI (`web/src`)

| Folder / file | Role |
|---|---|
| `boot.ts` | Entry point: fetches `/api/i18n` (language and messages), then imports `main.ts`. |
| `i18n.ts` | `t('area.key', params)`: translated UI texts, current language and available languages. |
| `main.ts` | Layout, theme, keyboard shortcuts, `ctx` wiring, lifecycle (ping/bye, focus → detection of external changes). |
| `context.ts` | Shared `ctx` object (project, `SnippetStore`, active editor, resolution of include and image paths). Filled by `main.ts`. |
| `api.ts` | Server calls; `writeFile` handles the 409 conflict with a confirmation. |
| `paths.ts` | POSIX path functions (`normalize`, `join`, `relative`, `isUnder`...). |
| `markdown/parser.ts` | Markdown → annotated HTML (`data-*`) via markdown-it + pymdownx rules. |
| `markdown/serializer.ts` | ProseMirror document → Markdown in the mandatory format. |
| `editor/create.ts` | TipTap editor factory (same extension set for topics and snippets), drag and drop/paste of images and snippets. |
| `editor/nodes.ts` | Nodes: admonition, tabs, anchor, raw HTML, code block (lowlight), cells with alignment. |
| `editor/snippet.ts` | `snippet` node and its NodeView, which mounts a sub-editor. |
| `editor/image.ts`, `editor/links.ts` | Resizable `<img>` image, internal links (Ctrl+click, resolution). |
| `snippets/store.ts` | Shared snippet state (see [snippets.md](snippets.md)). |
| `app/workspace.ts` | Tabs, saving, "shared snippet" warning, external changes. |
| `app/explorer.ts` | Tree by file name prefixes (`GeneralViews-EntityViewer-...`). |
| `app/snippetsPanel.ts` | Snippet side panel, "Show topics using it". |
| `app/toolbar.ts`, `app/commands.ts` | Toolbar and editing commands (link, anchor, table, admonition, snippet...). |
| `app/views.ts` | Search/replace, broken links, project settings, diff, Markdown preview. |
| `ui/` | Small DOM helpers: `h()`, dialogs, palette, lucide icons. |
| `styles/` | `app.css` (application chrome), `content.css` (content rendering, close to Material for MkDocs; the project's `extra_css` can be applied on top, using the color schemes of its `mkdocs.yml`). |

## Main flow

1. **Opening a project**: `POST /api/project/open` → `Project.info()` (files, usages, broken links) → `ctx.setProject()` refreshes the explorer and the panel.
2. **Opening a topic**: `GET /api/file` → `markdownToHtml()` → `createEditor()`. Each `--8<--` becomes a `snippet` node whose NodeView mounts a sub-editor via `ctx.snippets.mount()`.
3. **Editing**: transactions from a snippet sub-editor are replayed in the other views of the same snippet.
4. **Saving** (`Workspace.save`): `serializeDoc()` of the topic and of the modified snippets it includes; confirmation if a snippet is used by several topics; `POST /api/file` with `mtime` (409 if modified on disk).
5. **Returning to the window**: `checkExternalChanges()` compares the `mtime` values (`POST /api/stat`) and offers to reload.
