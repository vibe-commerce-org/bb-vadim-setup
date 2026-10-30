"""PDF инструкций: GUIDE.md → release/08-BB-VADIM-SETUP.pdf, PHONE.md → release/08-BB-PHONE.pdf.

Использование: python3 scripts/render-pdf.py [ФАЙЛ.md ...]   (по умолчанию — оба)
Нужны pandoc и Playwright для Python с Chromium:
  brew install pandoc && python3 -m pip install playwright && python3 -m playwright install chromium

pandoc собирает HTML с оглавлением, Chromium печатает его в A4 с номерами страниц.
Картинки (снимки интерфейса в GUIDE.md) берутся по относительным путям от корня репозитория и вшиваются в PDF.
Шрифты — системные с кириллицей (PT Sans, Helvetica Neue, Menlo); на macOS они есть.
Команды удобнее копировать из GUIDE.md: в PDF длинные строки кода переносятся.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGETS = {"GUIDE.md": "08-BB-VADIM-SETUP.pdf", "PHONE.md": "08-BB-PHONE.pdf"}

CSS = """
@page { size: A4; margin: 16mm 15mm 18mm 15mm; }
html { font-family: "PT Sans", "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #1f2328; }
body { max-width: none; margin: 0; padding: 0; }
h1 { font-size: 20pt; margin: 0 0 8pt; }
h2 { font-size: 15pt; margin: 18pt 0 6pt; break-after: avoid; border-bottom: 1px solid #d0d7de; padding-bottom: 3pt; }
h3 { font-size: 12.5pt; margin: 14pt 0 4pt; break-after: avoid; }
h4 { font-size: 11pt; margin: 10pt 0 4pt; break-after: avoid; }
p, li { orphans: 3; widows: 3; }
a { color: #0969da; text-decoration: none; }
code, pre { font-family: Menlo, "PT Mono", monospace; font-size: 8.8pt; }
code { background: #f3f4f6; padding: 0 2pt; border-radius: 2pt; }
pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 4pt; padding: 6pt 8pt;
      white-space: pre-wrap; word-break: break-all; break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: 9pt; margin: 6pt 0; break-inside: auto; }
th, td { border: 1px solid #d0d7de; padding: 3pt 5pt; vertical-align: top; text-align: left; }
th { background: #f6f8fa; }
tr { break-inside: avoid; }
blockquote { margin: 6pt 0; padding: 2pt 10pt; border-left: 3px solid #d0d7de; color: #57606a; }
img { max-width: 100%; height: auto; display: block; margin: 6pt 0 2pt; border: 1px solid #d0d7de; break-inside: avoid; }
p:has(> img) { break-after: avoid; margin-bottom: 0; }
nav#TOC { break-after: page; }
nav#TOC ul { list-style: none; padding-left: 12pt; }
nav#TOC > ul { padding-left: 0; }
"""

FOOTER = ('<div style="font-family:\'PT Sans\',Arial,sans-serif;font-size:8pt;color:#57606a;width:100%;text-align:center;">'
          'bb как у Вадима · <span class="pageNumber"></span> / <span class="totalPages"></span></div>')


def render(src_name: str, version: str) -> None:
    from playwright.sync_api import sync_playwright

    out = ROOT / "release" / TARGETS[src_name]
    with tempfile.TemporaryDirectory() as tmp:
        css = Path(tmp) / "style.css"
        css.write_text(CSS, encoding="utf-8")
        html = Path(tmp) / "guide.html"
        subprocess.run(
            ["pandoc", str(ROOT / src_name), "--resource-path", str(ROOT), "-f", "gfm", "-t", "html5", "-s",
             *(["--toc", "--toc-depth=3"] if src_name == "GUIDE.md" else []),
             "--embed-resources", "--css", str(css),
             "--metadata", f"pagetitle=bb как у Вадима — комплект {version}", "--metadata", "toc-title=Содержание", "-o", str(html)],
            check=True,
        )
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.goto(html.as_uri())
            page.pdf(path=str(out), format="A4", print_background=True, display_header_footer=True,
                     header_template="<div></div>", footer_template=FOOTER,
                     margin={"top": "16mm", "bottom": "18mm", "left": "15mm", "right": "15mm"})
            browser.close()
    print(f"{out.relative_to(ROOT)}: {out.stat().st_size} байт")


def main() -> None:
    version = (ROOT / "VERSION").read_text().strip()
    for name in sys.argv[1:] or list(TARGETS):
        render(name, version)


if __name__ == "__main__":
    main()
