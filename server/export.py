"""Export the project as a static website or a PDF, with MkDocs.

Every page keeps the name of its .md file: GeneralViews-Map.md becomes
GeneralViews-Map.html (`mkdocs build --no-directory-urls`), instead of the
default GeneralViews-Map/index.html. The site navigation is built from the
table of contents (Maps/table_of_contents.xml) when there is one, together
with a "Contents" page listing it: contents.html when the project has an
index.md (which stays the home page), else index.html.

Nothing is written into the documentation folder: the build configuration
inherits mkdocs.yml and is given to MkDocs on its standard input.

The PDF is printed by Edge (headless) from one page that gathers the pages of
the site in the order of the table of contents: the contents on the first
page, then one page per topic; links between pages become links inside the PDF.
Standard library only.
"""
from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from datetime import date
from pathlib import Path

import toc as toc_mod

# Written into an exported site, so that the next export may replace it.
MARKER = ".mdeditor-export"


class ExportError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = ""):
        super().__init__(message)
        self.status = status
        self.code = code


def configured_site_dir(mkdocs: Path) -> Path:
    """`site_dir` of mkdocs.yml (default: site), next to mkdocs.yml."""
    try:
        text = mkdocs.read_text(encoding="utf-8")
    except OSError:
        text = ""
    m = re.search(r"^site_dir\s*:\s*['\"]?([^'\"\n#]+)", text, re.M)
    return (mkdocs.parent / (m.group(1).strip() if m else "site")).resolve()


def nav_from_toc(toc_path: Path, docs_dir: Path) -> list:
    """MkDocs `nav` built from the table of contents. A node with children becomes
    a section whose first entry is its own page; entries whose file is missing are left out."""
    tree = toc_mod.Toc(toc_path).tree(docs_dir)

    def entries(nodes: list[dict]) -> list:
        out: list = []
        for n in nodes:
            page = n["file"] if n["file"] and n["exists"] else None
            children = entries(n["children"])
            if children:
                out.append({n["caption"]: ([{n["caption"]: page}] if page else []) + children})
            elif page:
                out.append({n["caption"]: page})
        return out
    return entries(tree)


CONTENTS_TITLE = "Contents"


def contents_file(docs_dir: Path) -> str:
    """Name of the generated contents page: index.html stays the page of index.md."""
    return "contents.html" if (docs_dir / "index.md").is_file() else "index.html"


def contents_list(nodes: list[dict], link) -> str:
    """Nested list of the table of contents (`link(node)` gives the href, or None)."""
    if not nodes:
        return ""
    items = []
    for n in nodes:
        href = link(n)
        title = html.escape(n["caption"])
        label = f'<a href="{href}">{title}</a>' if href else title
        items.append(f"<li>{label}{contents_list(n['children'], link)}</li>")
    return f'<ul class="mdeditor-contents">{"".join(items)}</ul>'


def site_name_from_page(page: str) -> str:
    m = re.search(r'<span class="md-ellipsis">\s*([^<]+?)\s*</span>', page)
    return m.group(1) if m else ""


def write_contents_page(site: Path, toc_path: Path, docs_dir: Path, name: str):
    """Contents page of the website, made from a built page (same header, menu and theme)."""
    candidates = [site / "index.html", *sorted(site.glob("*.html"))]
    template = next((p for p in candidates if p.is_file() and p.name not in ("404.html", name)), None)
    if not template:
        return
    page = template.read_text(encoding="utf-8")
    tree = toc_mod.Toc(toc_path).tree(docs_dir)
    body = f"<h1>{CONTENTS_TITLE}</h1>" + contents_list(
        tree, lambda n: n["file"][:-3] + ".html" if n["file"] and n["exists"] else None)
    page = ARTICLE_RE.sub(lambda m: f'<article class="md-content__inner md-typeset">{body}</article>', page, count=1)
    page = re.sub(r"<title>.*?</title>", lambda m: f"<title>{CONTENTS_TITLE} - {html.escape(site_name_from_page(page))}</title>",
                  page, count=1, flags=re.S)
    # The template page is not the current one any more: no active entry, no previous/next links.
    page = re.sub(r"\s?md-nav__(item|link)--active", "", page)
    page = re.sub(r'<nav class="md-footer__inner[^"]*"[^>]*>.*?</nav>', "", page, count=1, flags=re.S)
    (site / name).write_text(page, encoding="utf-8")


