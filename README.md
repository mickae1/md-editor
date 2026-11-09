# mdEditor

**A WYSIWYG editor for MkDocs documentation, with first-class support for snippets and the site's table of contents.**

![mdEditor: table of contents tree on the left, a topic with an inline snippet in the center, the snippet library on the right](doc/images/screenshot.png)

mdEditor edits the Markdown sources of an [MkDocs](https://www.mkdocs.org/) / [Material for MkDocs](https://squidfunk.github.io/mkdocs-material/) site directly in their rendered form. It understands the pymdownx extensions used by large documentation sets, especially `--8<--` snippet inclusions, and it writes back Markdown in the exact format the existing toolchain expects.

It is built for documentation sets with hundreds of topics and reusable blocks, where the hard part is keeping includes, links and navigation consistent, rather than typing text.

- **Rendered editing.** Admonitions, tabs, collapsible blocks, tables, images and code are edited as they appear on the site.
- **Snippets as live blocks.** Included content is shown and edited in place, saved to the snippet file, and kept in sync wherever it appears.
- **Navigation editing.** The table of contents (`Maps/table_of_contents.xml`) is a tree you can drag and drop, with validation of broken entries and orphan topics.
- **Safe by default.** External-change detection, a diff before saving, and deletions that list every reference first.
- **Zero install on workstations.** One folder to copy; it runs fully offline, on a local server that only listens on `127.0.0.1`.
- **Claude integration.** An MCP server gives an AI assistant the same structured access, with the same rules.

---

## Contents

- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Using mdEditor](#using-mdeditor)
- [Configuration](#configuration)
- [Claude integration (MCP)](#claude-integration-mcp)
- [Markdown compatibility](#markdown-compatibility)
- [How it works](#how-it-works)
- [Development](#development)
- [Building a release](#building-a-release)
- [Project layout](#project-layout)
- [Known limitations](#known-limitations)
- [License](#license)

## Requirements

| | Compiled version | From source |
|---|---|---|
| OS | Windows 10/11 | Windows 10/11 (macOS/Linux work for development, without native dialogs) |
| Browser | Microsoft Edge (shipped with Windows); Chrome as a fallback | same |
| Python | — (bundled) | 3.10+, standard library only |
| MkDocs | only for *Build & Preview* | same |
| Node.js | — | only to rebuild the UI: 20.19+ or 22.12+ |

## Getting started

### Compiled version

1. Unzip `mdEditor-<version>-windows.zip` anywhere. It contains a `mdEditor/` folder with `mdEditor.exe`, `mdeditor-mcp.exe` and `_internal/` (keep them together).
2. Run `mdEditor.exe`, or `mdEditor.exe D:\path\to\Help\Md` to open a documentation folder directly.

The application starts in about half a second: nothing is unpacked at launch.

### From source

```
pythonw mdeditor.pyw                    # start screen
pythonw mdeditor.pyw D:\path\to\Help\Md # open a folder directly
```

To create Desktop and Start menu shortcuts, right-click `install-shortcut.ps1` and choose *Run with PowerShell*.

The launcher starts a local server on a free port and opens Edge in app mode (a window without an address bar). The server stops when the window is closed.

### Try it on the sample project

`sample/Help` is a small, fictional documentation set that covers every supported construct, snippets and a table of contents, including a broken entry and orphan files:

```
pythonw mdeditor.pyw sample/Help/Md
```

## Using mdEditor

### Projects

Open the documentation folder, the one that contains the `.md` topics (for example `Help/Md`), with **Open folder** (Ctrl+O) or from the recent folders on the start screen. mdEditor finds `mkdocs.yml` in that folder or up to two levels above. From it, mdEditor reads the snippet `base_path` and the theme's `extra_css`.

The left panel has four tabs:

| View | Content |
|---|---|
| **Files** | Topics grouped by file name prefix (`GeneralViews-EntityViewer-…`), snippets shown separately |
| **Search** | Project-wide search and replace, plain text or regex |
| **Links** | Broken links and snippet inclusions, and orphan files (see below) |
| **Contents** | The table of contents: the site navigation tree |

Both side panels can be resized by dragging their inner edge, or with the arrow keys once the edge has the focus. Double-click the edge to reset the width. Widths are remembered, and the editor always keeps room in a small window.

### Editing

Headings, emphasis, lists (Tab to indent), links with topic autocompletion (Ctrl+K; Ctrl+click opens the target), `<a id>` anchors, tables (rows, columns, alignment, resizing), code blocks with syntax highlighting, admonitions (`!!!`), collapsible blocks (`???`), content tabs (`===`) and raw HTML, which is preserved as is.

You can drop or paste an image. The image file is copied into `images/` and inserted as an `<img>` tag. Then you can:
- resize the image with its handle;
- double-click it to edit `src`, `alt`, the size and the title;
- right-click it for quick actions: original size, 50 %, fit to page, replace, open, copy path, delete.

### Snippets

- An included snippet (`--8<-- "_snippets/name.md"`) is shown inline with a label giving its name and how many topics use it.
- Edits made inline are saved to the snippet file, not to the topic. If the snippet is shared, you are warned first, with the list of affected topics.
- The same snippet shown in several places, in one or more tabs, stays in sync as you type.
- Double-click the label to open the snippet in its own tab.
- The **Snippets** panel (right) has search, usage counts, a preview on hover and drag-and-drop insertion. Right-click a snippet for *Show topics using it*.
- **Insert snippet** (Ctrl+Shift+I) opens a palette with a preview. **Extract to snippet** turns the selection into a new snippet file. **Detach** replaces an inclusion with its content.

### Table of contents

The site navigation lives in `Maps/table_of_contents.xml`, next to the documentation folder. mdEditor finds it automatically, or you can choose it in the project settings.

- **Tree view.** Titles with their topic IDs, sections and pages, and broken entries flagged. The topic being edited is highlighted and revealed, however it was opened.
- **Drag and drop** to reorder, move into another section, or change level. You can also drop a topic from the list of missing topics. Keyboard alternatives: Alt+arrows, and the context menu (move up/down, indent, outdent).
- **Keyboard**: Up/Down to select, Enter to open, F2 to rename, Delete to remove from the menu.
- **Rename** with F2, or by clicking the title of the selected entry. **Add topic** creates the `.md` file with its title and the menu entry in one step. You can also duplicate an entry, remove it from the menu (the file is kept), or delete the topic.
- **Validation.** Entries pointing to a missing file are flagged, and topics that are not in the table of contents are listed, ready to be added.

Every attribute and comment of the XML is preserved. The `modified` attribute is updated on a move or rename, in the format the file already uses.

### Links, orphans and safe deletion

- **Broken links**: links and inclusions whose target does not exist.
- **Orphan files**:
  - topics that no page links to and that are not in the table of contents;
  - snippets that no file includes.
- **Deleting a file** first lists everything that still points to it (links with line numbers, snippet inclusions, table of contents entries) and asks for confirmation.

### Saving and preview

- Ctrl+S saves the current tab together with the modified snippets it includes. Ctrl+Shift+S saves everything.
- If a file changed on disk (another editor, Git, Claude), you are asked before anything is overwritten. Files changed outside the editor are reloaded when the window gets the focus back.
- **Diff** shows exactly what will be written, and **Source** shows the generated Markdown.
- **Build & Preview** runs `mkdocs serve` and opens the current page in the browser.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+S / Ctrl+Shift+S | Save / save all |
| Ctrl+P | Open a topic or snippet |
| Ctrl+O | Open a folder |
| Ctrl+K | Insert or edit a link |
| Ctrl+Shift+I | Insert a snippet |
| Ctrl+Shift+F | Search in the project |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Alt+W | Close the tab |
| F2 / Delete | Rename / remove from the menu the selected table of contents entry |
| Alt+arrows | Move the selected table of contents entry (up, down, indent, outdent) |

## Configuration

mdEditor never writes configuration into the documentation folder. Settings are stored per user in `%APPDATA%\mdEditor\settings.json`.

| Setting | Where | Default |
|---|---|---|
| Snippet folder | Project settings | `<root>/_snippets` |
| Snippet `base_path` | Project settings | `pymdownx.snippets.base_path` from `mkdocs.yml`, else the root |
| Table of contents file | Project settings | `Maps/table_of_contents.xml` next to or inside the root |
| Theme (dark/light), project CSS | Theme menu | Dark; project CSS off |
| Interface language | Theme menu | Automatic (Windows language) |

### Interface language

The interface ships in English and French. Translations are plain JSON files, so you can change any text without rebuilding. Drop a `<code>.json` file in one of these folders:
- `%APPDATA%\mdEditor\lang\`, for one user. The theme menu entry *Open custom language folder…* opens it.
- a `lang\` folder next to `mdEditor.exe`, for every user of that installation.

Files are merged key by key, so a file only needs the texts it changes. A new code, such as `de.json`, adds a language. The format is described in [doc/i18n.md](doc/i18n.md).

## Claude integration (MCP)

`mdeditor-mcp.exe` (or `server/mcp_server.py`) is a [Model Context Protocol](https://modelcontextprotocol.io/) server. It lets Claude Code, Claude Desktop or any MCP client work on the documentation with the editor's rules: snippet folder and `base_path`, `<img>` tags, no front matter, UTF-8 and LF, conflict detection. It uses stdio and the standard library only, and the editor does not need to be open.

| Tool | Purpose |
|---|---|
| `set_project`, `project_info` | Open a documentation folder, show its settings |
| `list_files` | Topics and snippets, with usage counts and the `--8<--` line of each snippet |
| `read_file` | Read a file; `expand_snippets` returns the final content with snippets expanded |
| `write_file` | Write a file; refused if it changed since it was read; warns when the snippet is shared |
| `create_snippet`, `insert_snippet`, `extract_to_snippet` | Create, include and extract snippets |
| `snippet_usage`, `find_references` | What includes a snippet; everything that points to a file |
| `search`, `check_links` | Search; broken links and orphan files |
| `get_toc`, `edit_toc` | Read and edit the table of contents (deleting a referenced topic requires explicit confirmation) |

**Claude Code**

```
claude mcp add mdeditor -- "C:\path\to\mdEditor\mdeditor-mcp.exe" --root "D:\path\to\Help\Md"
```

**Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "mdeditor": {
      "command": "C:\\path\\to\\mdEditor\\mdeditor-mcp.exe",
      "args": ["--root", "D:\\path\\to\\Help\\Md"]
    }
  }
}
```

From source, use `"command": "python"` and put `server/mcp_server.py` first in `args`. Without `--root`, the server opens the folder last used in the editor, with its settings.

## Markdown compatibility

The editor parses Markdown into a document model and serializes it back. The rendered result is unchanged, and the following is guaranteed:

- images as HTML `<img src alt width height>`, never `![]()`;
- anchors as `<a id="..."></a>`, line breaks as `<br>`, pipe tables;
- `--8<-- "..."` inclusions, line and block forms (`;--8<--` disabled inclusions are kept);
- admonitions, details and tabs with 4-space indentation (Python-Markdown);
- unknown HTML preserved verbatim;
- no front matter; UTF-8 without BOM, LF line endings, no trailing spaces.

The source may be normalized on the first save of a file: table column alignment, `*italic*` instead of `_italic_`, escapes. Unmodified files are never rewritten, and the diff view shows the exact output beforehand. Details are in [doc/markdown-format.md](doc/markdown-format.md).

## How it works

```
mdEditor.exe ─► Python server (127.0.0.1, free port) ─► Edge --app window
                  │  JSON API  /api/*                     │  TypeScript UI (TipTap / ProseMirror)
                  │  static UI (web/dist)                 │  markdown-it + pymdownx rules
                  ▼
           documentation folder (Help/Md, Maps/table_of_contents.xml)
                  ▲
mdeditor-mcp.exe ─┘  stdio, same project model
```

- **Server** (`server/`): Python standard library only. It handles the project model (files, snippet usage, links, orphans), safe file writes with conflict detection, table of contents editing, and launching the window. It is shut down by a watchdog when the window closes.
- **UI** (`web/`): Vite and TypeScript, without a UI framework. A custom Markdown parser and serializer sit around TipTap nodes for each MkDocs construct. A shared store keeps every view of a snippet in sync.
- **Security**: the server only listens on `127.0.0.1` and rejects cross-origin writes. Every path is resolved against the project roots, and nothing is fetched from the network.

The architecture is described in [doc/architecture.md](doc/architecture.md).

## Development

```
cd web
npm install
npm run dev            # UI with hot reload on http://localhost:5173 (proxies the API)
```

In another terminal:

```
python server/app.py sample/Help/Md --port 8765 --no-window
```

| Check | Command | What it covers |
|---|---|---|
| Types | `npm run typecheck` (in `web/`) | TypeScript, including translation keys |
| Unit | `npm test` (in `web/`) | Markdown round trip on every sample file and on targeted cases; language files |
| Server | `python server/test_toc.py` | Table of contents read/write, every operation, orphans, references, deletion guard |
| MCP | `python server/test_mcp.py` | Every MCP tool over stdio |
| End to end | `node tests/e2e.mjs <copy>/Help/Md <screenshots>` (in `web/`) | The real UI in headless Edge, against a server on port 8799 |

The server tests run on a temporary copy of `sample/`. Run the end-to-end test against a copy too, never against `sample/` itself.

`web/dist` is committed, because it is what the application serves. Rebuild it with `npm run build` after any UI change.

Conventions and pitfalls for contributors are in [CLAUDE.md](CLAUDE.md), and the developer documentation is in [`doc/`](doc/):

| Document | Topic |
|---|---|
| [architecture.md](doc/architecture.md) | Modules, data flow, window life cycle |
| [markdown-format.md](doc/markdown-format.md) | Parser and serializer, output guarantees, adding a construct |
| [snippets.md](doc/snippets.md) | Paths and `base_path`, usage index, snippet store |
| [toc.md](doc/toc.md) | Table of contents, orphan files, deletion guard |
| [api.md](doc/api.md) | HTTP API and MCP tools |
| [i18n.md](doc/i18n.md) | Language files and `t()` |
| [build-release.md](doc/build-release.md) | Packaging and release checklist |

## Building a release

On the build machine only:

```
pip install pyinstaller
python build.py              # rebuilds the UI (Node.js), then the executables
python build.py --skip-web   # reuses web/dist
```

The output is `release/mdEditor/` (two executables sharing `_internal/`) and `release/mdEditor-<version>-windows.zip`. See [doc/build-release.md](doc/build-release.md) for the release checklist.

Unsigned PyInstaller executables are sometimes flagged by corporate antivirus software. Sign them with a company certificate or have them allow-listed.

## Project layout

```
mdeditor.pyw            launcher (no console)
server/
  app.py                HTTP server, project model, launcher, watchdog
  toc.py                table of contents (Maps/table_of_contents.xml)
  mcp_server.py         MCP server (stdio)
  test_toc.py, test_mcp.py
web/
  src/boot.ts           entry point: loads the language, then the app
  src/main.ts           layout, shortcuts, wiring
  src/markdown/         Markdown parser and serializer
  src/editor/           TipTap nodes (snippet, image, admonition, tabs, raw HTML...)
  src/snippets/         shared snippet store
  src/app/              tabs, panels (files, search, links, table of contents), dialogs
  tests/                round trip, language files, end to end
  dist/                 built UI (committed)
lang/                   interface translations (en.json, fr.json)
doc/                    developer documentation
sample/Help/            sample documentation project (Md/, Maps/, mkdocs.yml)
build.py                PyInstaller build
install-shortcut.ps1    Desktop / Start menu shortcuts (source install)
```

## Known limitations

- **Windows first.** The native folder and file dialogs and the app window rely on Windows, Edge or Chrome. Other platforms are only used for development.
- **Messages from the server and the MCP server are in English**, whatever the interface language.
- **Table of contents XML.** Entities declared in a DTD and namespace prefixes are not supported. Attributes are rewritten with double quotes.
- **Build & Preview** needs MkDocs and the site's plugins to be installed. The compiled version looks for `mkdocs` or `python` in `PATH`.
- The editor does not generate the MkDocs `nav`: it is produced from the table of contents by the documentation build.

## License

[MIT](LICENSE) © 2026 mickae1
