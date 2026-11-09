"""mdEditor - local server and launcher.

Serves the web UI (web/dist) and exposes a small JSON API to read and write
the files of the documentation folder. Standard library only: no
`pip install` required.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import toc as toc_mod

if getattr(sys, "frozen", False):  # PyInstaller executable: files extracted to _MEIPASS
    APP_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    WEB_DIR = APP_DIR / "web"
else:
    APP_DIR = Path(__file__).resolve().parent.parent
    WEB_DIR = APP_DIR / "web" / "dist"
CONFIG_DIR = Path(os.environ.get("APPDATA") or Path.home() / ".config") / "mdEditor"
SETTINGS_FILE = CONFIG_DIR / "settings.json"
USER_LANG_DIR = CONFIG_DIR / "lang"
# Language files, later folders override earlier ones key by key:
# bundled, next to the executable (company-wide), then per user.
LANG_DIRS = [APP_DIR / "lang"]
if getattr(sys, "frozen", False):
    LANG_DIRS.append(Path(sys.executable).parent / "lang")
LANG_DIRS.append(USER_LANG_DIR)

IGNORED_DIRS = {".git", "node_modules", "site", "__pycache__", ".venv", "venv"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}
SNIPPET_RE = re.compile(r"""^(\s*)(;?)-+8<-+\s+(["'])([^"']+)\3\s*$""")
LINK_RE = re.compile(r"""\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)""")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
HTML_HREF_RE = re.compile(r"""<a\s[^>]*href=["']([^"'#]+\.md)(?:#[^"']*)?["']""", re.I)

mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("font/woff2", ".woff2")


# --------------------------------------------------------------------------
# Application settings
# --------------------------------------------------------------------------

def load_settings() -> dict:
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_settings(data: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# --------------------------------------------------------------------------
# Interface languages (lang/*.json)
# --------------------------------------------------------------------------

def load_languages() -> dict[str, dict[str, str]]:
    """All language files, merged by code (file name without .json)."""
    langs: dict[str, dict[str, str]] = {}
    for d in LANG_DIRS:
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict):
                langs.setdefault(f.stem.lower(), {}).update({k: v for k, v in data.items() if isinstance(v, str)})
    return langs


def pick_language(setting: str, accept: str, available) -> str:
    """Language to display: the setting, else the first match in Accept-Language, else English."""
    if setting and setting != "auto" and setting in available:
        return setting
    for part in accept.split(","):
        tag = part.split(";")[0].strip().lower()
        for code in (tag, tag.split("-")[0]):
            if code in available:
                return code
    return "en"


def posix(p: Path | str) -> str:
    return str(p).replace("\\", "/")


def rel(path: Path, start: Path) -> str:
    return posix(os.path.relpath(path, start))


def is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


# --------------------------------------------------------------------------
# Project (open documentation folder)
# --------------------------------------------------------------------------

def find_mkdocs(root: Path) -> Path | None:
    for d in [root, *root.parents][:3]:
        for name in ("mkdocs.yml", "mkdocs.yaml"):
            if (d / name).is_file():
                return d / name
    return None


def detect_base_path(mkdocs: Path | None) -> Path | None:
    """Read `pymdownx.snippets.base_path` from mkdocs.yml (simplified parsing, no PyYAML)."""
    if not mkdocs:
        return None
    try:
        text = mkdocs.read_text(encoding="utf-8")
    except OSError:
        return None
    m = re.search(r"pymdownx\.snippets\s*:\s*\n((?:[ \t]+.*\n?)+)", text)
    if not m:
        return None
    block = m.group(1)
    bm = re.search(r"base_path\s*:\s*(.+)", block)
    if not bm:
        return None
    value = bm.group(1).strip()
    if value.startswith("["):
        value = value.strip("[]").split(",")[0]
    elif not value:
        lm = re.search(r"base_path\s*:\s*\n\s*-\s*(.+)", block)
        value = lm.group(1) if lm else ""
    value = value.strip().strip("'\"")
    if not value:
        return None
    return (mkdocs.parent / value).resolve()


def detect_theme_css(mkdocs: Path | None) -> list[Path]:
    """`extra_css` files from mkdocs.yml (looked up in docs_dir, then custom_dir)."""
    if not mkdocs:
        return []
    try:
        text = mkdocs.read_text(encoding="utf-8")
    except OSError:
        return []

    def value(key: str, default: str) -> str:
        m = re.search(r"^\s*" + key + r"\s*:\s*['\"]?([^'\"\n#]+)", text, re.M)
        return m.group(1).strip() if m else default

    bases = [mkdocs.parent / value("docs_dir", "docs"), mkdocs.parent / value("custom_dir", "overrides"), mkdocs.parent]
    m = re.search(r"^extra_css\s*:\s*\n((?:[ \t]*-[ \t]*.+\n?)+)", text, re.M)
    out: list[Path] = []
    for item in re.findall(r"-[ \t]*['\"]?([^'\"\n#]+)", m.group(1)) if m else []:
        item = item.strip()
        if re.match(r"^[a-z]+://", item):
            continue
        for b in bases:
            if (b / item).is_file():
                out.append((b / item).resolve())
                break
    return out


def detect_color_schemes(mkdocs: Path | None) -> dict[str, str]:
    """Material `theme.palette` schemes from mkdocs.yml: {"dark": name, "light": name}.

    A scheme whose name contains "dark" or "slate" is the dark one, any other
    is the light one. Defaults: Material's own `slate` (dark) and `default` (light).
    """
    schemes = {"dark": "slate", "light": "default"}
    if not mkdocs:
        return schemes
    try:
        text = mkdocs.read_text(encoding="utf-8")
    except OSError:
        return schemes
    # `scheme:` only appears in theme.palette entries.
    names = re.findall(r"^\s*(?:-\s*)?scheme\s*:\s*['\"]?([\w-]+)", text, re.M)
    dark = [n for n in names if re.search(r"dark|slate", n, re.I)]
    light = [n for n in names if n not in dark]
    if dark:
        schemes["dark"] = dark[0]
    if light:
        schemes["light"] = light[0]
    return schemes


class Project:
    def __init__(self, root: Path, settings: dict):
        self.root = root.resolve()
        self.mkdocs = find_mkdocs(self.root)
        conf = settings.get("projects", {}).get(posix(self.root), {})
        detected = detect_base_path(self.mkdocs)
        self.base_path = Path(conf["basePath"]) if conf.get("basePath") else (detected or self.root)
        self.snippet_dir = Path(conf["snippetDir"]) if conf.get("snippetDir") else self.root / "_snippets"
        self.base_path = self.base_path.resolve()
        self.snippet_dir = self.snippet_dir.resolve()
        self.theme_css = detect_theme_css(self.mkdocs)
        self.color_schemes = detect_color_schemes(self.mkdocs)
        self.linked: dict[str, list[str]] = {}  # filled by scan()
        self.toc_file = Path(conf["tocFile"]).resolve() if conf.get("tocFile") else toc_mod.detect_toc(self.root, self.mkdocs)

    # -- paths -------------------------------------------------------------
    def allowed_roots(self) -> list[Path]:
        roots = [self.root, self.snippet_dir, self.base_path]
        return roots + ([self.mkdocs.parent] if self.mkdocs else [])

    def resolve(self, relpath: str) -> Path:
        p = (self.root / unquote(relpath)).resolve()
        if not any(is_within(p, r) for r in self.allowed_roots()):
            raise PermissionError(f"Path outside the project: {relpath}")
        return p

    def to_rel(self, p: Path) -> str:
        return rel(p, self.root)

    def include_to_path(self, src: str) -> Path | None:
        candidates = [src]
        stripped = re.sub(r":[^/\\:]*(:[^/\\:]*)?$", "", src)
        if stripped != src:
            candidates.append(stripped)
        for c in candidates:
            p = (self.base_path / c).resolve()
            if p.is_file():
                return p
        return (self.base_path / stripped).resolve()

    # -- listing ----------------------------------------------------------
    def walk(self, top: Path):
        for dirpath, dirnames, filenames in os.walk(top):
            dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS and not d.startswith(".")]
            for f in filenames:
                yield Path(dirpath) / f

    def files(self) -> tuple[list[dict], list[str]]:
        seen: set[Path] = set()
        md: list[dict] = []
        images: list[str] = []
        tops = [self.root]
        if not is_within(self.snippet_dir, self.root) and self.snippet_dir.is_dir():
            tops.append(self.snippet_dir)
        for top in tops:
            for p in self.walk(top):
                if p in seen:
                    continue
                seen.add(p)
                ext = p.suffix.lower()
                if ext == ".md":
                    kind = "snippet" if is_within(p, self.snippet_dir) else "topic"
                    md.append({"path": self.to_rel(p), "kind": kind, "mtime": p.stat().st_mtime})
                elif ext in IMAGE_EXT:
                    images.append(self.to_rel(p))
        md.sort(key=lambda f: f["path"].lower())
        images.sort(key=str.lower)
        return md, images

    def scan(self, md_files: list[dict]) -> tuple[dict, list[dict]]:
        """Index of snippet inclusions and broken links.

        Also fills `self.linked`: .md path (relative) -> files that link to it.
        """
        usage: dict[str, list[str]] = {}
        broken: list[dict] = []
        linked: dict[str, list[str]] = {}
        self.linked = linked
        for f in md_files:
            path = self.root / f["path"]
            try:
                lines = path.read_text(encoding="utf-8-sig").splitlines()
            except OSError:
                continue
            in_fence = False
            for n, line in enumerate(lines, 1):
                if FENCE_RE.match(line):
                    in_fence = not in_fence
                    continue
                if in_fence:
                    continue
                m = SNIPPET_RE.match(line)
                if m:
                    if m.group(2):
                        continue
                    target = self.include_to_path(m.group(4))
                    key = self.to_rel(target) if target else m.group(4)
                    usage.setdefault(key, [])
                    if f["path"] not in usage[key]:
                        usage[key].append(f["path"])
                    if not target or not target.is_file():
                        broken.append({"file": f["path"], "line": n, "target": m.group(4), "type": "snippet"})
                    continue
                for lm in LINK_RE.finditer(line):
                    href = lm.group(1)
                    if re.match(r"^[a-z]+:", href, re.I) or href.startswith("#"):
                        continue
                    target_file = href.split("#", 1)[0]
                    if not target_file.lower().endswith(".md"):
                        continue
                    target_path = (path.parent / unquote(target_file)).resolve()
                    if not target_path.is_file():
                        broken.append({"file": f["path"], "line": n, "target": href, "type": "link"})
                    else:
                        self._add_link(linked, target_path, f["path"])
                for hm in HTML_HREF_RE.finditer(line):
                    if not re.match(r"^[a-z]+:", hm.group(1), re.I):
                        self._add_link(linked, (path.parent / unquote(hm.group(1))).resolve(), f["path"])
        return usage, broken

    def _add_link(self, linked: dict[str, list[str]], target: Path, source: str):
        key = self.to_rel(target)
        if key != source and source not in linked.setdefault(key, []):
            linked[key].append(source)

    def check_unreferenced(self, data: dict):
        """Before deleting a topic from the table of contents: refuses (409 "referenced")
        if its file is still linked, included, or listed by another entry."""
        t = toc_mod.Toc(self.toc_file)
        _, el = t.get(data["id"])
        rel = toc_mod.href_to_rel(el.get("href", ""))
        if not rel or not (self.root / rel).is_file():
            return
        refs = self.references(rel)
        refs["toc"] = [r for r in refs["toc"] if r["id"] != str(data["id"])]
        refs["count"] = len(refs["links"]) + len(refs["includes"]) + len(refs["toc"])
        if refs["count"]:
            raise ApiError(409, f"{rel} is still referenced ({refs['count']})", {"code": "referenced", "references": refs})

    def delete_file(self, relpath: str, force: bool = False) -> str:
        """Deletes a .md file; refuses (409 "referenced", with the list) if something
        still points to it, unless `force`."""
        p = self.resolve(relpath)
        if p.suffix.lower() != ".md" or not p.is_file():
            raise ApiError(400, f"Not a Markdown file: {relpath}")
        refs = self.references(self.to_rel(p))
        if refs["count"] and not force:
            raise ApiError(409, f"{self.to_rel(p)} is still referenced ({refs['count']})", {"code": "referenced", "references": refs})
        os.remove(p)
        return self.to_rel(p)

    def references(self, relpath: str) -> dict:
        """Everything that points to a file: links and snippet inclusions (with line
        numbers) from the other .md files, and table of contents entries."""
        target = self.resolve(relpath)
        links: list[dict] = []
        includes: list[dict] = []
        for f in self.files()[0]:
            path = (self.root / f["path"]).resolve()
            if path == target:
                continue
            try:
                lines = path.read_text(encoding="utf-8-sig").splitlines()
            except OSError:
                continue
            in_fence = False
            for n, line in enumerate(lines, 1):
                if FENCE_RE.match(line):
                    in_fence = not in_fence
                    continue
                if in_fence:
                    continue
                m = SNIPPET_RE.match(line)
                if m:
                    if not m.group(2) and self.include_to_path(m.group(4)) == target:
                        includes.append({"file": f["path"], "line": n, "text": line.strip()[:200]})
                    continue
                hrefs = [lm.group(1) for lm in LINK_RE.finditer(line)] + HTML_HREF_RE.findall(line)
                for href in hrefs:
                    if re.match(r"^[a-z]+:", href, re.I) or href.startswith("#"):
                        continue
                    if (path.parent / unquote(href.split("#", 1)[0])).resolve() == target:
                        links.append({"file": f["path"], "line": n, "text": line.strip()[:200]})
                        break
        toc_refs: list[dict] = []
        if self.toc_file and self.toc_file.is_file():
            try:
                t = toc_mod.Toc(self.toc_file)
                for node in t.tree(self.root):
                    stack = [node]
                    while stack:
                        nd = stack.pop()
                        if nd["file"] and (self.root / nd["file"]).resolve() == target:
                            toc_refs.append({"id": nd["id"], "caption": nd["caption"]})
                        stack.extend(nd["children"])
            except toc_mod.TocError:
                pass
        return {"path": self.to_rel(target), "links": links, "includes": includes, "toc": toc_refs,
                "count": len(links) + len(includes) + len(toc_refs)}

    def orphans(self, md_files: list[dict], usage: dict[str, list[str]]) -> list[dict]:
        """Files nothing points to: topics linked from no other file and absent from the
        table of contents (the home page excepted), snippets included nowhere.
        Call after scan()."""
        in_toc: set[str] = set()
        home = {"index.md"}
        if self.toc_file and self.toc_file.is_file():
            try:
                t = toc_mod.Toc(self.toc_file)
                in_toc = t.referenced()
                if t.root.get("defaulttopic"):
                    home.add(toc_mod.href_to_rel(t.root.get("defaulttopic")).lower())
            except toc_mod.TocError:
                pass
        linked = {k.lower() for k, v in self.linked.items() if v}
        out = []
        for f in md_files:
            p = f["path"]
            if f["kind"] == "snippet":
                if not usage.get(p):
                    out.append({"file": p, "type": "snippet"})
            elif p.lower() not in linked and p.lower() not in in_toc and p.lower() not in home:
                out.append({"file": p, "type": "topic"})
        return out

    def info(self) -> dict:
        md, images = self.files()
        usage, broken = self.scan(md)
        orphans = self.orphans(md, usage)
        return {
            "root": posix(self.root),
            "name": self.root.name,
            "mkdocs": posix(self.mkdocs) if self.mkdocs else None,
            "snippetDir": self.to_rel(self.snippet_dir),
            "snippetDirAbs": posix(self.snippet_dir),
            "basePath": self.to_rel(self.base_path),
            "basePathAbs": posix(self.base_path),
            "detectedBasePath": posix(detect_base_path(self.mkdocs)) if detect_base_path(self.mkdocs) else None,
            "files": md,
            "images": images,
            "usage": usage,
            "broken": broken,
            "orphans": orphans,
            "themeCss": [self.to_rel(p) for p in self.theme_css],
            "colorSchemes": self.color_schemes,
            "tocFile": self.to_rel(self.toc_file) if self.toc_file else None,
            "tocFileAbs": posix(self.toc_file) if self.toc_file else None,
        }

    # -- table of contents ------------------------------------------------
    def toc_state(self) -> dict:
        topics = [f["path"] for f in self.files()[0] if f["kind"] == "topic"]
        return toc_mod.state(self.toc_file, self.root, topics, self.to_rel)

    def toc_edit(self, data: dict) -> dict:
        if not self.toc_file or not self.toc_file.is_file():
            raise toc_mod.TocError("No table of contents for this folder", 404)
        if data.get("op") == "delete" and not data.get("force"):
            self.check_unreferenced(data)
        result = toc_mod.edit(self.toc_file, self.root, data)
        return {**result, "toc": self.toc_state()}


# --------------------------------------------------------------------------
# Global server state
# --------------------------------------------------------------------------

class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.settings = load_settings()
        self.project: Project | None = None
        self.last_ping = time.time()
        self.had_ping = False
        self.bye_at = 0.0
        self.mkdocs_proc: subprocess.Popen | None = None
        self.mkdocs_url = ""

    def open_project(self, path: str) -> Project:
        root = Path(path).expanduser().resolve()
        if not root.is_dir():
            raise FileNotFoundError(f"Folder not found: {path}")
        with self.lock:
            self.project = Project(root, self.settings)
            recent = [r for r in self.settings.get("recent", []) if r != posix(root)]
            self.settings["recent"] = [posix(root), *recent][:10]
            save_settings(self.settings)
        return self.project

    def update_project_settings(self, snippet_dir: str | None, base_path: str | None, toc_file: str | None = None) -> Project:
        assert self.project
        root = self.project.root
        conf = self.settings.setdefault("projects", {}).setdefault(posix(root), {})
        for key, value in (("snippetDir", snippet_dir), ("basePath", base_path), ("tocFile", toc_file)):
            if value is None:
                continue
            if value == "":
                conf.pop(key, None)
            else:
                conf[key] = posix((root / value).resolve())
        save_settings(self.settings)
        self.project = Project(root, self.settings)
        return self.project


STATE = State()


def pick_folder(title: str, initial: str | None) -> str | None:
    """Open the native Windows folder picker."""
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        path = filedialog.askdirectory(parent=root, title=title, initialdir=initial or None, mustexist=True)
    finally:
        root.destroy()
    return path or None


def pick_file(title: str, initial: str | None, types: list[list[str]]) -> str | None:
    """Native Windows file picker. `types`: [["XML", "*.xml"], ...]."""
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        start = Path(initial) if initial else None
        path = filedialog.askopenfilename(
            parent=root, title=title,
            initialdir=str(start.parent if start and start.suffix else start) if start else None,
            filetypes=[tuple(t) for t in types] + [("*", "*.*")])
    finally:
        root.destroy()
    return path or None


def normalize_markdown(text: str) -> str:
    """UTF-8 without BOM, LF line endings, no trailing spaces."""
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in text.split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines) + "\n"


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    i = 2
    while True:
        cand = path.with_name(f"{path.stem}-{i}{path.suffix}")
        if not cand.exists():
            return cand
        i += 1


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, status: int, message: str, extra: dict | None = None):
        super().__init__(message)
        self.status = status
        self.extra = extra or {}


