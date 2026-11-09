"""Table of contents: read and edit Maps/table_of_contents.xml.

The navigation is a tree of nested <topicref> (and <topichead>) elements:

    <map defaulttopic="Welcome-page">
      <topicref type="topic" href="Welcome-page" id="..." modified="...">
        <caption translate="true">Welcome</caption>
        <topicref ...>...</topicref>
      </topicref>
    </map>

`href` is the topic ID: the .md file name without extension, relative to the
documentation folder. Every other attribute and element is kept as is; the
text before the root element (XML declaration, DOCTYPE, comments) is kept
verbatim. Saving re-indents with 2 spaces, UTF-8, LF.

Nodes are addressed by their index path among node children ("0", "0.2.1"),
recomputed on every load; edits are guarded by the file mtime.
Standard library only.
"""
from __future__ import annotations

import os
import re
import time
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

NODE_TAGS = ("topicref", "topichead")
TOC_NAMES = ("table_of_contents.xml",)
TOPIC_ID_RE = re.compile(r"^[\w][\w.\-]*(/[\w][\w.\-]*)*$")


class TocError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = ""):
        super().__init__(message)
        self.status = status
        self.code = code


def detect_toc(root: Path, mkdocs: Path | None) -> Path | None:
    """Maps/table_of_contents.xml next to the documentation folder (Help/Maps), inside it, or next to mkdocs.yml."""
    dirs = [root.parent, root] + ([mkdocs.parent] if mkdocs else [])
    for d in dirs:
        for name in TOC_NAMES:
            p = d / "Maps" / name
            if p.is_file():
                return p.resolve()
    return None


def href_to_rel(href: str) -> str | None:
    """Topic ID -> .md path relative to the documentation folder (None for external links)."""
    href = (href or "").split("#", 1)[0].strip().replace("\\", "/")
    if not href or re.match(r"^[a-z]+:", href, re.I):
        return None
    return href if href.lower().endswith(".md") else href + ".md"


def rel_to_href(rel: str) -> str:
    return rel[:-3] if rel.lower().endswith(".md") else rel


# --------------------------------------------------------------------------
# Attribute formats copied from the existing file
# --------------------------------------------------------------------------

def _now_like(sample: str | None) -> str:
    """Current time in the same format as an existing `modified` value."""
    now = datetime.now().astimezone()
    if not sample:
        return now.strftime("%Y-%m-%dT%H:%M:%S")
    if re.fullmatch(r"\d{13}", sample):
        return str(int(time.time() * 1000))
    if re.fullmatch(r"\d{10}", sample):
        return str(int(time.time()))
    if re.fullmatch(r"\d{4}-\d\d-\d\d", sample):
        return now.strftime("%Y-%m-%d")
    m = re.fullmatch(r"\d{4}-\d\d-\d\d([T ])\d\d:\d\d(:\d\d)?(\.\d+)?(Z|[+-]\d\d:?\d\d)?", sample)
    if m:
        sep, secs, frac, tz = m.groups()
        base = now.astimezone(timezone.utc) if tz == "Z" else now
        fmt = f"%Y-%m-%d{sep}%H:%M" + (":%S" if secs else "")
        s = base.strftime(fmt)
        if frac:
            s += f".{base.microsecond:06d}"[: len(frac)]
        if tz == "Z":
            s += "Z"
        elif tz:
            off = base.strftime("%z")
            s += off[:3] + ":" + off[3:] if ":" in tz else off
        return s
    return now.strftime("%Y-%m-%dT%H:%M:%S")


def _new_id(existing: list[str]) -> str | None:
    """New `id` in the style of the existing ones (UUID, prefix + number), or None."""
    if not existing:
        return None
    sample = existing[0]
    if re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", sample):
        u = str(uuid.uuid4())
        return u.upper() if sample.isupper() else u
    m = re.fullmatch(r"(.*?)(\d+)", sample)
    if m:
        prefix, digits = m.groups()
        numbers = [int(mm.group(1)) for v in existing if (mm := re.fullmatch(re.escape(prefix) + r"(\d+)", v))]
        return f"{prefix}{max(numbers, default=0) + 1:0{len(digits)}d}"
    return None


# --------------------------------------------------------------------------
# Document
# --------------------------------------------------------------------------

