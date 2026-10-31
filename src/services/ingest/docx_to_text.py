"""Plain-text extraction from a .docx for the document-ingest job.

Called by src/services/ingest/ingest.ts on the worker image (python3 +
python-docx from requirements.txt):

    python3 docx_to_text.py <input.docx> <output.txt>

Walks the document body in order, so paragraphs and tables keep their
relative positions: each paragraph is one line, each table row is its cells
joined with " | ". Header and footer text follows the body under a marker.
Text boxes, footnotes and comments are not read. Writes UTF-8 to the output
path; exits non-zero with a message on stderr if the file cannot be read.
"""

import sys

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph


def table_lines(table):
    lines = []
    for row in table.rows:
        cells = []
        for cell in row.cells:
            text = " ".join(p.text.strip() for p in cell.paragraphs if p.text.strip())
            # Merged cells repeat across the row; keep one copy.
            if not cells or cells[-1] != text:
                cells.append(text)
        if any(cells):
            lines.append(" | ".join(cells))
    return lines


def body_lines(document):
    lines = []
    for child in document.element.body.iterchildren():
        if child.tag == qn("w:p"):
            lines.append(Paragraph(child, document).text)
        elif child.tag == qn("w:tbl"):
            lines.extend(table_lines(Table(child, document)))
    return lines


def header_footer_lines(document):
    seen = set()
    lines = []
    for section in document.sections:
        for part in (section.header, section.footer):
            if part is None or part.is_linked_to_previous:
                continue
            for paragraph in part.paragraphs:
                text = paragraph.text.strip()
                if text and text not in seen:
                    seen.add(text)
                    lines.append(text)
    return lines


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: docx_to_text.py <input.docx> <output.txt>\n")
        return 2
    try:
        document = Document(sys.argv[1])
    except Exception as exc:  # python-docx raises several types for unreadable files
        sys.stderr.write(f"Could not open the file as a Word document: {exc}\n")
        return 1

    lines = body_lines(document)
    extra = header_footer_lines(document)
    if extra:
        lines.append("")
        lines.append("[Headers and footers]")
        lines.extend(extra)

    with open(sys.argv[2], "w", encoding="utf-8") as out:
        out.write("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
