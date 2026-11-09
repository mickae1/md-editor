"""UI preferences and per-project session tests (pure functions, then HTTP).

The HTTP part starts the real server with APPDATA pointing to a temporary
folder, so the user's settings are never touched.

Usage: python server/test_ui.py
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from app import ApiError, MAX_SESSION_BYTES, get_ui_session, merge_ui_prefs, set_ui_session  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    print(f"{'ok  ' if cond else 'FAIL'} {name}{'' if cond else '  ' + str(detail)}")
    if not cond:
        failures += 1


def raises(fn, status: int) -> bool:
    try:
        fn()
    except ApiError as e:
        return e.status == status
    return False


# -- pure functions ------------------------------------------------------------
settings: dict = {}
merge_ui_prefs(settings, {"theme": "light", "panel.left.width": 320})
check("prefs merged as strings", settings["ui"] == {"theme": "light", "panel.left.width": "320"}, settings)
merge_ui_prefs(settings, {"theme": None, "side": "toc"})
check("null deletes a pref", settings["ui"] == {"panel.left.width": "320", "side": "toc"}, settings)
check("invalid pref value rejected", raises(lambda: merge_ui_prefs(settings, {"x": {"a": 1}}), 400))
check("huge prefs rejected", raises(lambda: merge_ui_prefs(settings, {"x": "a" * 70_000}), 413))
check("rejected prefs left unchanged", settings["ui"] == {"panel.left.width": "320", "side": "toc"}, settings)

check("no session yet", get_ui_session(settings, "C:/a") is None)
check("session stored", set_ui_session(settings, "C:/a", {"tabs": [{"path": "x.md", "scroll": 10}]}))
check("unchanged session not rewritten", not set_ui_session(settings, "C:/a", {"tabs": [{"path": "x.md", "scroll": 10}]}))
set_ui_session(settings, "C:/b", {"active": "y.md"})
check("sessions are per project", get_ui_session(settings, "C:/a") == {"tabs": [{"path": "x.md", "scroll": 10}]}
      and get_ui_session(settings, "C:/b") == {"active": "y.md"}, settings)
check("session too large rejected", raises(lambda: set_ui_session(settings, "C:/a", {"x": "a" * MAX_SESSION_BYTES}), 413))
check("session must be an object", raises(lambda: set_ui_session(settings, "C:/a", [1, 2]), 400))
check("project settings kept next to the session",
      set_ui_session({"projects": {"C:/a": {"snippetDir": "C:/a/s"}}}, "C:/a", {"k": 1}))

# -- HTTP ----------------------------------------------------------------------
tmp = Path(tempfile.mkdtemp(prefix="mdeditor-ui-"))
shutil.copytree(HERE.parent / "sample" / "Help", tmp / "Help")
md = (tmp / "Help" / "Md").resolve()
env = {**os.environ, "APPDATA": str(tmp / "appdata")}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(*args: str):
    port = free_port()
    proc = subprocess.Popen([sys.executable, str(HERE / "app.py"), *args, "--port", str(port), "--no-window"],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "/api/ping", timeout=1)
            return proc, base
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("server did not start")


def call(base: str, path: str, body=None, content_type="application/json", origin: str | None = None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method="GET" if body is None else "POST")
    if body is not None:
        req.add_header("Content-Type", content_type)
    if origin:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


root = md.as_posix()
proc, base = start(str(md))
try:
    status, ui = call(base, "/api/ui")
    check("GET /api/ui on a fresh profile", status == 200 and ui["prefs"] == {} and ui["session"] is None and ui["root"] == root, ui)
    call(base, "/api/ui/prefs", {"theme": "light", "side": "toc"})
    # sendBeacon posts a Blob: text/plain or no JSON content type.
    status, _ = call(base, "/api/ui/prefs", {"side": None, "panel.left.width": "333"}, content_type="text/plain;charset=UTF-8")
    check("prefs POST with a beacon content type", status == 200)
    session = {"tabs": [{"path": "index.md", "scroll": 120}], "active": "index.md", "toc": ["Workflow-CreateScenario"]}
    status, r = call(base, "/api/ui/session", {"root": root, "session": session})
    check("session saved for the current project", status == 200 and r["saved"], r)
    status, r = call(base, "/api/ui/session", {"root": "C:/elsewhere", "session": {"active": "x.md"}})
    check("late session of another folder ignored", status == 200 and not r["saved"], r)
    status, r = call(base, "/api/ui/session", {"root": root, "session": {"x": "a" * MAX_SESSION_BYTES}})
    check("oversized session rejected (413)", status == 413, (status, r))
    status, r = call(base, "/api/ui/prefs", {"theme": "dark"}, origin="https://evil.example")
    check("foreign origin rejected", status == 403, status)
    status, ui = call(base, "/api/ui")
    check("prefs merged and deleted", ui["prefs"] == {"theme": "light", "panel.left.width": "333"}, ui["prefs"])
    check("session read back", ui["session"] == session, ui["session"])
finally:
    proc.terminate()
    proc.wait()

saved = json.loads((tmp / "appdata" / "mdEditor" / "settings.json").read_text(encoding="utf-8"))
check("settings.json holds prefs and session", saved["ui"]["theme"] == "light" and saved["projects"][root]["session"] == session, saved)

# Restart without a folder, on another port: the last folder is offered once.
proc, base = start()
try:
    _, s1 = call(base, "/api/state")
    _, s2 = call(base, "/api/state")
    check("restart without folder: resume = last folder", s1["project"] is None and s1["resume"] == root, s1)
    check("resume hint given only once", s2["resume"] is None, s2)
    _, ui = call(base, "/api/ui")
    check("prefs survive a restart on another port", ui["prefs"].get("theme") == "light" and ui["session"] is None, ui)
    call(base, "/api/project/open", {"path": str(md)})
    _, ui = call(base, "/api/ui")
    check("session restored after opening the folder", ui["session"] == session, ui)
    status, r = call(base, "/api/project/close", {})
    status, r = call(base, "/api/ui/session", {"session": {"a": 1}})
    check("session ignored without a folder", status == 200 and not r["saved"], r)
finally:
    proc.terminate()
    proc.wait()

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{failures} failure(s)" if failures else "\nAll OK")
sys.exit(1 if failures else 0)