class Toc:
    def __init__(self, path: Path):
        self.path = path
        raw = path.read_bytes()
        self.bom = raw.startswith(b"\xef\xbb\xbf")
        text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
        start = re.search(r"<(?![?!])", text)
        if not start:
            raise TocError(f"No root element in {path.name}")
        self.prologue = text[: start.start()]
        parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True, insert_pis=True))
        try:
            parser.feed(text)
            self.root = parser.close()
        except ET.ParseError as e:
            raise TocError(f"Invalid XML in {path.name}: {e}")
        end = text.rfind(f"</{self.root.tag}>")
        self.epilogue = text[end + len(self.root.tag) + 3:].strip("\n") if end >= 0 else ""
        self.mtime = path.stat().st_mtime

    # -- tree -------------------------------------------------------------
    @staticmethod
    def children(el: ET.Element) -> list[ET.Element]:
        return [c for c in el if c.tag in NODE_TAGS]

    def all_nodes(self) -> list[ET.Element]:
        return [el for el in self.root.iter() if el.tag in NODE_TAGS]

    def get(self, node_id: str) -> tuple[ET.Element, ET.Element]:
        """(parent, element) for an index path."""
        parent = self.root
        try:
            parts = [int(p) for p in str(node_id).split(".")]
            for i, n in enumerate(parts):
                el = self.children(parent)[n]
                if i == len(parts) - 1:
                    return parent, el
                parent = el
        except (ValueError, IndexError):
            pass
        raise TocError(f"Unknown table of contents node: {node_id}", 404)

    @staticmethod
    def caption(el: ET.Element) -> str:
        c = el.find("caption")
        if c is not None and (c.text or "").strip():
            return " ".join(c.text.split())
        return el.get("navtitle") or el.get("href") or ""

    def tree(self, md_root: Path) -> list[dict]:
        def walk(el: ET.Element, prefix: str) -> list[dict]:
            out = []
            for i, c in enumerate(self.children(el)):
                nid = f"{prefix}{i}"
                rel = href_to_rel(c.get("href", "")) if c.get("href") else None
                out.append({
                    "id": nid,
                    "tag": c.tag,
                    "caption": self.caption(c),
                    "href": c.get("href"),
                    "file": rel,
                    "exists": bool(rel) and (md_root / rel).is_file(),
                    "attrs": dict(c.attrib),
                    "children": walk(c, nid + "."),
                })
            return out
        return walk(self.root, "")

    def referenced(self) -> set[str]:
        """.md paths (relative, lower case) referenced by the table of contents."""
        return {r.lower() for el in self.all_nodes() if (r := href_to_rel(el.get("href", "")))}

    # -- attributes -------------------------------------------------------
    def _uses(self, attr: str) -> list[str]:
        return [v for el in self.all_nodes() if (v := el.get(attr))]

    def touch(self, el: ET.Element):
        """Updates `modified` when the file uses that attribute."""
        samples = self._uses("modified")
        if samples:
            el.set("modified", _now_like(samples[0]))

    def new_node(self, caption: str, href: str, like: ET.Element | None) -> ET.Element:
        attrs = {"type": "topic", "href": href}
        new_id = _new_id(self._uses("id"))
        if new_id:
            attrs["id"] = new_id
        if like is not None and like.get("build"):
            attrs["build"] = like.get("build")
        el = ET.Element("topicref", attrs)
        self.touch(el)
        cap_like = self.root.find(".//caption")
        cap = ET.SubElement(el, "caption", dict(cap_like.attrib) if cap_like is not None else {})
        cap.text = caption
        return el

    # -- edits ------------------------------------------------------------
    def insert(self, el: ET.Element, target: str | None, position: str):
        """Inserts `el` before/after/inside the target node (target None = end of the root)."""
        if target is None:
            parent, index = self.root, len(list(self.root))
        else:
            tparent, tel = self.get(target)
            if position == "inside":
                parent, index = tel, len(list(tel))
            elif position in ("before", "after"):
                parent = tparent
                index = list(tparent).index(tel) + (1 if position == "after" else 0)
            else:
                raise TocError(f"Unknown position: {position}")
        parent.insert(index, el)

    def move(self, node_id: str, target: str, position: str):
        parent, el = self.get(node_id)
        _, tel = self.get(target)
        if tel is el or any(d is tel for d in el.iter()):
            raise TocError("A node cannot be moved into itself")
        # Insert a placeholder first so the target path stays valid, then swap.
        marker = ET.Element("__marker__")
        self.insert(marker, target, position)
        parent.remove(el)
        holder = next(p for p in self.root.iter() if marker in list(p))
        holder.insert(list(holder).index(marker), el)
        holder.remove(marker)
        self.touch(el)

    def rename(self, node_id: str, caption: str):
        caption = " ".join((caption or "").split())
        if not caption:
            raise TocError("The title cannot be empty")
        _, el = self.get(node_id)
        cap = el.find("caption")
        if cap is None and el.get("navtitle") is not None:
            el.set("navtitle", caption)
        else:
            if cap is None:
                cap = ET.Element("caption")
                el.insert(0, cap)
            cap.text = caption
        self.touch(el)

    def remove(self, node_id: str, keep_children: bool) -> ET.Element:
        parent, el = self.get(node_id)
        index = list(parent).index(el)
        parent.remove(el)
        if keep_children:
            for k, child in enumerate(self.children(el)):
                parent.insert(index + k, child)
        return el

    # -- save -------------------------------------------------------------
    def serialize(self) -> str:
        ET.indent(self.root, space="  ")
        body = ET.tostring(self.root, encoding="unicode")
        prologue = self.prologue.rstrip("\n")
        out = (prologue + "\n" if prologue else "") + body + "\n"
        if self.epilogue:
            out += self.epilogue + "\n"
        return out

    def save(self):
        data = self.serialize().encode("utf-8")
        with open(self.path, "wb") as fh:
            fh.write((b"\xef\xbb\xbf" if self.bom else b"") + data)
        self.mtime = self.path.stat().st_mtime


