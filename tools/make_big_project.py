"""Generates a large fake documentation project to measure performance.

Usage: python tools/make_big_project.py <output folder>   (creates <folder>/Md, Maps/, mkdocs.yml)
600 topics (two of 1500 lines), 210 snippets, a table of contents of 600 entries.
See web/tests/perf.mjs.
"""
import random
import shutil
import sys
from pathlib import Path

random.seed(7)
out = Path(sys.argv[1])
shutil.rmtree(out, ignore_errors=True)
md = out / "Md"
(md / "_snippets").mkdir(parents=True)
(md / "images").mkdir()
(out / "Maps").mkdir()

areas = ["GeneralViews", "Workflow", "Methodologies", "Reference", "Admin", "Analysis"]
subs = ["Map", "Editor", "Viewer", "Charts", "Filters", "Import", "Export", "Capacity", "Sectors", "Flights", "Scenario", "Settings"]
topics = []
for i in range(600):
    a = areas[i % len(areas)]
    name = f"{a}-{random.choice(subs)}-{random.choice(subs)}-{i:03d}"
    topics.append(name)
snippets = [f"snippet-{random.choice(subs).lower()}-{i:03d}" for i in range(210)]

(md / "images" / "pic.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#345"/></svg>\n')

for s in snippets:
    (md / "_snippets" / f"{s}.md").write_text(
        f"!!! note \"{s}\"\n\n    Shared text for {s}. See [a topic]({random.choice(topics)}.md).\n\n"
        f"| A | B |\n| --- | --- |\n| 1 | 2 |\n", encoding="utf-8")


def topic_body(name, paragraphs):
    lines = [f"# {name.replace('-', ' ')}", "", f'<a id="{name.lower()}-intro"></a>', ""]
    for p in range(paragraphs):
        if p % 7 == 0:
            lines += [f"## Section {p} {{ #sec-{p} }}" if p % 14 == 0 else f"## Section {p}", ""]
        lines += [f"Paragraph {p} of {name} with **bold**, *italic*, `code` and a [link]({random.choice(topics)}.md). TODO check this." if p % 23 == 0 else
                  f"Paragraph {p} of {name} with **bold**, *italic*, `code` and a [link]({random.choice(topics)}.md#sec-0).", ""]
        if p % 9 == 3:
            lines += [f'--8<-- "_snippets/{random.choice(snippets)}.md"', ""]
        if p % 11 == 5:
            lines += ["| Command | Shortcut | Description |", "| --- | --- | --- |"] + [f"| Cmd {k} | Ctrl+{k} | Does thing {k} |" for k in range(6)] + [""]
        if p % 13 == 7:
            lines += ['<img src="images/pic.svg" alt="Picture" width="400" height="200">', ""]
        if p % 17 == 2:
            lines += ["- item one", "    - nested item", "- item two", ""]
    return "\n".join(lines) + "\n"


for i, t in enumerate(topics):
    n = 400 if i in (5, 6) else (120 if i % 50 == 0 else 30)
    (md / f"{t}.md").write_text(topic_body(t, n), encoding="utf-8")
(md / "index.md").write_text("# Home\n\nWelcome.\n\n" + "\n".join(f"- [{t}]({t}.md)" for t in topics[:40]) + "\n", encoding="utf-8")

# Table of contents: 6 areas > 10 groups > ~10 topics
xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<map defaulttopic="index">',
       '  <topicref type="topic" href="index" id="t-0000" modified="2025-01-01T00:00:00"><caption translate="true">Home</caption></topicref>']
k = 1
by_area = {a: [t for t in topics if t.startswith(a + "-")] for a in areas}
for a, ts in by_area.items():
    xml.append(f'  <topicref type="topic" href="{ts[0]}" id="t-{k:04d}" modified="2025-01-01T00:00:00"><caption translate="true">{a}</caption>'); k += 1
    for g in range(0, len(ts) - 1, 10):
        group = ts[1 + g:1 + g + 10]
        if not group:
            continue
        xml.append(f'    <topicref type="topic" href="{group[0]}" id="t-{k:04d}" modified="2025-01-01T00:00:00"><caption translate="true">{a} group {g // 10}</caption>'); k += 1
        for t in group[1:]:
            xml.append(f'      <topicref type="topic" href="{t}" id="t-{k:04d}" modified="2025-01-01T00:00:00"><caption translate="true">{t}</caption></topicref>'); k += 1
        xml.append('    </topicref>')
    xml.append('  </topicref>')
xml.append('</map>')
(out / "Maps" / "table_of_contents.xml").write_text("\n".join(xml) + "\n", encoding="utf-8")
(out / "mkdocs.yml").write_text("site_name: Big\ndocs_dir: Md\nexclude_docs: |\n  _snippets/\nmarkdown_extensions:\n  - admonition\n  - attr_list\n  - tables\n  - pymdownx.snippets:\n      base_path: Md\n", encoding="utf-8")
print(len(topics), "topics,", len(snippets), "snippets,", k, "toc entries")