def to_yaml(value, indent: int = 0) -> str:
    """Small YAML writer for the nav (strings are JSON-quoted, which YAML accepts)."""
    pad = "  " * indent
    if isinstance(value, list):
        lines = []
        for item in value:
            if isinstance(item, dict):
                (k, v), = item.items()
                if isinstance(v, list):
                    lines.append(f"{pad}- {json.dumps(k, ensure_ascii=False)}:")
                    lines.append(to_yaml(v, indent + 2) if v else f"{pad}    []")
                else:
                    lines.append(f"{pad}- {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}")
            else:
                lines.append(f"{pad}- {json.dumps(item, ensure_ascii=False)}")
        return "\n".join(lines)
    return f"{pad}{json.dumps(value, ensure_ascii=False)}"


def build_config(mkdocs: Path, nav: list | None) -> str:
    """Configuration given to `mkdocs build -f -`: the project's mkdocs.yml, plus the nav."""
    text = f"INHERIT: {json.dumps(mkdocs.name)}\n"
    if nav is not None:
        text += "nav:\n" + to_yaml(nav, 1) + "\n"
    return text


def check_output(out: Path, mkdocs: Path, docs_dir: Path):
    """MkDocs empties the output folder first: refuse a folder that is not ours."""
    # Not the documentation folder, one of its parents, or a folder inside it.
    if out == docs_dir or out in docs_dir.parents or docs_dir in out.parents or out == mkdocs.parent:
        raise ExportError(f"The site cannot be exported into {out}: choose a folder outside the documentation folder.", 400, "unsafe")
    if out.is_file():
        raise ExportError(f"{out} is a file.", 400, "unsafe")
    if out.is_dir() and any(out.iterdir()) and not (out / MARKER).exists() and out != configured_site_dir(mkdocs):
        raise ExportError(f"{out} is not empty and does not contain a previous export: choose an empty folder.", 409, "not_empty")


def export_site(mkdocs_cmd: list[str], mkdocs: Path, docs_dir: Path, toc_path: Path | None,
                out: Path, use_toc: bool = True, timeout: int = 900) -> dict:
    out = out.resolve()
    check_output(out, mkdocs, docs_dir)
    nav = nav_from_toc(toc_path, docs_dir) if use_toc and toc_path and toc_path.is_file() else None
    contents = contents_file(docs_dir) if nav is not None else None
    if contents:
        nav = [{CONTENTS_TITLE: contents}, *nav]
    config = build_config(mkdocs, nav)
    cmd = [*mkdocs_cmd, "build", "-f", "-", "--no-directory-urls", "--site-dir", str(out)]
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    start = time.time()
    try:
        proc = subprocess.run(cmd, input=config.encode("utf-8"), cwd=mkdocs.parent, capture_output=True,
                              timeout=timeout, creationflags=flags)
    except FileNotFoundError:
        raise ExportError("MkDocs not found: install it (pip install mkdocs-material).", 400, "mkdocs")
    except subprocess.TimeoutExpired:
        raise ExportError(f"mkdocs build did not finish within {timeout} s.", 504, "timeout")
    log = (proc.stdout + proc.stderr).decode("utf-8", "replace").replace("\r\n", "\n").strip()
    if proc.returncode != 0:
        raise ExportError("mkdocs build failed:\n" + "\n".join(log.splitlines()[-25:]), 500, "build")
    if contents:
        write_contents_page(out, toc_path, docs_dir, contents)
    (out / MARKER).write_text("Website exported by mdEditor; the next export replaces this folder.\n", encoding="utf-8")
    pages = sorted(p.relative_to(out).as_posix() for p in out.rglob("*.html") if "assets" not in p.parts)
    return {
        "out": out.as_posix(),
        "pages": len(pages),
        "index": (out / "index.html").as_posix() if (out / "index.html").is_file() else None,
        "seconds": round(time.time() - start, 1),
        "navFromToc": nav is not None,
        "contents": contents,
        # MkDocs does not know the generated contents page: its link is not a problem.
        "warnings": [line for line in log.splitlines()
                     if line.startswith("WARNING") and not (contents and f"'{contents}'" in line)][:50],
    }


