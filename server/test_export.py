"""Website export tests (server/export.py) on a copy of the sample project.

Usage: python server/test_export.py
The real build runs when MkDocs is available: MDEDITOR_MKDOCS (path of mkdocs.exe,
or of the python.exe of an environment with mkdocs-material), else the current Python.
"""
import importlib.util
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import export  # noqa: E402
from app import mkdocs_command  # noqa: E402

tmp = Path(tempfile.mkdtemp(prefix="mdeditor-export-"))
shutil.copytree(HERE.parent / "sample" / "Help", tmp / "Help")
help_dir = tmp / "Help"
md = (help_dir / "Md").resolve()
mk = help_dir / "mkdocs.yml"
xml = help_dir / "Maps" / "table_of_contents.xml"
failures = 0


def check(name, cond, detail=""):
    global failures
    print(f"{'ok  ' if cond else 'FAIL'} {name}{'' if cond else '  ' + str(detail)}")
    if not cond:
        failures += 1


def refused(out, code):
    try:
        export.check_output(Path(out).resolve(), mk, md)
        return False
    except export.ExportError as e:
        return e.code == code


# 1. Navigation from the table of contents
nav = export.nav_from_toc(xml, md)
check("nav: root entries", [list(e)[0] for e in nav] == ["Welcome", "General views", "Create a scenario"], nav)
check("nav: a section starts with its own page", nav[1]["General views"][0] == {"General views": "GeneralViews-Map.md"}, nav[1])
check("nav: nested section", nav[1]["General views"][2]["Entity viewer"][1] == {"Analysis overview": "GeneralViews-EntityViewer-Analysis-Overview.md"})
check("nav: missing file left out", "Workflow-ImportData.md" not in str(nav) and nav[2] == {"Create a scenario": "Workflow-CreateScenario.md"}, nav[2])
cfg = export.build_config(mk, nav)
check("config: inherits mkdocs.yml, quoted titles", cfg.startswith('INHERIT: "mkdocs.yml"\nnav:\n  - "Welcome": "index.md"'), cfg)

# 2. Output folder safety (MkDocs empties it first)
check("output: the documentation folder is refused", refused(md, "unsafe"))
check("output: the project folder is refused", refused(help_dir, "unsafe"))
other = tmp / "Documents"
other.mkdir()
(other / "letter.txt").write_text("keep me", encoding="utf-8")
check("output: a non-empty unknown folder is refused", refused(other, "not_empty"))
try:
    export.check_output((tmp / "new-site").resolve(), mk, md)
    export.check_output((help_dir / "Html").resolve(), mk, md)  # site_dir of mkdocs.yml
    check("output: new folder and configured site_dir accepted", True)
except export.ExportError as e:
    check("output: new folder and configured site_dir accepted", False, e)

# 3. Real build
cmd = mkdocs_command()
available = bool(os.environ.get("MDEDITOR_MKDOCS")) or importlib.util.find_spec("mkdocs") is not None
if not available:
    print("skip real build: MkDocs not installed (set MDEDITOR_MKDOCS)")