class Handler(BaseHTTPRequestHandler):
    server_version = "mdEditor/1.0"
    protocol_version = "HTTP/1.1"  # persistent connections

    def log_message(self, fmt, *args):  # quiet
        if os.environ.get("MDEDITOR_DEBUG"):
            super().log_message(fmt, *args)

    # -- helpers ---------------------------------------------------------
    def send_json(self, data, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path, cache: bool = False):
        if not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=31536000, immutable" if cache else "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def project(self) -> Project:
        if not STATE.project:
            raise ApiError(400, "No folder open")
        return STATE.project

    def check_origin(self):
        # Minimal protection: reject write requests coming from another site.
        origin = self.headers.get("Origin")
        if origin and not re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$", origin):
            raise ApiError(403, "Origin rejected")

    # -- routes -----------------------------------------------------------
    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path.startswith("/api/"):
                self.route_get(url.path, q)
            elif url.path == "/raw":
                self.send_file(self.project().resolve(q.get("path", "")))
            else:
                self.serve_static(url.path)
        except ApiError as e:
            self.send_json({"error": str(e), **e.extra}, e.status)
        except toc_mod.TocError as e:
            self.send_json({"error": str(e), "code": e.code}, e.status)
        except PermissionError as e:
            self.send_json({"error": str(e)}, 403)
        except FileNotFoundError as e:
            self.send_json({"error": str(e)}, 404)
        except Exception as e:  # pragma: no cover
            self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def do_POST(self):
        url = urlparse(self.path)
        try:
            self.check_origin()
            data = self.read_json()
            self.route_post(url.path, data)
        except ApiError as e:
            self.send_json({"error": str(e), **e.extra}, e.status)
        except toc_mod.TocError as e:
            self.send_json({"error": str(e), "code": e.code}, e.status)
        except PermissionError as e:
            self.send_json({"error": str(e)}, 403)
        except FileNotFoundError as e:
            self.send_json({"error": str(e)}, 404)
        except Exception as e:  # pragma: no cover
            self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def serve_static(self, path: str):
        rel_path = unquote(path).lstrip("/") or "index.html"
        target = (WEB_DIR / rel_path).resolve()
        if not is_within(target, WEB_DIR) or not target.is_file():
            target = WEB_DIR / "index.html"
        if not target.is_file():
            msg = "UI not built: run `npm run build` in web/".encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        self.send_file(target, cache="/assets/" in path)

    def route_get(self, path: str, q: dict):
        if path == "/api/ping":
            STATE.last_ping = time.time()
            STATE.had_ping = True
            self.send_json({"ok": True})
        elif path == "/api/state":
            self.send_json({
                "project": STATE.project.info() if STATE.project else None,
                "recent": [r for r in STATE.settings.get("recent", []) if Path(r).is_dir()],
                "mkdocsAvailable": shutil.which("mkdocs") is not None,
            })
        elif path == "/api/project":
            self.send_json(self.project().info())
        elif path == "/api/i18n":
            langs = load_languages()
            setting = STATE.settings.get("language", "auto")
            code = pick_language(setting, self.headers.get("Accept-Language", ""), langs)
            self.send_json({
                "setting": setting,
                "language": code,
                "languages": sorted(({"code": c, "name": m.get("@name", c)} for c, m in langs.items()), key=lambda x: x["name"].lower()),
                "messages": {**langs.get("en", {}), **langs.get(code, {})},
            })
        elif path == "/api/file":
            p = self.project().resolve(q.get("path", ""))
            if not p.is_file():
                raise FileNotFoundError(f"File not found: {q.get('path')}")
            self.send_json({
                "path": self.project().to_rel(p),
                "content": p.read_text(encoding="utf-8-sig").replace("\r\n", "\n"),
                "mtime": p.stat().st_mtime,
            })
        elif path == "/api/toc":
            self.send_json(self.project().toc_state())
        elif path == "/api/references":
            self.send_json(self.project().references(q.get("path", "")))
        elif path == "/api/search":
            self.send_json(self.search(q.get("q", ""), q.get("regex") == "1", q.get("case") == "1"))
        else:
            raise ApiError(404, f"Unknown route: {path}")

    def route_post(self, path: str, data: dict):
        if path == "/api/bye":
            STATE.bye_at = time.time()
            self.send_json({"ok": True})
        elif path == "/api/dialog/folder":
            self.send_json({"path": pick_folder(data.get("title") or "Choose a folder", data.get("initial"))})
        elif path == "/api/dialog/file":
            self.send_json({"path": pick_file(data.get("title") or "Choose a file", data.get("initial"), data.get("types") or [])})
        elif path == "/api/toc/edit":
            self.send_json(self.project().toc_edit(data))
        elif path == "/api/settings/language":
            STATE.settings["language"] = str(data.get("language") or "auto")
            save_settings(STATE.settings)
            self.send_json({"ok": True})
        elif path == "/api/lang/folder":
            USER_LANG_DIR.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                os.startfile(USER_LANG_DIR)  # noqa: S606 - opens Explorer
            self.send_json({"path": posix(USER_LANG_DIR)})
        elif path == "/api/project/open":
            self.send_json(STATE.open_project(data["path"]).info())
        elif path == "/api/project/close":
            STATE.project = None
            self.send_json({"ok": True})
        elif path == "/api/project/settings":
            self.project()
            self.send_json(STATE.update_project_settings(data.get("snippetDir"), data.get("basePath"), data.get("tocFile")).info())
        elif path == "/api/file":
            self.write_file(data)
        elif path == "/api/file/delete":
            self.send_json({"deleted": self.project().delete_file(data.get("path", ""), bool(data.get("force")))})
        elif path == "/api/stat":
            proj = self.project()
            out = {}
            for rp in data.get("paths", []):
                try:
                    p = proj.resolve(rp)
                    out[rp] = p.stat().st_mtime if p.is_file() else None
                except PermissionError:
                    out[rp] = None
            self.send_json(out)
        elif path == "/api/image":
            self.save_image(data)
        elif path == "/api/replace":
            self.send_json(self.replace_all(data))
        elif path == "/api/mkdocs/serve":
            self.send_json(self.mkdocs_serve())
        else:
            raise ApiError(404, f"Unknown route: {path}")

    # -- actions ----------------------------------------------------------
    def write_file(self, data: dict):
        proj = self.project()
        p = proj.resolve(data["path"])
        if data.get("create") and p.exists():
            raise ApiError(409, f"File already exists: {data['path']}", {"code": "exists"})
        expected = data.get("mtime")
        if p.exists() and expected is not None and not data.get("force"):
            if abs(p.stat().st_mtime - float(expected)) > 0.001:
                raise ApiError(409, "File modified externally", {"code": "conflict", "mtime": p.stat().st_mtime})
        p.parent.mkdir(parents=True, exist_ok=True)
        content = normalize_markdown(data.get("content", ""))
        with open(p, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        self.send_json({"path": proj.to_rel(p), "mtime": p.stat().st_mtime, "content": content})

    def save_image(self, data: dict):
        proj = self.project()
        name = re.sub(r"[^\w.\-]+", "_", Path(data.get("name") or "image.png").name)
        if Path(name).suffix.lower() not in IMAGE_EXT:
            raise ApiError(400, "Unsupported image format")
        target = unique_path(proj.resolve(posix(Path(data.get("dir") or "images") / name)))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(data["data"]))
        self.send_json({"path": proj.to_rel(target)})

    def search(self, query: str, regex: bool, case: bool) -> list[dict]:
        proj = self.project()
        if not query:
            return []
        flags = 0 if case else re.I
        pattern = re.compile(query if regex else re.escape(query), flags)
        results = []
        for f in proj.files()[0]:
            try:
                lines = (proj.root / f["path"]).read_text(encoding="utf-8-sig").splitlines()
            except OSError:
                continue
            for n, line in enumerate(lines, 1):
                if pattern.search(line):
                    results.append({"file": f["path"], "line": n, "text": line.strip()[:200]})
                    if len(results) >= 2000:
                        return results
        return results

    def replace_all(self, data: dict) -> dict:
        proj = self.project()
        flags = 0 if data.get("case") else re.I
        query = data["query"]
        pattern = re.compile(query if data.get("regex") else re.escape(query), flags)
        replacement = data.get("replacement", "")
        if not data.get("regex"):
            replacement = replacement.replace("\\", "\\\\")
        changed = []
        for rp in data.get("files", []):
            p = proj.resolve(rp)
            text = p.read_text(encoding="utf-8-sig")
            new, n = pattern.subn(replacement, text)
            if n:
                with open(p, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write(normalize_markdown(new))
                changed.append({"file": rp, "count": n})
        return {"changed": changed}

    def mkdocs_serve(self) -> dict:
        proj = self.project()
        if not proj.mkdocs:
            raise ApiError(400, "No mkdocs.yml found for this folder")
        if STATE.mkdocs_proc and STATE.mkdocs_proc.poll() is None:
            return {"url": STATE.mkdocs_url}
        port = free_port()
        cmd = [*mkdocs_command(), "serve", "-f", str(proj.mkdocs), "-a", f"127.0.0.1:{port}"]
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        STATE.mkdocs_proc = subprocess.Popen(cmd, cwd=proj.mkdocs.parent, creationflags=flags,
                                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        STATE.mkdocs_url = f"http://127.0.0.1:{port}/"
        # Wait for the server to respond (the first build can take a while).
        deadline = time.time() + 120
        while time.time() < deadline:
            if STATE.mkdocs_proc.poll() is not None:
                raise ApiError(500, "mkdocs serve stopped (is mkdocs installed?)")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    return {"url": STATE.mkdocs_url}
            except OSError:
                time.sleep(0.5)
        raise ApiError(504, "mkdocs serve is not responding")


# --------------------------------------------------------------------------
# Startup
# --------------------------------------------------------------------------

def mkdocs_command() -> list[str]:
    """How to run MkDocs: the running Python (sources), or the mkdocs / python found
    in PATH (compiled executable, where sys.executable is mdEditor.exe)."""
    if not getattr(sys, "frozen", False):
        return [sys.executable, "-m", "mkdocs"]
    if shutil.which("mkdocs"):
        return [shutil.which("mkdocs")]
    python = shutil.which("python") or shutil.which("py")
    if python:
        return [python, "-m", "mkdocs"]
    raise ApiError(400, "MkDocs not found: install it (pip install mkdocs-material) and make sure it is in PATH")


def free_port(preferred: int = 0) -> int:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", preferred))
        except OSError:
            s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def find_browser() -> str | None:
    candidates = []
    for env in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            candidates += [
                Path(base) / "Microsoft/Edge/Application/msedge.exe",
                Path(base) / "Google/Chrome/Application/chrome.exe",
            ]
    for c in candidates:
        if c.is_file():
            return str(c)
    for name in ("msedge", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    return None


def open_window(url: str) -> subprocess.Popen | None:
    browser = find_browser()
    if not browser:
        webbrowser.open(url)
        return None
    profile = CONFIG_DIR / "window-profile"
    profile.mkdir(parents=True, exist_ok=True)
    return subprocess.Popen([
        browser,
        f"--app={url}",
        f"--user-data-dir={profile}",
        "--window-size=1500,950",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
    ])


def watchdog(httpd: ThreadingHTTPServer, proc: subprocess.Popen | None):
    """Stop the server when the window is closed."""
    started = time.time()
    while True:
        time.sleep(1)
        now = time.time()
        if STATE.bye_at and now - STATE.bye_at > 4 and STATE.last_ping < STATE.bye_at:
            break  # window closed (a reload sends a ping within the delay)
        if STATE.had_ping and now - STATE.last_ping > 180:
            break  # no more signal (browser killed)
        if not STATE.had_ping and now - started > 90:
            break  # the window never connected
    if STATE.mkdocs_proc and STATE.mkdocs_proc.poll() is None:
        STATE.mkdocs_proc.terminate()
    httpd.shutdown()


def main(argv=None):
    ap = argparse.ArgumentParser(description="WYSIWYG Markdown editor for MkDocs")
    ap.add_argument("folder", nargs="?", help="documentation folder to open")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--no-window", action="store_true", help="do not open a window (development)")
    args = ap.parse_args(argv)

    if args.folder:
        STATE.open_project(args.folder)

    port = free_port(args.port)
    ThreadingHTTPServer.request_queue_size = 128  # the browser opens many connections in parallel
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    url = f"http://127.0.0.1:{port}/"
    if sys.stdout:  # missing under pythonw
        print(f"mdEditor: {url}", flush=True)

    if not args.no_window:
        proc = open_window(url)
        threading.Thread(target=watchdog, args=(httpd, proc), daemon=True).start()
    httpd.serve_forever()


if __name__ == "__main__":
    main()