# --------------------------------------------------------------------------
# Operations (used by the HTTP API and the MCP server)
# --------------------------------------------------------------------------

def state(toc_path: Path | None, md_root: Path, topics: list[str], root_rel) -> dict:
    """Table of contents for the UI: tree, broken nodes, orphan topics."""
    if not toc_path or not toc_path.is_file():
        return {"path": None, "abs": str(toc_path).replace("\\", "/") if toc_path else None, "tree": [], "orphans": [], "broken": 0, "mtime": None}
    toc = Toc(toc_path)
    tree = toc.tree(md_root)
    refs = toc.referenced()
    broken = sum(1 for el in toc.all_nodes() if (r := href_to_rel(el.get("href", ""))) and not (md_root / r).is_file())
    return {
        "path": root_rel(toc_path),
        "abs": str(toc_path).replace("\\", "/"),
        "mtime": toc.mtime,
        "tree": tree,
        "orphans": [t for t in topics if t.lower() not in refs],
        "broken": broken,
    }


def _md_path(md_root: Path, href: str) -> Path:
    if not TOPIC_ID_RE.match(href or "") or ".." in href.split("/"):
        raise TocError(f"Invalid topic ID: {href!r} (letters, digits, - _ . only)")
    rel = href_to_rel(href)
    p = (md_root / rel).resolve()
    if md_root not in p.parents:
        raise TocError(f"Topic outside the documentation folder: {href}")
    return p


def edit(toc_path: Path, md_root: Path, data: dict) -> dict:
    """Applies one edit and saves. Returns {created, deleted} paths relative to md_root."""
    toc = Toc(toc_path)
    expected = data.get("mtime")
    if expected is not None and abs(toc.mtime - float(expected)) > 0.001:
        raise TocError("The table of contents was modified outside the editor", 409, "conflict")
    op = data.get("op")
    result: dict = {"created": None, "deleted": None}

    if op == "move":
        toc.move(data["id"], data["target"], data.get("position", "after"))
    elif op == "rename":
        toc.rename(data["id"], data.get("caption", ""))
    elif op in ("add", "duplicate"):
        caption = " ".join((data.get("caption") or "").split())
        href = rel_to_href((data.get("href") or "").strip())
        if not caption:
            raise TocError("The title cannot be empty")
        p = _md_path(md_root, href)
        create = op == "duplicate" or bool(data.get("create"))
        if create and p.exists():
            raise TocError(f"The file already exists: {href}.md", 409, "exists")
        if op == "duplicate":
            _, src = toc.get(data["id"])
            target, position = data["id"], "after"
            src_rel = href_to_rel(src.get("href", ""))
            src_file = md_root / src_rel if src_rel else None
            content = src_file.read_text(encoding="utf-8-sig") if src_file and src_file.is_file() else f"# {caption}\n"
            like = src
        else:
            target, position = data.get("target"), data.get("position", "inside")
            content = f"# {caption}\n"
            like = toc.get(target)[1] if target is not None else None
        el = toc.new_node(caption, href, like)
        toc.insert(el, target, position)
        if create:
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(content)
            result["created"] = href_to_rel(href)
    elif op in ("remove", "delete"):
        el = toc.remove(data["id"], bool(data.get("keepChildren")))
        if op == "delete":
            rel = href_to_rel(el.get("href", ""))
            if rel:
                p = _md_path(md_root, rel_to_href(rel))
                still_used = any(href_to_rel(n.get("href", "")) == rel for n in toc.all_nodes())
                if p.is_file() and not still_used:
                    os.remove(p)
                    result["deleted"] = rel
    else:
        raise TocError(f"Unknown operation: {op}")

    toc.save()
    return result
