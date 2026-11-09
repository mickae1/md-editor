# Table of contents and orphan files

## Table of contents (`Maps/table_of_contents.xml`)

The site navigation is a tree of nested `<topicref>` elements:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<map defaulttopic="index">
  <topicref type="topic" href="GeneralViews-Map" id="toc-002" build="all" modified="2025-03-14T09:12:00">
    <caption translate="true">General views</caption>
    <topicref type="topic" href="GeneralViews-BasicEditors" ...>
      <caption translate="true">Basic editors</caption>
    </topicref>
  </topicref>
</map>
```

- `href` is the topic ID: the `.md` file name without extension, relative to the documentation folder (`href_to_rel`).
- `<caption>` is the menu title. If there is no caption, the `navtitle` attribute is used, otherwise the `href`.
- `<topichead>` (a section without a page) is handled like `<topicref>`. Other elements stay in place.
- The XML file is converted to the `nav:` of `mkdocs.yml` by the build, not by the editor.

### Location

`detect_toc()` looks for `Maps/table_of_contents.xml` in these places, in order:
1. next to the documentation folder (`Help/Maps` for `Help/Md`);
2. inside the documentation folder;
3. next to `mkdocs.yml`.

The project settings can force another file (`tocFile`, stored per folder in `settings.json`; an empty value means automatic).

### Reading and saving (`server/toc.py`)

- Parsed with `xml.etree.ElementTree`. Comments and processing instructions are kept (`TreeBuilder(insert_comments=True, insert_pis=True)`).
- The text before the root element (XML declaration, DOCTYPE, comments) and after it is kept verbatim. So is the BOM, if present.
- Every attribute is kept, in its original order.
- Saving re-indents with 2 spaces (`ET.indent`), UTF-8, LF. A file that is already indented this way is rewritten byte for byte (tested).
- Limits:
  - attributes are rewritten with double quotes;
  - entities defined in a DTD and namespace prefixes are not supported.

### Operations (`toc.edit`)

Each operation reloads the file, checks the `mtime` sent by the client (409 `conflict` if the XML changed on disk), applies the change and saves at once.

| op | Effect |
|---|---|
| `move` | `id` before/after/inside `target` (inside = last child). Refused into itself or a descendant. |
| `rename` | New caption. |
| `add` | New node at `target`/`position` (no target = end of the root). With `create`, creates `<href>.md` containing `# <caption>` (409 `exists` if present). Without `create`: existing file, used for orphans. |
| `duplicate` | Copies the file to the given `href` and inserts the node after the source. Children are not copied. |
| `remove` | Removes the node from the menu; the file is kept. |
| `delete` | Removes the node and deletes its `.md`, unless another node still references it. |

For `remove` and `delete`, `keepChildren` moves the children up to the node's place. Without it, the whole subtree leaves the menu, but only the node's own file is deleted.

Nodes are addressed by their index path among node children (`"0"`, `"0.2.1"`). These paths change after every edit, so the client always uses the ids of the last state it received.

### Generated attributes

The format is copied from the existing file, because the expected formats are not specified:
- `modified`: updated on `move` and `rename`, and set on new nodes, but only if the file already uses this attribute. The format follows the first existing value: ISO date and time (with `Z` or an offset), date only, epoch seconds or epoch milliseconds.
- `id` of a new node: UUID if the existing ids are UUIDs, otherwise prefix + number (`toc-009` after `toc-008`, same padding). No `id` if the file has none.
- `type="topic"`. `build` is copied from the reference node (sibling or parent). The attributes of the first `<caption>` (e.g. `translate="true"`) are copied too.

## Orphan files

`Project.orphans()` (after `scan()`) lists the files that nothing points to:
- **topic**: linked from no other file, through a Markdown link `[x](File.md)` or an HTML `<a href="File.md">`, **and** absent from the table of contents. `index.md` and the map's `defaulttopic` are never orphans.
- **snippet**: included by no file.

The result is in `ProjectInfo.orphans` (Links panel) and in the `check_links` MCP tool.

This is not the same list as `TocState.orphans` (Contents panel): that one holds the topics absent from the table of contents, even when they are linked.

## Deleting a file

A `.md` file is never deleted silently while something still points to it.
- `Project.references(path)` lists the links (Markdown and HTML, with file and line) and the snippet inclusions from the other pages, plus the table of contents entries.
- `Project.delete_file()` and the table of contents `delete` (`Project.toc_edit`) refuse with 409 `referenced` and the list of references, unless `force` is set. For `delete`, the entry being deleted is not counted.
- The interface first shows the list (links, inclusions, entries, each one clickable) and asks for confirmation. *Delete anyway* sends `force`, and the references then appear as broken links.
- MCP: `find_references`. `edit_toc op=delete` refuses with the list; the instructions ask Claude to get the user's confirmation before calling again with `force=true`.

## Interface

- *Contents* panel (`web/src/app/toc.ts`): tree, drag and drop, inline rename (F2), context menu (add, duplicate, move, remove, delete), list of topics not in the table of contents, highlight of the active topic.
- *Links* panel: broken links and orphan files.
- Project settings: choice of the table of contents file.

## MCP

- `get_toc`: tree `{id, caption, href, children}`, broken nodes and topics not in the table of contents.
- `edit_toc`: the same operations as above, with the same rules.
- The MCP instructions ask Claude to add every new topic to the table of contents (`op=add`, `create=true`).

## Tests

- `python server/test_toc.py`: detection, byte-for-byte round trip, every operation, generated attributes, conflict, orphans. Runs on a copy of `sample/Help`.
- `python server/test_mcp.py`: `get_toc`, `edit_toc`, orphans in `check_links`.
- `web/tests/e2e.mjs`: panel, drag and drop, rename, add, orphans.
