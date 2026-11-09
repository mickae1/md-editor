"""Test the MCP server on a copy of the sample project.

Usage: python server/test_mcp.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
tmp = Path(tempfile.mkdtemp(prefix="mdeditor-mcp-"))
shutil.copytree(HERE.parent / "sample" / "Help", tmp / "Help")
root = tmp / "Help" / "Md"

# MDEDITOR_MCP_EXE=release/mdeditor-mcp.exe to test the compiled version
cmd = [os.environ["MDEDITOR_MCP_EXE"]] if os.environ.get("MDEDITOR_MCP_EXE") else [sys.executable, str(HERE / "mcp_server.py")]
proc = subprocess.Popen([*cmd, "--root", str(root)],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE)
next_id = 0
failures = 0


def rpc(method, params=None, notify=False):
    global next_id
    msg = {"jsonrpc": "2.0", "method": method, "params": params or {}}
    if not notify:
        next_id += 1
        msg["id"] = next_id
    proc.stdin.write((json.dumps(msg) + "\n").encode())
    proc.stdin.flush()
    if notify:
        return None
    return json.loads(proc.stdout.readline())


def call(_tool, **args):
    r = rpc("tools/call", {"name": _tool, "arguments": args})["result"]
    return r.get("structuredContent"), r["isError"], r["content"][0]["text"]


def check(name, cond, detail=""):
    global failures
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"))
    failures += 0 if cond else 1


init = rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})
check("initialize", init["result"]["serverInfo"]["name"] == "mdeditor")
rpc("notifications/initialized", notify=True)
tools = [t["name"] for t in rpc("tools/list")["result"]["tools"]]
check("15 tools", len(tools) == 15, tools)

info, err, _ = call("project_info")
check("project_info", not err and info["topics"] == 8 and info["snippets"] == 4, info)

snips, _, _ = call("list_files", kind="snippet")
m = {f["path"]: f for f in snips["files"]}
check("list_files snippets + usage", m["_snippets/snippets-map.md"]["usedBy"] == 2)

f, _, _ = call("read_file", path="GeneralViews-Map.md", expand_snippets=True)
check("read_file expand", "snippet start: _snippets/snippets-map.md" in f["expanded"] and "<img src=" in f["expanded"])

u, _, _ = call("snippet_usage", path="_snippets/snippet-basiceditors-copy.md")
check("snippet_usage", sorted(u["usedBy"]) == ["GeneralViews-BasicEditors.md", "Workflow-CreateScenario.md"], u)

w, err, _ = call("write_file", path="_snippets/snippets-map.md", content="## Map\n\nNew text\n", expected_mtime=0)
check("write_file rejects stale mtime", err)
s, _, _ = call("read_file", path="_snippets/snippets-map.md")
w, err, _ = call("write_file", path="_snippets/snippets-map.md", content="## Map\r\n\r\nNew text   \r\n", expected_mtime=s["mtime"])
check("write_file shared snippet -> warning", not err and "warning" in w, w)
check("LF / trailing space normalization", (root / "_snippets/snippets-map.md").read_bytes() == b"## Map\n\nNew text\n")
_, err, txt = call("write_file", path="index.md", content="---\ntitle: x\n---\n# A\n")
check("front matter rejected", err, txt)
_, err, txt = call("write_file", path="index.md", content="# A\n\n![x](images/a.png)\n")
check("image ![]() rejected", err, txt)
_, err, _ = call("write_file", path="../../evil.md", content="x")
check("path outside project rejected", err)

c, err, _ = call("create_snippet", name="snippet-test", content="Text of the **test**.")
check("create_snippet", not err and c["include"] == '--8<-- "_snippets/snippet-test.md"', c)
i, err, _ = call("insert_snippet", topic="Methodologies-Capacity.md", snippet="_snippets/snippet-test.md")
topic = (root / "Methodologies-Capacity.md").read_text(encoding="utf-8")
check("insert_snippet", not err and topic.endswith('\n\n--8<-- "_snippets/snippet-test.md"\n'), topic)

e, err, _ = call("extract_to_snippet", path="GeneralViews-BasicEditors.md", start_line=10, end_line=12, name="snippet-steps")
basic = (root / "GeneralViews-BasicEditors.md").read_text(encoding="utf-8")
steps = (root / "_snippets/snippet-steps.md").read_text(encoding="utf-8")
check("extract_to_snippet", not err and '--8<-- "_snippets/snippet-steps.md"' in basic and steps.startswith("1. Open"), f"{e}\n{basic}")

r, _, _ = call("search", query="simulation", kind="topic")
check("search", r["count"] >= 1, r)
b, _, _ = call("check_links")
check("check_links", b["count"] == 1 and b["broken"][0]["target"] == "GeneralViews-Inexistant.md", b)
orph = sorted(o["file"] for o in b["orphans"])
check("check_links orphans", orph == ["Methodologies-Capacity.md", "_snippets/snippet-unused.md"], b["orphans"])

tc, err, _ = call("get_toc")
check("get_toc", not err and [n["caption"] for n in tc["tree"]] == ["Welcome", "General views", "Create a scenario"]
      and tc["broken"] == 1 and "Methodologies-Capacity.md" in tc["orphans"], tc)
e, err, _ = call("edit_toc", op="add", target=tc["tree"][2]["id"], position="inside", caption="Export results",
                 href="Workflow-ExportResults", create=True, expected_mtime=tc["mtime"])
xml = (root.parent / "Maps" / "table_of_contents.xml").read_text(encoding="utf-8")
check("edit_toc add", not err and e["created"] == "Workflow-ExportResults.md" and (root / "Workflow-ExportResults.md").is_file()
      and '<caption translate="true">Export results</caption>' in xml, e)
_, err, txt = call("edit_toc", op="rename", id="0", caption="Home", expected_mtime=1.0)
check("edit_toc conflict refused", err and "modified outside" in txt, txt)

td, err, _ = call("list_todos")
check("list_todos: case sensitive, code blocks excluded, HTML comments included",
      not err and [(x["file"], x["line"]) for x in td["todos"]] == [("Workflow-CreateScenario.md", 8), ("Workflow-CreateScenario.md", 10)], td)
td, _, _ = call("list_todos", filter="product")
check("list_todos filter", td["count"] == 1 and "product team" in td["todos"][0]["text"], td)

fr, err, _ = call("find_references", path="GeneralViews-BasicEditors.md")
check("find_references", not err and fr["count"] == 2 and fr["links"][0]["file"] == "GeneralViews-Map.md", fr)
tc, _, _ = call("get_toc")
be = next(c for c in tc["tree"][1]["children"] if c["caption"] == "Basic editors")
_, err, txt = call("edit_toc", op="delete", id=be["id"], expected_mtime=tc["mtime"])
check("edit_toc delete refused with references", err and "GeneralViews-Map.md:13 (link)" in txt
      and (root / "GeneralViews-BasicEditors.md").is_file(), txt)

r = rpc("tools/call", {"name": "unknown", "arguments": {}})
check("unknown tool -> error", "error" in r)

proc.stdin.close()
proc.wait(timeout=5)
shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{failures} failure(s)" if failures else "\nAll OK")
sys.exit(1 if failures else 0)