# --------------------------------------------------------------------------
# PDF
# --------------------------------------------------------------------------

ARTICLE_RE = re.compile(r'<article class="md-content__inner md-typeset">(.*?)</article>', re.S)
STYLESHEET_RE = re.compile(r'<link rel="stylesheet" href="([^"]+)"[^>]*>')

PRINT_CSS = """
@page { size: A4; margin: 18mm 16mm; }
html, body { background: #fff !important; }
.print-contents h1 { margin-bottom: .2em; }
.print-contents .print-date { color: #666; margin-top: 0; }
.print-page { break-before: page; }
.print-contents ol, .print-contents li { list-style: none !important; }
.print-contents ol { padding-left: 1.2em !important; margin: .2em 0 !important; }
.print-contents > ol { padding-left: 0; }
.print-contents a { color: inherit; text-decoration: none; }
.md-content__button, .headerlink, .md-source-file { display: none !important; }
.md-typeset { font-size: 11pt; }
"""


def page_order(toc_path: Path | None, docs_dir: Path) -> list[dict]:
    """Pages to print: the table of contents tree (missing files left out), else every
    topic in alphabetical order with index.md first. Items: {caption, stem, children}."""
    if toc_path and toc_path.is_file():
        def walk(nodes):
            out = []
            for n in nodes:
                children = walk(n["children"])
                if n["file"] and n["exists"]:
                    out.append({"caption": n["caption"], "stem": n["file"][:-3], "children": children})
                else:
                    out.extend(children)
            return out
        return walk(toc_mod.Toc(toc_path).tree(docs_dir))
    stems = sorted((p.relative_to(docs_dir).as_posix()[:-3] for p in docs_dir.rglob("*.md")
                    if not any(part.startswith("_") for part in p.relative_to(docs_dir).parts)),
                   key=lambda x: (x != "index", x.lower()))
    return [{"caption": x, "stem": x, "children": []} for x in stems]


def _flat(items: list[dict]) -> list[dict]:
    return [x for i in items for x in [i, *_flat(i["children"])]]


def _page_id(stem: str) -> str:
    return "p-" + re.sub(r"[^A-Za-z0-9_-]", "-", stem)


def _scope(content: str, stem: str, stems: set[str]) -> str:
    """Ids prefixed by the page, links between pages turned into links inside the document."""
    pid = _page_id(stem)
    content = re.sub(r'\bid="([^"]+)"', lambda m: f'id="{pid}--{m.group(1)}"', content)

    def link(m):
        href = m.group(1)
        if href.startswith("#"):
            return f'href="#{pid}--{href[1:]}"'
        target, _, anchor = href.partition("#")
        if target.endswith(".html") and target[:-5] in stems:
            tid = _page_id(target[:-5])
            return f'href="#{tid}--{anchor}"' if anchor else f'href="#{tid}"'
        return m.group(0)
    return re.sub(r'href="([^"]*)"', link, content)


