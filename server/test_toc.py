"""Table of contents tests (server/toc.py) on a copy of the sample project.

Usage: python server/test_toc.py
"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import toc  # noqa: E402
from app import ApiError, Project  # noqa: E402

tmp = Path(tempfile.mkdtemp(prefix="mdeditor-toc-"))
shutil.copytree(HERE.parent / "sample" / "Help", tmp / "Help")
md = (tmp / "Help" / "Md").resolve()
xml = (tmp / "Help" / "Maps" / "table_of_contents.xml").resolve()
original = xml.read_text(encoding="utf-8")
failures = 0


def check(name, cond, detail=""):
    global failures
    print(f"{'ok  ' if cond else 'FAIL'} {name}{'' if cond else '  ' + str(detail)}")
    if not cond:
        failures += 1


def state():
    return Project(md, {}).toc_state()


def edit(**data):
    return toc.edit(xml, md, {"mtime": xml.stat().st_mtime, **data})


def find(tree, caption):
    for n in tree:
        if n["caption"] == caption:
            return n
        hit = find(n["children"], caption)
        if hit:
            return hit
    return None


# 1. Detection, reading, validation
proj = Project(md, {})
check("TOC detected in Help/Maps", proj.toc_file == xml, proj.toc_file)
s = state()
check("TOC path relative to the root", s["path"] == "../Maps/table_of_contents.xml", s["path"])
check("3 root nodes", [n["caption"] for n in s["tree"]] == ["Welcome", "General views", "Create a scenario"])
check("nesting", [n["caption"] for n in find(s["tree"], "Entity viewer")["children"]] == ["Analysis overview", "Charts"])
check("broken href flagged", find(s["tree"], "Import data")["exists"] is False and s["broken"] == 1)
check("orphan topic listed", s["orphans"] == ["Methodologies-Capacity.md"], s["orphans"])
check("save without change is byte-identical", toc.Toc(xml).serialize() == original)

# 2. Rename: caption changed, attributes kept, modified updated
n = find(s["tree"], "Charts")
edit(op="rename", id=n["id"], caption="Charts and graphs")
text = xml.read_text(encoding="utf-8")
check("rename written", '<caption translate="true">Charts and graphs</caption>' in text)
el = re.search(r'<topicref [^>]*href="GeneralViews-EntityViewer-Analysis-Charts"[^>]*>', text).group(0)
check("attributes kept", 'id="toc-006"' in el and 'build="all"' in el and 'type="topic"' in el, el)
check("modified updated in the same format", re.search(r'modified="(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)"', el)
      and 'modified="2025-03-14T09:12:00"' not in el, el)
check("comment kept", "<!-- Analysis pages -->" in text and text.startswith('<?xml version="1.0" encoding="UTF-8"?>\n<!-- Navigation'))
check("2-space indentation", "\n    <topicref" in text and "\t" not in text)

# 3. Move: into another section, before a node, refused into itself
s = state()
edit(op="move", id=find(s["tree"], "Basic editors")["id"], target=find(s["tree"], "Create a scenario")["id"], position="inside")
s = state()
check("move inside", [c["caption"] for c in find(s["tree"], "Create a scenario")["children"]] == ["Import data", "Basic editors"])
edit(op="move", id=find(s["tree"], "Create a scenario")["id"], target=find(s["tree"], "Welcome")["id"], position="before")
s = state()
check("move before (with children)", [n["caption"] for n in s["tree"]] == ["Create a scenario", "Welcome", "General views"]
      and len(s["tree"][0]["children"]) == 2)
try:
    edit(op="move", id=find(s["tree"], "General views")["id"], target=find(s["tree"], "Charts and graphs")["id"], position="inside")
    check("move into own descendant refused", False)
except toc.TocError:
    check("move into own descendant refused", True)

# 4. Add: new topic file + node with generated id
s = state()
r = edit(op="add", target=find(s["tree"], "General views")["id"], position="inside", caption="Layers", href="GeneralViews-Layers", create=True)
s = state()
layers = find(s["tree"], "Layers")
check("add: file created with title", r["created"] == "GeneralViews-Layers.md" and (md / "GeneralViews-Layers.md").read_text(encoding="utf-8") == "# Layers\n")
check("add: node at the end of the section", find(s["tree"], "General views")["children"][-1]["caption"] == "Layers")
check("add: id generated in the file style", layers["attrs"].get("id") == "toc-009" and layers["attrs"].get("build") == "all", layers["attrs"])
try:
    edit(op="add", target=None, caption="Again", href="GeneralViews-Layers", create=True)
    check("add: existing file refused", False)
except toc.TocError as e:
    check("add: existing file refused", e.code == "exists")
try:
    edit(op="add", target=None, caption="Bad", href="../outside", create=True)
    check("add: invalid topic ID refused", False)
except toc.TocError:
    check("add: invalid topic ID refused", True)

# 5. Orphan added to the menu (existing file)
edit(op="add", target=None, caption="Capacity", href="Methodologies-Capacity", create=False)
check("orphan added", state()["orphans"] == [])

# 6. Duplicate
s = state()
r = edit(op="duplicate", id=find(s["tree"], "Layers")["id"], caption="Layers (copy)", href="GeneralViews-Layers-copy")
s = state()
gv = [c["caption"] for c in find(s["tree"], "General views")["children"]]
check("duplicate: inserted after the source", gv[-2:] == ["Layers", "Layers (copy)"], gv)
check("duplicate: file copied", (md / "GeneralViews-Layers-copy.md").read_text(encoding="utf-8") == "# Layers\n")

# 7. Remove from the menu: file kept, children moved up
s = state()
ev = find(s["tree"], "Entity viewer")
edit(op="remove", id=ev["id"], keepChildren=True)
s = state()
check("remove: children moved up", [c["caption"] for c in find(s["tree"], "General views")["children"]][:2] == ["Analysis overview", "Charts and graphs"])
check("remove: file kept", (md / "GeneralViews-EntityViewer-Filters.md").is_file())
check("remove: file becomes an orphan", "GeneralViews-EntityViewer-Filters.md" in s["orphans"])

# 8. Delete: node and file removed
r = edit(op="delete", id=find(s["tree"], "Layers (copy)")["id"], keepChildren=False)
check("delete: file removed", r["deleted"] == "GeneralViews-Layers-copy.md" and not (md / "GeneralViews-Layers-copy.md").exists())
check("delete: node removed", find(state()["tree"], "Layers (copy)") is None)

# 9. Conflict when the file changed since it was read
try:
    toc.edit(xml, md, {"mtime": 1.0, "op": "rename", "id": "0", "caption": "X"})
    check("conflict detected", False)
except toc.TocError as e:
    check("conflict detected", e.status == 409 and e.code == "conflict")

# 10. Formats of generated attributes
check("modified: epoch ms", re.fullmatch(r"\d{13}", toc._now_like("1700000000000")))
check("modified: ISO with Z", toc._now_like("2025-01-01T10:00:00Z").endswith("Z"))
check("id: UUID", re.fullmatch(r"[0-9a-f-]{36}", toc._new_id(["3f2b8c1e-0000-4000-8000-000000000000"]) or ""))
check("id: numbers with padding", toc._new_id(["t007", "t012"]) == "t013")

# 11. Orphan files: neither linked nor in the table of contents
def orphan_files():
    p = Project(md, {})
    files = p.files()[0]
    usage, _ = p.scan(files)
    return sorted(o["file"] for o in p.orphans(files, usage))

check("orphans: removed and unlinked page", "GeneralViews-EntityViewer-Filters.md" in orphan_files(), orphan_files())
with open(md / "index.md", "a", encoding="utf-8", newline="\n") as fh:
    fh.write('\n<a href="GeneralViews-EntityViewer-Filters.md#top">Filters</a>\n')
check("orphans: an HTML link is enough", "GeneralViews-EntityViewer-Filters.md" not in orphan_files(), orphan_files())
check("orphans: unused snippet", "_snippets/snippet-unused.md" in orphan_files())
check("orphans: home page never orphan", "index.md" not in orphan_files())

# 12. References and deletion guard
proj = Project(md, {})
r = proj.references("GeneralViews-BasicEditors.md")
check("references: link with line", [(x["file"], x["line"]) for x in r["links"]] == [("GeneralViews-Map.md", 13)], r)
check("references: table of contents entry", [x["caption"] for x in r["toc"]] == ["Basic editors"], r["toc"])
r = proj.references("_snippets/snippets-map.md")
check("references: snippet inclusions", sorted(x["file"] for x in r["includes"]) == ["GeneralViews-EntityViewer-Analysis-Overview.md", "GeneralViews-Map.md"], r)

try:
    proj.delete_file("GeneralViews-BasicEditors.md")
    check("delete_file: refused when referenced", False)
except ApiError as e:
    check("delete_file: refused when referenced", e.status == 409 and e.extra["code"] == "referenced"
          and e.extra["references"]["count"] == 2 and (md / "GeneralViews-BasicEditors.md").is_file())

be = find(proj.toc_state()["tree"], "Basic editors")
try:
    proj.toc_edit({"op": "delete", "id": be["id"], "keepChildren": False, "mtime": xml.stat().st_mtime})
    check("toc delete: refused when linked elsewhere", False)
except ApiError as e:
    refs = e.extra["references"]
    check("toc delete: refused when linked elsewhere", e.extra["code"] == "referenced" and len(refs["links"]) == 1
          and refs["toc"] == [], refs)
check("toc delete: nothing changed", find(proj.toc_state()["tree"], "Basic editors") is not None)

r = proj.toc_edit({"op": "delete", "id": be["id"], "keepChildren": False, "mtime": xml.stat().st_mtime, "force": True})
check("toc delete: forced", r["deleted"] == "GeneralViews-BasicEditors.md" and not (md / "GeneralViews-BasicEditors.md").exists())
(md / "Unused.md").write_text("# Unused\n", encoding="utf-8")
check("delete_file: unreferenced file deleted without force", proj.delete_file("Unused.md") == "Unused.md" and not (md / "Unused.md").exists())

# 13. Material color schemes read from mkdocs.yml (used to apply the project CSS)
from app import detect_color_schemes  # noqa: E402
check("color schemes from mkdocs.yml", detect_color_schemes(tmp / "Help" / "mkdocs.yml") == {"dark": "sample-dark", "light": "sample-light"})
check("color schemes: Material defaults", detect_color_schemes(None) == {"dark": "slate", "light": "default"})
yml = tmp / "material.yml"
yml.write_text("theme:\n  name: material\n  palette:\n    - scheme: default\n      primary: indigo\n    - scheme: slate\n", encoding="utf-8")
check("color schemes: default + slate", detect_color_schemes(yml) == {"dark": "slate", "light": "default"})

# 14. TODO markers
from app import TODO_RE  # noqa: E402
check("TODO: whole word, case sensitive", [bool(TODO_RE.search(x)) for x in ["TODO: x", "a TODO.", "(TODO)", "todo", "Todo", "TODOS", "MYTODO", "TODO_1"]]
      == [True, True, True, False, False, False, False, False])
(md / "Notes.md").write_text("# Notes\n\nTODO one\n\n```\nTODO in code\n```\n\n<!-- TODO two -->\n", encoding="utf-8")
notes = [(x["line"], x["column"]) for x in Project(md, {}).todos() if x["file"] == "Notes.md"]
check("TODO: lines and columns, fenced code skipped", notes == [(3, 1), (9, 6)], notes)

# 15. No table of contents
other = tmp / "Empty"
other.mkdir()
check("no TOC: empty state", Project(other, {}).toc_state()["path"] is None)

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{failures} failure(s)" if failures else "\nAll OK")
sys.exit(1 if failures else 0)
