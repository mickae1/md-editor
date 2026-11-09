# Changelog

All notable changes to mdEditor. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **HTML comments** (`<!-- ... -->`) are shown as what they are: notes visible in the editor only, never on the site.
  - A comment on its own lines is an editable comment block.
  - A comment inside a paragraph is a small tag, edited with a click.
  - TODOs inside comments are highlighted, and a click in the TODO panel selects them.
  - Comments are saved as read; a `-->` typed in the text is neutralized so that it cannot end the comment early.
- Developer tools to measure performance on a large project: `tools/make_big_project.py`, `web/tests/perf.mjs`, `perf-profile.mjs`, `perf-open.mjs`.

### Changed

- **Large projects are much faster.** Measured on 600 topics and 210 snippets:
  - project analysis (start, return to the window, after a save): 5.7 s → 0.2 s. Links are resolved without disk access, and each file is re-read only when it changed;
  - reference check before a deletion: 4.4 s → 0.3 s;
  - typing in a 1,500-line page: about 78 ms → 17 ms per key, because blocks outside the screen are no longer laid out;
  - TODO tab: 690 ms → 125 ms. Pages are collapsed by default, and the hidden list is no longer redrawn on every reload.

## [1.1.0] - 2026-11-09

### Added

- **Website export**:
  - one `.html` file per `.md` file, with the same name (`GeneralViews-Map.md` becomes `GeneralViews-Map.html`);
  - navigation from the table of contents, and a generated **Contents** page first in the menu (`contents.html`, or `index.html` when the project has no `index.md`);
  - the documentation folder is never modified, and an output folder that is not empty and does not hold a previous export is refused.
- **PDF export**: the whole documentation in the order of the table of contents. The contents are on the first page, then one page per topic, and links between pages work inside the PDF.
- **Command line** (`mdeditor-cli.exe`, or `python server/cli.py`): `export-html <docs> <folder>` and `export-pdf <docs> <file.pdf>`, with exit codes for build scripts.
- **Heading anchor ids** (`## Title { #id }`):
  - the id is no longer part of the editable title; a discreet badge shows it;
  - right-click the heading to add, change or remove it, or to copy a link to it;
  - it is saved as `{ #id }`, and `{#id}` keeps its spelling.
- **Anchor suggestions** in the link dialog: type `#` (this page) or `Page.md#` (another page) to list the explicit ids and the ids MkDocs generates from the headings.
- **TODO markers**: the word `TODO` (upper case, whole word) is highlighted. The **TODO** tab lists every TODO of the project by page, and a click opens the page on it. MCP tool `list_todos`.
- **Session**: on the next start, the editor reopens where you left it: open tabs, active tab, scroll positions, expanded tree nodes, side tab, panel widths. It also reopens the last folder.
- **Loading screen** while the project opens, so that clicks are not lost during startup.
- **Changes made outside the editor** (Claude, Git, another program) are detected every 2 seconds, not only when the window gets the focus back.
  - Without unsaved changes, the file is reloaded in place; the scroll position and the cursor are kept.
  - With unsaved changes, you choose *Keep my changes* or *Reload and lose my changes*. If you keep them, saving later asks before overwriting the other version.
- **Installer** for the compiled version (`install.ps1` / `uninstall.ps1`):
  - per-user installation without administrator rights;
  - shortcuts, and `mdeditor-cli` added to the `PATH`;
  - optional registration of the MCP server in Claude Code and Claude Desktop.
- `MDEDITOR_MKDOCS` environment variable: the `mkdocs.exe` or `python.exe` to use for previews and exports.

### Changed

- **Links keep the form they were written in**:
  - autolinks (`<https://...>`, `<name@host>`, `<mailto:...>`) are no longer rewritten as `[text](target)`;
  - HTML links (`<a href="mailto:...">`) are now editable links instead of raw HTML;
  - Ctrl+click on a `mailto:` link opens the mail program.
- Both tree views (Files, Contents) start fully collapsed; the topic you open is revealed.
- With five side tabs, only the active one shows its label when the panel is narrow (all keep their tooltip).

### Fixed

- UI preferences (theme, panel widths, side tab) were lost at every start, because the window origin changes with the port. They are now stored in `%APPDATA%\mdEditor\settings.json`.
- Pressing Enter in the middle of a heading duplicated its anchor id.
- *Build & Preview* could not start MkDocs from the compiled executable.
- A background check for external changes could stay stuck on a lost request; it now gives up after 5 seconds.

## [1.0.0] - 2026-11-09

First public version.

### Added

- **WYSIWYG editing** of MkDocs / pymdownx Markdown:
  - headings, lists, links, `<a id>` anchors, tables, code blocks;
  - admonitions, collapsible blocks, content tabs, raw HTML;
  - `<img>` images with resizing and a context menu.
- **Snippets** (`--8<--`) shown and edited inline, saved to their own file and kept in sync everywhere, with a warning before saving a shared snippet, a snippet panel, insertion and extraction.
- **Table of contents** (`Maps/table_of_contents.xml`) editing: tree view, drag and drop, rename, add, duplicate, remove or delete topics. Every attribute and comment of the XML is kept.
- **Broken links and orphan files** (topics linked from nowhere and absent from the table of contents, snippets included nowhere).
- **Safe deletion**: everything that still points to a file is listed before it is deleted.
- **Diff** before saving, *Build & Preview* (`mkdocs serve`), project-wide search and replace.
- **Interface in English and French**; custom language files in `%APPDATA%\mdEditor\lang`.
- **MCP server** for Claude (`mdeditor-mcp.exe`) with the same rules as the editor.
- **Compiled version**: no Python needed on workstations, startup in about half a second.
- Resizable side panels.

[Unreleased]: https://github.com/mickae1/md-editor/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/mickae1/md-editor/compare/35150ec...v1.1.0
[1.0.0]: https://github.com/mickae1/md-editor/commit/35150ec
