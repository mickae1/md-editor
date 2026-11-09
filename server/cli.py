"""mdEditor command line: export a documentation project without opening the editor.

    mdeditor-cli export-html <docs folder> <output folder> [--no-toc]
    mdeditor-cli export-pdf  <docs folder> <file.pdf>      [--no-toc]

From the sources: python server/cli.py ...
<docs folder> is the folder of the .md topics (e.g. Help/Md); mkdocs.yml is
looked for there or up to two levels above, and the table of contents
(Maps/table_of_contents.xml) next to it gives the navigation and the PDF order.
Each page keeps the name of its .md file (GeneralViews-Map.html).
MkDocs must be installed (pip install mkdocs-material); MDEDITOR_MKDOCS can
point to the mkdocs.exe or python.exe of the environment where it is installed.
Exit codes: 0 done, 1 export failed, 2 wrong arguments.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export  # noqa: E402
from app import Project, find_browser, load_settings, mkdocs_command  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="mdeditor-cli", description="Export an MkDocs documentation project as a website or a PDF.")
    sub = ap.add_subparsers(dest="command", required=True)
    html = sub.add_parser("export-html", help="build the website into a folder (one .html file per .md file)")
    html.add_argument("docs", help="documentation folder (the .md files, e.g. Help/Md)")
    html.add_argument("output", help="output folder (created; emptied first if it holds a previous export)")
    pdf = sub.add_parser("export-pdf", help="create one PDF of the whole documentation")
    pdf.add_argument("docs", help="documentation folder (the .md files, e.g. Help/Md)")
    pdf.add_argument("output", help="PDF file to write")
    for p in (html, pdf):
        p.add_argument("--no-toc", action="store_true", help="do not use Maps/table_of_contents.xml for the navigation")
    args = ap.parse_args(argv)

    docs = Path(args.docs).expanduser()
    if not docs.is_dir():
        print(f"error: folder not found: {docs}", file=sys.stderr)
        return 2
    proj = Project(docs, load_settings())
    if not proj.mkdocs:
        print(f"error: no mkdocs.yml found in {proj.root} or the two folders above it", file=sys.stderr)
        return 2
    use_toc = not args.no_toc
    toc = proj.toc_file if use_toc else None
    print(f"Project: {proj.root}")
    print(f"MkDocs:  {proj.mkdocs}")
    print(f"Navigation: {toc if toc else 'mkdocs.yml'}")
    try:
        if args.command == "export-html":
            r = export.export_site(mkdocs_command(), proj.mkdocs, proj.root, toc, Path(args.output), use_toc)
            print(f"Website: {r['out']} ({r['pages']} pages, {r['seconds']} s)")
            if r["index"]:
                print(f"Open:    {r['index']}")
        else:
            r = export.export_pdf(mkdocs_command(), find_browser(), proj.mkdocs, proj.root, toc, Path(args.output), use_toc)
            print(f"PDF:     {r['out']} ({r['pages']} topics, {r['bytes'] // 1024} KB, {r['seconds']} s)")
    except export.ExportError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except Exception as e:  # MkDocs missing in a frozen build, permissions...
        print(f"error: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    for w in r["warnings"]:
        print(w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