else:
    page = md / "GeneralViews-BasicEditors.md"
    page.write_text(page.read_text(encoding="utf-8").replace("\n## ", "\n## Custom anchor { #custom-anchor }\n\n## ", 1), encoding="utf-8")
    snapshot = lambda: sorted((p.relative_to(help_dir).as_posix(), p.stat().st_mtime) for p in help_dir.rglob("*") if p.is_file())  # noqa: E731
    before = snapshot()
    out = (tmp / "site").resolve()
    r = export.export_site(cmd, mk, md, xml, out)
    topics = sorted(p.stem for p in md.glob("*.md"))
    html = sorted(p.stem for p in out.glob("*.html") if p.stem != "404")
    check("build: one .html per topic, same names (+ contents)", html == sorted(topics + ["contents"]), f"{html} vs {topics}")
    check("build: snippets are not pages", not (out / "_snippets").exists())
    index = (out / "index.html").read_text(encoding="utf-8")
    check("build: links point to .html files", 'href="GeneralViews-Map.html"' in index and "/index.html" not in index.replace('href="index.html"', ""))
    check("build: navigation from the table of contents", index.find("Welcome") < index.find("General views") < index.find("Create a scenario"))
    basic = (out / "GeneralViews-BasicEditors.html").read_text(encoding="utf-8")
    check("build: heading id { #id } exported", 'id="custom-anchor"' in basic)
    check("build: snippet expanded", "--8&lt;--" not in basic and "--8<--" not in basic)
    check("build: export marker", (out / export.MARKER).is_file() and r["navFromToc"] and r["pages"] >= len(topics))
    contents = (out / "contents.html").read_text(encoding="utf-8") if (out / "contents.html").is_file() else ""
    check("build: contents page generated (index.md stays the home page)", r["contents"] == "contents.html" and "<h1>Contents</h1>" in contents
          and "Sample documentation" in index and "<h1>Contents</h1>" not in index)
    check("build: contents page lists the pages as .html", all(f'href="{f}"' in contents for f in
          ["GeneralViews-Map.html", "GeneralViews-EntityViewer-Analysis-Charts.html", "Workflow-CreateScenario.html"]))
    menu = re.search(r'<nav class="md-nav md-nav--primary".*?</nav>\s*</div>', index, re.S)
    menu_links = re.findall(r'<a href="([^"]+)"[^>]*class="md-nav__link', menu.group(0)) if menu else []
    check("build: contents first in the menu", menu_links[:1] == ["contents.html"], menu_links[:4])
    check("build: no warning about the generated page", not any("contents.html" in w for w in r["warnings"]), r["warnings"])
    r2 = export.export_site(cmd, mk, md, xml, out, use_toc=False)
    check("build: second export into the same folder", not r2["navFromToc"] and (out / "index.html").is_file())
    after = snapshot()
    check("build: documentation folder untouched (no file added or changed)", after == before,
          sorted(set(after) ^ set(before))[:5])

    check("build: without the table of contents, no contents page", r2["contents"] is None and not (out / "contents.html").exists())

    # Without index.md, index.html is the contents page.
    (md / "index.md").rename(tmp / "index.md.bak")
    out3 = (tmp / "site-noindex").resolve()
    r3 = export.export_site(cmd, mk, md, xml, out3)
    home = (out3 / "index.html").read_text(encoding="utf-8") if (out3 / "index.html").is_file() else ""
    check("build: no index.md -> index.html is the contents page", r3["contents"] == "index.html" and "<h1>Contents</h1>" in home and 'href="GeneralViews-Map.html"' in home)
    (tmp / "index.md.bak").rename(md / "index.md")
    before = snapshot()

    # 4. PDF (printed by Edge from the built site)
    from app import find_browser  # noqa: E402
    browser = find_browser()
    if not browser:
        print("skip PDF: no Edge / Chrome")
    else:
        pdf = tmp / "out" / "doc.pdf"
        r = export.export_pdf(cmd, browser, mk, md, xml, pdf)
        data = pdf.read_bytes()
        pages = len(re.findall(rb"/Type\s*/Page[^s]", data))
        check("pdf: file created", data.startswith(b"%PDF") and r["bytes"] == len(data))
        check("pdf: cover + contents + one page per topic at least", pages >= 2 + r["pages"], f"{pages} pages for {r['pages']} topics")
        check("pdf: links inside the document", len(re.findall(rb"/Subtype\s*/Link", data)) >= r["pages"])
        order = [x["caption"] for x in export._flat(export.page_order(xml, md))]
        check("pdf: order of the table of contents", order[:3] == ["Welcome", "General views", "Basic editors"], order)
        check("pdf: documentation folder untouched", snapshot() == before)
        printed = export.print_page(out, export.page_order(xml, md), "Doc")
        doc = printed.read_text(encoding="utf-8")
        check("pdf: contents on the first page, no cover", "print-cover" not in doc
              and doc.find('class="print-contents"') < doc.find('class="print-page"') and ".print-page { break-before: page; }" in doc
              and "print-contents, .print-page" not in doc)
        try:
            export.export_pdf(cmd, browser, mk, md, xml, md / "inside.pdf")
            check("pdf: refused inside the documentation folder", False)
        except export.ExportError:
            check("pdf: refused inside the documentation folder", True)

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{failures} failure(s)" if failures else "\nAll OK")
sys.exit(1 if failures else 0)
