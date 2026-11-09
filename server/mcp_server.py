"""mdEditor - MCP (Model Context Protocol) server over stdio.

Gives an assistant (Claude Code, Claude Desktop...) structured access to the
documentation: topics, snippets, usages, search, broken links.
Same rules as the editor: the project's snippet folder and base_path,
Markdown written as UTF-8 without BOM, LF, no front matter.

Usage:
    python server/mcp_server.py [--root MD_FOLDER]
Without --root: MDEDITOR_ROOT variable, else the last folder opened in the editor.
Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import (  # noqa: E402
    ApiError, SNIPPET_RE, Project, is_within, load_settings, normalize_markdown, posix, rel,
)
import toc as toc_mod  # noqa: E402

PROTOCOL_VERSION = "2025-06-18"
SERVER_INFO = {"name": "mdeditor", "version": "1.0.0"}

INSTRUCTIONS = """MkDocs (pymdownx) documentation edited with mdEditor.
- Paths are relative to the documentation folder (e.g. GeneralViews-Map.md, _snippets/snippets-map.md).
- A snippet is included by a `--8<-- "path"` line (path relative to base_path). Editing a snippet changes ALL the topics that include it: check `snippet_usage` before `write_file`.
- Required format: images as <img src alt width height> (never ![]()), anchors <a id="..."></a>, line breaks <br>, pipe tables, 4-space indentation in lists/admonitions, no YAML front matter.
- Use `read_file` with `expand_snippets` to see the final content of a topic.
- Pass `expected_mtime` (returned by read_file) to write_file so as not to overwrite a change made in the meantime.
- The site navigation is the table of contents (Maps/table_of_contents.xml): read it with `get_toc`, change it only with `edit_toc` (never write the XML by hand). A new topic is not visible in the site until it is in the table of contents: use `edit_toc` with op=add and create=true to create the file and its menu entry at once. Node ids change after every edit: use the ids of the last `get_toc`/`edit_toc` result."""


class ToolError(Exception):
    pass


def describe_references(refs: dict) -> list[str]:
    """One line per reference, from Project.references()."""
    return ([f"{r['file']}:{r['line']} (link)" for r in refs["links"]]
            + [f"{r['file']}:{r['line']} (snippet inclusion)" for r in refs["includes"]]
            + [f"table of contents: {r['caption']} (id {r['id']})" for r in refs["toc"]])


class Server:
    def __init__(self, root: str | None):
        self.project: Project | None = None
        root = root or os.environ.get("MDEDITOR_ROOT")
        if not root:
            recent = load_settings().get("recent", [])
            root = next((r for r in recent if Path(r).is_dir()), None)
        if root:
            self.open(root)

    # -- project ----------------------------------------------------------
    def open(self, path: str) -> Project:
        p = Path(path).expanduser().resolve()
        if not p.is_dir():
            raise ToolError(f"Folder not found: {path}")
        # Reload settings on every open: the editor may have changed them.
        self.project = Project(p, load_settings())
        return self.project

    def proj(self) -> Project:
        if not self.project:
            raise ToolError("No documentation folder: call set_project(path) first.")
        # Pick up settings changed in the editor.
        return Project(self.project.root, load_settings())

    def md_path(self, proj: Project, path: str) -> Path:
        if not path or not path.lower().endswith(".md"):
            raise ToolError("The path must point to a .md file")
        try:
            return proj.resolve(path.replace("\\", "/"))
        except PermissionError as e:
            raise ToolError(str(e))

    def include_src(self, proj: Project, p: Path) -> str:
        return rel(p, proj.base_path)

    def is_snippet(self, proj: Project, p: Path) -> bool:
        return is_within(p, proj.snippet_dir)

    def usage(self, proj: Project) -> dict[str, list[str]]:
        return proj.scan(proj.files()[0])[0]

    # -- tools ------------------------------------------------------------
    def t_set_project(self, path: str):
        proj = self.open(path)
        return self.t_project_info() | {"opened": posix(proj.root)}

    def t_project_info(self):
        proj = self.proj()
        md, images = proj.files()
        return {
            "root": posix(proj.root),
            "mkdocs": posix(proj.mkdocs) if proj.mkdocs else None,
            "snippetDir": proj.to_rel(proj.snippet_dir),
            "basePath": proj.to_rel(proj.base_path),
            "topics": sum(1 for f in md if f["kind"] == "topic"),
            "snippets": sum(1 for f in md if f["kind"] == "snippet"),
            "images": len(images),
        }

    def t_list_files(self, kind: str = "all", filter: str = ""):
        proj = self.proj()
        md = proj.files()[0]
        usage = self.usage(proj) if kind != "topic" else {}
        words = filter.lower().split()
        out = []
        for f in md:
            if kind != "all" and f["kind"] != kind:
                continue
            if words and not all(w in f["path"].lower() for w in words):
                continue
            item = {"path": f["path"], "kind": f["kind"]}
            if f["kind"] == "snippet":
                item["usedBy"] = len(usage.get(f["path"], []))
                item["include"] = f'--8<-- "{self.include_src(proj, proj.root / f["path"])}"'
            out.append(item)
        return {"count": len(out), "files": out}

    def t_read_file(self, path: str, expand_snippets: bool = False):
        proj = self.proj()
        p = self.md_path(proj, path)
        if not p.is_file():
            raise ToolError(f"File not found: {path}")
        content = p.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
        result = {"path": proj.to_rel(p), "mtime": p.stat().st_mtime, "content": content}
        if self.is_snippet(proj, p):
            result["usedBy"] = self.usage(proj).get(proj.to_rel(p), [])
        if expand_snippets:
            result["expanded"] = self.expand(proj, content, [p])
        return result

    def expand(self, proj: Project, content: str, stack: list[Path]) -> str:
        out = []
        for line in content.split("\n"):
            m = SNIPPET_RE.match(line)
            if not m or m.group(2):
                out.append(line)
                continue
            indent, src = m.group(1), m.group(4)
            target = proj.include_to_path(src)
            if not target or not target.is_file():
                out.append(f"{indent}<!-- snippet not found: {src} -->")
                continue
            if target in stack:
                out.append(f"{indent}<!-- circular inclusion: {src} -->")
                continue
            inner = self.expand(proj, target.read_text(encoding="utf-8-sig").replace("\r\n", "\n").rstrip("\n"), [*stack, target])
            out.append(f"{indent}<!-- snippet start: {src} -->")
            out.extend(indent + l if l else "" for l in inner.split("\n"))
            out.append(f"{indent}<!-- snippet end: {src} -->")
        return "\n".join(out)

    def write(self, proj: Project, p: Path, content: str, expected_mtime: float | None, create: bool) -> dict:
        if re.match(r"^\ufeff?---\s*\n", content):
            raise ToolError("YAML front matter is not allowed in these files.")
        if re.search(r"!\[[^\]]*\]\([^)]+\)", content):
            raise ToolError("Markdown images ![]() are not allowed: use <img src=\"...\" alt=\"...\" width=\"...\" height=\"...\">.")
        if create and p.exists():
            raise ToolError(f"File already exists: {proj.to_rel(p)}")
        if p.exists() and expected_mtime is not None and abs(p.stat().st_mtime - float(expected_mtime)) > 0.001:
            raise ToolError("The file has changed since it was read (different mtime). Read the file again before writing.")
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(normalize_markdown(content))
        result = {"path": proj.to_rel(p), "mtime": p.stat().st_mtime}
        if self.is_snippet(proj, p):
            users = self.usage(proj).get(proj.to_rel(p), [])
            result["usedBy"] = users
            if len(users) > 1:
                result["warning"] = f"Shared snippet: the change applies to {len(users)} topics."
        return result

    def t_write_file(self, path: str, content: str, expected_mtime: float | None = None):
        proj = self.proj()
        p = self.md_path(proj, path)
        return self.write(proj, p, content, expected_mtime, create=False)

    def t_create_snippet(self, name: str, content: str = ""):
        proj = self.proj()
        name = name.strip().removesuffix(".md")
        if not re.fullmatch(r"[\w./-]+", name) or ".." in name:
            raise ToolError("Invalid snippet name (letters, digits, - _ . /).")
        p = (proj.snippet_dir / f"{name}.md").resolve()
        if not is_within(p, proj.snippet_dir):
            raise ToolError("The snippet must be inside the snippet folder.")
        result = self.write(proj, p, content, None, create=True)
        result["include"] = f'--8<-- "{self.include_src(proj, p)}"'
        return result

    def t_snippet_usage(self, path: str):
        proj = self.proj()
        p = self.md_path(proj, path)
        key = proj.to_rel(p)
        users = self.usage(proj).get(key, [])
        return {"snippet": key, "include": f'--8<-- "{self.include_src(proj, p)}"', "usedBy": users, "count": len(users)}

    def t_insert_snippet(self, topic: str, snippet: str, line: int | None = None, expected_mtime: float | None = None):
        proj = self.proj()
        tp = self.md_path(proj, topic)
        sp = self.md_path(proj, snippet)
        if not tp.is_file():
            raise ToolError(f"Topic not found: {topic}")
        if not sp.is_file():
            raise ToolError(f"Snippet not found: {snippet}")
        lines = tp.read_text(encoding="utf-8-sig").replace("\r\n", "\n").rstrip("\n").split("\n")
        include = f'--8<-- "{self.include_src(proj, sp)}"'
        at = len(lines) if line is None else max(0, min(len(lines), line - 1))
        # Block surrounded by blank lines
        block = [include]
        if at > 0 and lines[at - 1].strip():
            block.insert(0, "")
        if at < len(lines) and lines[at].strip():
            block.append("")
        lines[at:at] = block
        return self.write(proj, tp, "\n".join(lines), expected_mtime, create=False) | {"inserted": include, "line": at + 1 + (1 if block[0] == "" else 0)}

    def t_extract_to_snippet(self, path: str, start_line: int, end_line: int, name: str, expected_mtime: float | None = None):
        proj = self.proj()
        p = self.md_path(proj, path)
        lines = p.read_text(encoding="utf-8-sig").replace("\r\n", "\n").rstrip("\n").split("\n")
        if not (1 <= start_line <= end_line <= len(lines)):
            raise ToolError(f"Invalid lines (the file has {len(lines)} lines).")
        chunk = lines[start_line - 1:end_line]
        indents = [len(l) - len(l.lstrip(" ")) for l in chunk if l.strip()]
        if not indents:
            raise ToolError("The selected lines are empty.")
        indent = min(indents)
        body = "\n".join(l[indent:] if l.strip() else "" for l in chunk)
        created = self.t_create_snippet(name, body)
        block = [" " * indent + created["include"]]
        if start_line > 1 and lines[start_line - 2].strip():
            block.insert(0, "")
        if end_line < len(lines) and lines[end_line].strip():
            block.append("")
        lines[start_line - 1:end_line] = block
        written = self.write(proj, p, "\n".join(lines), expected_mtime, create=False)
        return {"snippet": created["path"], "include": created["include"], "topic": written["path"], "mtime": written["mtime"]}

    def t_search(self, query: str, regex: bool = False, case_sensitive: bool = False, kind: str = "all"):
        proj = self.proj()
        if not query:
            raise ToolError("Empty query")
        try:
            pattern = re.compile(query if regex else re.escape(query), 0 if case_sensitive else re.I)
        except re.error as e:
            raise ToolError(f"Invalid regular expression: {e}")
        hits = []
        for f in proj.files()[0]:
            if kind != "all" and f["kind"] != kind:
                continue
            for n, line in enumerate((proj.root / f["path"]).read_text(encoding="utf-8-sig").splitlines(), 1):
                if pattern.search(line):
                    hits.append({"file": f["path"], "line": n, "text": line.strip()[:200]})
                    if len(hits) >= 500:
                        return {"truncated": True, "count": len(hits), "hits": hits}
        return {"truncated": False, "count": len(hits), "hits": hits}

    def t_find_references(self, path: str):
        proj = self.proj()
        try:
            return proj.references(path.replace("\\", "/"))
        except PermissionError as e:
            raise ToolError(str(e))

    def t_get_toc(self):
        proj = self.proj()
        try:
            st = proj.toc_state()
        except toc_mod.TocError as e:
            raise ToolError(str(e))
        if not st["path"]:
            raise ToolError("No table of contents found (expected Maps/table_of_contents.xml next to the documentation folder).")

        def slim(nodes):
            return [{"id": n["id"], "caption": n["caption"], "href": n["href"],
                     **({} if n["exists"] or not n["href"] else {"broken": True}),
                     **({"children": slim(n["children"])} if n["children"] else {})} for n in nodes]
        return {"path": st["path"], "mtime": st["mtime"], "tree": slim(st["tree"]), "broken": st["broken"], "orphans": st["orphans"]}

    def t_edit_toc(self, op: str, id: str | None = None, target: str | None = None, position: str | None = None,
                   caption: str | None = None, href: str | None = None, create: bool = False,
                   keep_children: bool = False, expected_mtime: float | None = None, force: bool = False):
        proj = self.proj()
        data = {"op": op, "id": id, "target": target, "caption": caption, "href": href, "create": create,
                "keepChildren": keep_children, "mtime": expected_mtime, "force": force}
        if position:
            data["position"] = position
        try:
            result = proj.toc_edit(data)
        except toc_mod.TocError as e:
            raise ToolError(str(e))
        except KeyError as e:
            raise ToolError(f"Missing argument for {op}: {e.args[0]}")
        except ApiError as e:
            refs = e.extra.get("references")
            if not refs:
                raise ToolError(str(e))
            raise ToolError(f"{e} - not deleted. Referenced by:\n" + "\n".join(describe_references(refs)) +
                            "\nAsk the user before deleting; then call again with force=true (the references will become broken).")
        out = self.t_get_toc()
        return {"created": result["created"], "deleted": result["deleted"], **out}

    def t_check_links(self):
        proj = self.proj()
        md = proj.files()[0]
        usage, broken = proj.scan(md)
        orphans = proj.orphans(md, usage)
        return {"count": len(broken), "broken": broken, "orphans": orphans}


def schema(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


STR = {"type": "string"}
INT = {"type": "integer"}
NUM = {"type": "number"}
BOOL = {"type": "boolean"}
KIND = {"type": "string", "enum": ["all", "topic", "snippet"]}
MTIME = {"type": "number", "description": "mtime returned by read_file; the write is refused if the file has changed since."}

TOOLS = [
    ("set_project", "Open a documentation folder (e.g. D:/.../Help/Md).", schema({"path": STR}, ["path"]), False),
    ("project_info", "Open folder, snippet folder, base_path, number of topics/snippets.", schema({}), True),
    ("list_files", "List topics and/or snippets (with usage count and include line for snippets).",
     schema({"kind": KIND, "filter": {"type": "string", "description": "words to find in the path"}}), True),
    ("read_file", "Read a .md file. expand_snippets=true adds the final content with snippets expanded.",
     schema({"path": STR, "expand_snippets": BOOL}, ["path"]), True),
    ("write_file", "Replace the content of an existing .md file (topic or snippet). For a snippet, the change affects every topic that includes it.",
     schema({"path": STR, "content": STR, "expected_mtime": MTIME}, ["path", "content"]), False),
    ("create_snippet", "Create a new snippet in the snippet folder and return the --8<-- line to insert.",
     schema({"name": {"type": "string", "description": "name without .md, e.g. snippet-export-csv"}, "content": STR}, ["name"]), False),
    ("snippet_usage", "Topics (and snippets) that include a snippet.", schema({"path": STR}, ["path"]), True),
    ("insert_snippet", "Insert a --8<-- inclusion of a snippet into a topic, before the given line (1 = start) or at the end.",
     schema({"topic": STR, "snippet": STR, "line": INT, "expected_mtime": MTIME}, ["topic", "snippet"]), False),
    ("extract_to_snippet", "Move lines start_line..end_line of a file into a new snippet and replace them with its inclusion.",
     schema({"path": STR, "start_line": INT, "end_line": INT, "name": STR, "expected_mtime": MTIME}, ["path", "start_line", "end_line", "name"]), False),
    ("search", "Text (or regex) search in the project's .md files.",
     schema({"query": STR, "regex": BOOL, "case_sensitive": BOOL, "kind": KIND}, ["query"]), True),
    ("check_links", "Broken internal links and snippet inclusions, and orphan files: topics linked from no other file and absent from the table of contents, snippets included nowhere.", schema({}), True),
    ("find_references", "Everything that points to a file: links and snippet inclusions (file and line) from the other pages, and table of contents entries. Check it before deleting or renaming a file.",
     schema({"path": STR}, ["path"]), True),
    ("get_toc", "Table of contents (site navigation): tree of nodes {id, caption, href, children}, broken nodes, orphan topics not in the menu.", schema({}), True),
    ("edit_toc", "Edit the table of contents and save it. op: move (id, target, position before|after|inside), rename (id, caption), "
                 "add (target or none for the root end, position, caption, href = topic ID, create = create the .md file with '# caption'), "
                 "duplicate (id, caption, href of the copy), remove (id, keep_children: remove from the menu, file kept), "
                 "delete (id, keep_children: remove from the menu AND delete the .md file; refused with the list of references if other pages still link to it, unless force=true).",
     schema({"op": {"type": "string", "enum": ["move", "rename", "add", "duplicate", "remove", "delete"]},
             "id": STR, "target": STR, "position": {"type": "string", "enum": ["before", "after", "inside"]},
             "caption": STR, "href": {"type": "string", "description": "topic ID: .md file name without extension, e.g. Workflow-ImportData"},
             "create": BOOL, "keep_children": BOOL,
             "force": {"type": "boolean", "description": "delete: delete the file even if other pages still reference it (only after the user confirmed)."},
             "expected_mtime": {"type": "number", "description": "mtime returned by get_toc; refuses the edit if the XML changed since."}},
            ["op"]), False),
]


def tool_list():
    return [{
        "name": name,
        "description": desc,
        "inputSchema": sch,
        "annotations": {"readOnlyHint": ro, "destructiveHint": False, "openWorldHint": False},
    } for name, desc, sch, ro in TOOLS]


def handle(server: Server, msg: dict) -> dict | None:
    method = msg.get("method")
    mid = msg.get("id")
    if mid is None:  # notification
        return None
    try:
        if method == "initialize":
            requested = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL_VERSION
            result = {
                "protocolVersion": requested,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": SERVER_INFO,
                "instructions": INSTRUCTIONS,
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": tool_list()}
        elif method == "tools/call":
            params = msg.get("params") or {}
            name = params.get("name", "")
            fn = getattr(server, f"t_{name}", None)
            if not fn or name not in {t[0] for t in TOOLS}:
                return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"Unknown tool: {name}"}}
            try:
                data = fn(**(params.get("arguments") or {}))
                result = {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=1)}], "structuredContent": data, "isError": False}
            except (ToolError, TypeError, OSError) as e:
                result = {"content": [{"type": "text", "text": f"Error: {e}"}], "isError": True}
        else:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Unknown method: {method}"}}
    except Exception as e:  # pragma: no cover
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": f"{type(e).__name__}: {e}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def main(argv=None):
    ap = argparse.ArgumentParser(description="mdEditor MCP server (stdio)")
    ap.add_argument("--root", help="documentation folder (e.g. Help/Md)")
    args = ap.parse_args(argv)
    server = Server(args.root)
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    for raw in stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw.decode("utf-8"))
        except ValueError:
            resp = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid JSON"}}
        else:
            msgs = msg if isinstance(msg, list) else [msg]
            out = [r for r in (handle(server, m) for m in msgs) if r is not None]
            resp = (out if isinstance(msg, list) else out[0]) if out else None
        if resp is not None:
            stdout.write((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))
            stdout.flush()


if __name__ == "__main__":
    main()
