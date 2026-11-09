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
| `server/export.py`, `server/cli.py` | Website and PDF export with MkDocs (and Edge for the PDF); command line `mdeditor-cli`. See [build-release.md](build-release.md#exporting). |
| `server/toc.py` | Table of contents `Maps/table_of_contents.xml`: detection, reading, edits saved at once (attributes, comments and prologue kept). See [toc.md](toc.md). |
| `State` | Current project, settings (`settings.json`), window ping/bye, `mkdocs serve` process, `resume` (last folder, offered once to the UI when started without a folder). |
| `merge_ui_prefs` / `get_ui_session` / `set_ui_session` | UI state in `settings.json`: global preferences `ui` (flat string map) and `projects[<root>].session` (opaque JSON from the UI, 256 KB max). |
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
| `boot.ts` | Entry point: fetches `/api/i18n` (language and messages) and `/api/ui` (preferences, session) in parallel, imports `main.ts` and awaits its `start()`, then removes the loading overlay (or shows the error with a Reload button). |
| `loading.ts` | Loading overlay: static markup in `index.html` (shown before any script runs), `showLoading` / `hideLoading` while a folder is opened, `loadingError`. |
| `session.ts` | UI state kept by the server: `prefs` (sync `get`, debounced `set`), the session source registered by `main.ts`, saved within 1 s of a change and with `sendBeacon` on `pagehide`. One-time import of old `mdeditor.*` localStorage keys. |
| `i18n.ts` | `t('area.key', params)`: translated UI texts, current language and available languages. |
| `main.ts` | Layout, theme, keyboard shortcuts, `ctx` wiring, lifecycle (ping/bye, focus → detection of external changes), session collection and restore (`restoreSession`), `start()`. |
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
| `app/explorer.ts` | Tree by file name prefixes (`GeneralViews-EntityViewer-...`). Collapsed by default; `setActive(path, reveal)` expands the folders of a topic opened from elsewhere. |
| `app/snippetsPanel.ts` | Snippet side panel, "Show topics using it". |
| `app/toolbar.ts`, `app/commands.ts` | Toolbar and editing commands (link, anchor, table, admonition, snippet...). |
| `app/views.ts` | Search/replace, broken links, project settings, diff, Markdown preview. |
| `app/resize.ts` | Resizable side panels: drag handle, keyboard, double-click reset, width saved in the preferences (`session.ts`). |
| `ui/` | Small DOM helpers: `h()`, dialogs, palette, lucide icons. |
| `styles/` | `app.css` (application chrome), `content.css` (content rendering, close to Material for MkDocs; the project's `extra_css` can be applied on top, using the color schemes of its `mkdocs.yml`). |

## Main flow

1. **Opening a project**: the session of the folder being left is saved, the loading overlay is shown, `POST /api/project/open` → `Project.info()` (files, usages, broken links) → `ctx.setProject()` refreshes the explorer and the panel → `restoreSession()` (see below).
2. **Opening a topic**: `GET /api/file` → `markdownToHtml()` → `createEditor()`. Each `--8<--` becomes a `snippet` node whose NodeView mounts a sub-editor via `ctx.snippets.mount()`.
3. **Editing**: transactions from a snippet sub-editor are replayed in the other views of the same snippet.
4. **Saving** (`Workspace.save`): `serializeDoc()` of the topic and of the modified snippets it includes; confirmation if a snippet is used by several topics; `POST /api/file` with `mtime` (409 if modified on disk).
5. **Changes made outside the editor**: `Workspace.startWatching()` calls `checkExternalChanges()` every 2 s while the page is visible and no dialog is open, and again when the window gets the focus. It compares the `mtime` of the open topics and loaded snippets (`POST /api/stat`).
   - A file without unsaved changes is reloaded in place (`reloadTopic()` keeps the scroll position and the selection).
   - With unsaved changes, the user chooses *keep* or *reload*. *Keep* is remembered for that external version (`keptVersion`), and the next save then gets 409 `conflict` and asks before overwriting.
   - Checks are skipped while the editor saves (`busy`), so its own writes are never taken for external changes.

## UI state and session

The UI never keeps state in `localStorage`: the server listens on a new free port at every launch, so the origin, and with it `localStorage`, changes each time. Everything goes to `settings.json` through the server.

- **Preferences** (`GET /api/ui` → `prefs`, `POST /api/ui/prefs`): theme, project CSS, panel widths and visibility, last side tab. Global, flat string map. `session.ts` loads them once before `main.ts` runs, so reads are synchronous.
- **Session** of the current folder (`POST /api/ui/session` with `{root, session}`; the server ignores it if `root` is no longer the open folder, e.g. a late beacon):

  ```
  { tabs: [{path, scroll, sel: [from, to]}], active, explorer: [folder keys], toc: [node hrefs], tocOrphans, side }
  ```

  `main.ts` saves it within a second of a change (tabs, scroll of the active tab, tree toggles, side tab) and with `sendBeacon` on `pagehide`. It is not saved while a session is being restored or before the first restore (an empty workspace would overwrite it).
- **Restore** (`restoreSession`): tree states first, then the tabs are reopened in order (files deleted since are skipped), the saved tab is activated, and each tab is scrolled back when it is first shown: after layout, after its images load and at 300 ms, until the user scrolls or clicks. `restoring` disables the reveal of the active topic in the trees, so the expanded nodes are exactly the saved ones.
- **Startup**: started with a folder, the server opens it and the UI restores its session. Started without one, `/api/state` returns `resume` (the most recent folder, if it still exists) once, and the UI opens it. The loading overlay stays until the active tab is rendered.

