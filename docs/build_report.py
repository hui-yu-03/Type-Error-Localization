"""Builds the PDF report from README.md.

    python docs/build_report.py        # writes docs/report.html and docs/report.pdf

The report is the README typeset for reading on paper: a title page with a
summary, a table of contents, every section of the README (each larger part
on a new page), and the figures of results/.  Needs `pip install markdown` and
Node's Playwright with Chromium (node docs/render_pdf.js).
"""

from __future__ import annotations

import html
import re
import subprocess
import sys
from pathlib import Path

import markdown

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

CSS = """
@page { size: A4; }
html { font-size: 10pt; }
body { font-family: 'Bitstream Charter', 'Charter', 'DejaVu Serif', serif; color: #1d2430; line-height: 1.45;
       margin: 0; -webkit-print-color-adjust: exact; }
h1, h2, h3, h4 { font-family: 'Inter', 'DejaVu Sans', sans-serif; color: #14213d; line-height: 1.2; }
h2 { font-size: 17pt; margin: 24pt 0 10pt; padding-bottom: 4pt; border-bottom: 1.5pt solid #b5501c; break-after: avoid; }
/* the larger parts start on a new page; the sections inside them follow on */
#introduction, #architecture, #benchmarks, #the-six-improvements-after-the-first-version,
#the-inferencer-what-was-found-and-fixed { break-before: page; margin-top: 0; }
h3 { font-size: 12.5pt; margin: 16pt 0 6pt; break-after: avoid; }
h4 { font-size: 10.5pt; margin: 12pt 0 4pt; break-after: avoid; }
p, li { orphans: 3; widows: 3; }
a { color: #2f6690; text-decoration: none; }
code { font-family: 'JetBrains Mono', 'DejaVu Sans Mono', monospace; font-size: 8.4pt; background: #f1eee6; font-variant-ligatures: none;
       padding: 0 2pt; border-radius: 2pt; }
pre { background: #1c2838; color: #e8e4da; padding: 7pt 9pt; border-radius: 4pt; overflow: hidden;
      white-space: pre-wrap; break-inside: avoid; font-size: 8pt; line-height: 1.35; }
pre code { background: none; color: inherit; padding: 0; font-size: 8pt; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; font-family: 'Inter', sans-serif;
        font-size: 7.6pt; line-height: 1.3; break-inside: auto; }
th { background: #ece7db; text-align: left; font-weight: 600; }
td code, th code { white-space: nowrap; }
th, td { border: 0.5pt solid #d8d1c3; padding: 2.5pt 4pt; vertical-align: top; }
tr { break-inside: avoid; }
tr:nth-child(even) td { background: #faf8f3; }
img { max-width: 100%; display: block; margin: 8pt auto; break-inside: avoid; }
blockquote { margin: 6pt 0; padding: 2pt 10pt; border-left: 3pt solid #b5501c; color: #3d4757; }
hr { display: none; }
.title { height: 245mm; display: flex; flex-direction: column; justify-content: space-between; }
.title .eyebrow { font-family: 'Inter', sans-serif; font-size: 9pt; letter-spacing: 1.5pt; text-transform: uppercase;
                  color: #b5501c; font-weight: 600; }
.title h1 { font-size: 30pt; margin: 18pt 0 10pt; }
.title .sub { font-family: 'Inter', sans-serif; font-size: 13pt; color: #3d4757; }
.title .abstract { font-size: 10pt; border-top: 1pt solid #d8d1c3; padding-top: 10pt; }
.title .abstract p { margin: 0 0 6pt; }
.toc { break-before: page; }
.toc h2 { break-before: avoid; margin-top: 0; }
.toc ol { padding-left: 14pt; font-family: 'Inter', sans-serif; font-size: 9.5pt; line-height: 1.6; }
.toc ol ol { font-size: 8.5pt; line-height: 1.45; color: #3d4757; }
.figure-caption { text-align: center; font-family: 'Inter', sans-serif; font-size: 8pt; color: #5f6878; margin-top: -4pt; }
"""


def build(abstract_md: str) -> Path:
    text = (ROOT / "README.md").read_text()
    title_match = re.match(r"# (.+)\n", text)
    title = title_match.group(1) if title_match else "Report"
    text = text[title_match.end():] if title_match else text
    # the README's own contents list is replaced by the generated one
    text = re.sub(r"\*\*Contents\*\*\n\n(?:\d+\. .*\n)+", "", text)
    # images and links relative to the repository
    text = re.sub(r"\]\((results/[^)]+\.png)\)", lambda m: f"]({(ROOT / m.group(1)).as_uri()})", text)
    md = markdown.Markdown(extensions=["tables", "fenced_code", "toc", "sane_lists"],
                           extension_configs={"toc": {"toc_depth": "2-3"}})
    body = md.convert(text)
    # the text before the first section is the introduction
    intro, _, rest = body.partition("<h2")
    body = f'<h2 id="introduction">Introduction</h2>{intro}<h2{rest}'

    def toc(tokens) -> str:
        items = "".join(f'<li><a href="#{t["id"]}">{t["name"]}</a>{toc(t["children"]) if t["children"] else ""}</li>'
                        for t in tokens)
        return f"<ol>{items}</ol>"

    tokens = [{"id": "introduction", "name": "Introduction", "children": []}] + md.toc_tokens
    abstract = markdown.markdown(abstract_md, extensions=["tables"])
    page = f"""<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>{CSS}</style></head><body>
<section class="title">
  <div><p class="eyebrow">Technical report · November 2026</p><h1>{html.escape(title)}</h1>
  <p class="sub">What was built, how it works, and what the experiments show</p></div>
  <div class="abstract">{abstract}</div>
</section>
<section class="toc"><h2>Contents</h2>{toc(tokens)}</section>
{body}
</body></html>"""
    out = HERE / "report.html"
    out.write_text(page)
    pdf = HERE / "report.pdf"
    subprocess.run(["node", str(HERE / "render_pdf.js"), str(out), str(pdf)], check=True, cwd=ROOT)
    return pdf


ABSTRACT = (HERE / "report_abstract.md").read_text() if (HERE / "report_abstract.md").exists() else ""

if __name__ == "__main__":
    print(build(ABSTRACT), file=sys.stderr)
