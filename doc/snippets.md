# Snippets

A snippet is a `.md` file included in a topic with `--8<-- "path"` (pymdownx.snippets). It is the core feature of the editor.

## Paths

| Concept | Default | Source |
|---|---|---|
| Project root | opened folder (e.g. `Help/Md`) | `Project.root` |
| `base_path` | `pymdownx.snippets.base_path` from `mkdocs.yml`, else the root | `detect_base_path()` or settings |
| Snippet folder | `<root>/_snippets` | settings |

- The path written in `--8<-- "..."` is **always relative to `base_path`**, whatever the snippet folder.
- A file is a snippet if it is under the snippet folder (`is_within` in Python, `isUnder` in TS); otherwise it is a topic.
- The snippet folder may be outside the root: `Project.files()` scans it as well.
- The `snippetDir` / `basePath` settings are stored per folder in `%APPDATA%\mdEditor\settings.json` (`projects.<root>`), never in the documentation.
- Section suffix `file.md:section`: stripped to find the file (`include_to_path`, `ctx.includePath`).

Conversions:
- Python: `Project.include_to_path(src)` → absolute path; `rel(p, base_path)` → value to write.
- TS: `ctx.includePath(src)` → project path; `ctx.includeSrc(path)` → value to write.

## Usage index

`Project.scan()` reads every `.md` file (excluding fenced code blocks) and builds:
- `usage`: snippet project path → list of files that include it;
- `broken`: inclusions pointing to a missing file and broken `.md` links.

The index is recomputed on every `GET /api/project` (reload, return to the window, F5). On ~800 files, this is a full read of the folder: avoid calling it in a loop.

## Display in the editor

- The topic only stores the `snippet` node (`src` attribute). Its NodeView (`editor/snippet.ts`) shows a label (name, number of topics, "modified" dot) and mounts a TipTap **sub-editor** in the block.
- Circular inclusions are detected via `EditorHost.ancestors` and shown as a warning.
- A missing snippet is shown empty with a warning; it is created on save if content is typed into it.
- Label actions: open in a tab (double-click), detach (replace with the content), remove the inclusion.

## `SnippetStore` (`web/src/snippets/store.ts`)

One `SnippetEntry` per file, shared by all editors that show it (several open topics, dedicated tab, several inclusions in the same topic):

- `baseline` / `current`: Markdown serialized at opening (or last save) and current; `isDirty` = they differ.
- `mount()` creates an editor from the state of a live editor, else from the JSON kept in memory, else from the file's HTML.
- `propagate()` replays the `Step`s of a transaction in the other editors (`snippet-sync` meta, outside history). On failure, it copies the whole document.
- `unmount()`: when the last editor goes away, unsaved content is kept as JSON.
- `save()` / `reload()` / `revert()` / `forget()` / `clear()`.

## Saving

- Ctrl+S on a topic also saves the modified snippets it includes (recursive `includedIn()`).
- If a modified snippet is used by more than one topic, `Workspace.save` asks for confirmation.
- Each write sends the known `mtime`: 409 if the file changed on disk, then a confirmation to overwrite.

## MCP side

`mcp_server.py` applies the same rules: `list_files` gives the `--8<--` line of each snippet, `write_file` warns if the snippet is shared, `create_snippet` / `insert_snippet` / `extract_to_snippet` compute the path relative to `base_path`, `read_file(expand_snippets=true)` expands recursively (with a guard against cycles).
The MCP server rereads the settings on every call: a change of `snippetDir` / `basePath` in the editor is taken into account.