def print_page(site: Path, items: list[dict], title: str) -> Path:
    """One HTML file gathering the pages of the built site (written into the site folder)."""
    flat = _flat(items)
    stems = {x["stem"] for x in flat}
    first = next((site / f"{x['stem']}.html" for x in flat if (site / f"{x['stem']}.html").is_file()), site / "index.html")
    head = first.read_text(encoding="utf-8") if first.is_file() else ""
    styles = "".join(f'<link rel="stylesheet" href="{h}">' for h in STYLESHEET_RE.findall(head))
    scheme = re.search(r'data-md-color-scheme="([^"]+)"', head)

    def contents(nodes):
        if not nodes:
            return ""
        return "<ol>" + "".join(f'<li><a href="#{_page_id(n["stem"])}">{html.escape(n["caption"])}</a>{contents(n["children"])}</li>'
                                for n in nodes) + "</ol>"

    pages = []
    for x in flat:
        f = site / f"{x['stem']}.html"
        m = ARTICLE_RE.search(f.read_text(encoding="utf-8")) if f.is_file() else None
        if m:
            pages.append(f'<section class="print-page" id="{_page_id(x["stem"])}">{_scope(m.group(1), x["stem"], stems)}</section>')
    doc = (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)}</title>{styles}'
           f'<style>{PRINT_CSS}</style></head>'
           f'<body dir="ltr" data-md-color-scheme="{scheme.group(1) if scheme and "dark" not in scheme.group(1) else "default"}">'
           f'<div class="md-container"><main class="md-main"><div class="md-content"><div class="md-typeset">'
           f'<section class="print-contents"><h1>{html.escape(title)}</h1><p class="print-date">{date.today().isoformat()}</p>'
           f'<h2>{CONTENTS_TITLE}</h2>{contents(items)}</section>'
           f'{"".join(pages)}</div></div></main></div></body></html>')
    out = site / "_print.html"
    out.write_text(doc, encoding="utf-8")
    return out


def site_name(mkdocs: Path) -> str:
    try:
        m = re.search(r"^site_name\s*:\s*['\"]?([^'\"\n#]+)", mkdocs.read_text(encoding="utf-8"), re.M)
    except OSError:
        m = None
    return m.group(1).strip() if m else mkdocs.parent.name


def export_pdf(mkdocs_cmd: list[str], browser: str | None, mkdocs: Path, docs_dir: Path, toc_path: Path | None,
               pdf: Path, use_toc: bool = True, timeout: int = 900) -> dict:
    """Builds the site in a temporary folder, gathers its pages and prints them to `pdf` with Edge."""
    if not browser:
        raise ExportError("Microsoft Edge (or Chrome) is required to create the PDF.", 400, "browser")
    pdf = pdf.resolve()
    if pdf.suffix.lower() != ".pdf":
        raise ExportError(f"The output file must end with .pdf: {pdf}", 400, "unsafe")
    if any(pdf.parent == d or d in pdf.parents for d in (docs_dir,)):
        raise ExportError("The PDF cannot be written inside the documentation folder.", 400, "unsafe")
    pdf.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="mdeditor-pdf-"))
    start = time.time()
    try:
        built = export_site(mkdocs_cmd, mkdocs, docs_dir, toc_path, work / "site", use_toc, timeout)
        items = page_order(toc_path if use_toc else None, docs_dir)
        page = print_page(work / "site", items, site_name(mkdocs))
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        if pdf.exists():
            pdf.unlink()
        cmd = [browser, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--no-first-run",
               f"--user-data-dir={work / 'profile'}", f"--print-to-pdf={pdf}", page.as_uri()]
        try:
            subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=flags)
        except subprocess.TimeoutExpired:
            raise ExportError("Edge did not finish printing the PDF.", 504, "timeout")
        if not pdf.is_file() or pdf.stat().st_size == 0:
            raise ExportError("Edge did not create the PDF.", 500, "browser")
        return {"out": pdf.as_posix(), "pages": len(_flat(items)), "bytes": pdf.stat().st_size,
                "seconds": round(time.time() - start, 1), "navFromToc": built["navFromToc"], "warnings": built["warnings"]}
    finally:
        shutil.rmtree(work, ignore_errors=True)
