#!/usr/bin/env python3
"""
Build an I-130 expedite letter on the letterhead of
THE LAW FIRM OF NISREEN S. MOUSA, P.C.

Usage:
    python3 make_expedite_letter.py spec.json out.docx

The spec is JSON. See SPEC_TEMPLATE at the bottom of this file, or run:
    python3 make_expedite_letter.py --template > spec.json

Formatting is reverse engineered from the firm's own filed letters and is
reproduced exactly: Times New Roman 12pt body, 16pt bold firm name, 14pt bold
address lines, italic licensure line, a bordered phone and email block, and a
one inch top and bottom margin with 1.25 inch left and right margins.

Inline emphasis: wrap a phrase in **double asterisks** anywhere in a body
paragraph and it comes out bold. Nothing else is interpreted, so ordinary
text passes through untouched.

Plain ASCII only. The script refuses to write a file containing an em dash,
an en dash, a curly quote, or any other non ASCII character, because those
characters do not survive the firm's print and scan workflow cleanly.
"""

import json
import re
import sys

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml.ns import qn
from docx.shared import Inches, Pt

FIRM_NAME = "THE LAW FIRM OF NISREEN S. MOUSA, P.C."
FIRM_ADDRESS = ["3730 KIRBY DRIVE, SUITE 1200", "HOUSTON, TEXAS 77098"]
FIRM_LICENSURE = "Licensed in Texas and Florida"
FIRM_PHONE = "713-828-0365"
FIRM_FAX = "281-997-6207"
FIRM_EMAIL = "nmousalaw@yahoo.com"
DEFAULT_SIGNER = "Nisreen Mousa"

# Text width in twips: 12240 page - 1800 left - 1800 right.
RIGHT_TAB = 8640


# ----------------------------------------------------------------- ASCII gate

ASCII_FIXES = {
    " — ": ", ",
    " – ": ", ",
    "—": ", ",
    "–": "-",
    "‘": "'",
    "’": "'",
    "“": '"',
    "”": '"',
    "…": "...",
    " ": " ",
    "•": "-",
    "­": "",
}


ALLOW_NONASCII = False
NONASCII_SEEN = {}


def ascii_only(text, path="spec"):
    """Normalize typographic punctuation. Then stop on anything else non ASCII.

    Typographic punctuation is silently replaced: an em dash becomes a comma and
    a space, curly quotes become straight quotes, and so on. Anything else non
    ASCII, which in practice means a diacritic in a proper name, is reported and
    stops the run unless --allow-nonascii is passed, so the attorney decides
    whether a client's name keeps its accent rather than the script deciding.
    """
    if not isinstance(text, str):
        return text
    for bad, good in ASCII_FIXES.items():
        text = text.replace(bad, good)
    offenders = sorted({c for c in text if ord(c) > 126 or (ord(c) < 32 and c != "\t")})
    for c in offenders:
        NONASCII_SEEN.setdefault(c, path)
    return text


def report_nonascii():
    if not NONASCII_SEEN:
        return
    lines = [
        "%s  U+%04X  first seen in %s" % (c, ord(c), p)
        for c, p in sorted(NONASCII_SEEN.items())
    ]
    detail = "\n".join("  " + line for line in lines)
    if ALLOW_NONASCII:
        sys.stderr.write(
            "WARNING: non ASCII characters kept in the document:\n%s\n" % detail
        )
        return
    raise SystemExit(
        "ERROR: non ASCII characters in the spec:\n%s\n\n"
        "The firm's letters are plain ASCII. Either replace these characters, or\n"
        "rerun with --allow-nonascii if a client's name genuinely carries an accent." % detail
    )


def scrub(obj, path="spec"):
    if isinstance(obj, str):
        return ascii_only(obj, path)
    if isinstance(obj, list):
        return [scrub(v, "%s[%d]" % (path, i)) for i, v in enumerate(obj)]
    if isinstance(obj, dict):
        return {k: scrub(v, "%s.%s" % (path, k)) for k, v in obj.items()}
    return obj


# ------------------------------------------------------------------- builders


def add_run(par, text, bold=False, italic=False, size=None, underline=False):
    run = par.add_run(text)
    run.bold = bold
    run.italic = italic
    run.underline = underline
    if size:
        run.font.size = Pt(size)
    return run


def bottom_border(par):
    """Single 1.5pt rule under the paragraph, matching the firm letterhead."""
    pPr = par._p.get_or_add_pPr()
    pBdr = pPr.makeelement(qn("w:pBdr"), {})
    bottom = pPr.makeelement(qn("w:bottom"), {})
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "12")
    bottom.set(qn("w:space"), "0")
    bottom.set(qn("w:color"), "auto")
    pBdr.append(bottom)
    pPr.append(pBdr)


def emphasized(par, text):
    """Render **bold** spans inline. Everything else is plain."""
    for i, chunk in enumerate(re.split(r"\*\*", text)):
        if chunk:
            add_run(par, chunk, bold=bool(i % 2))


def blank(doc):
    return doc.add_paragraph()


def build(spec, out_path):
    doc = Document()

    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(1)
    section.bottom_margin = Inches(1)
    section.left_margin = Inches(1.25)
    section.right_margin = Inches(1.25)

    normal = doc.styles["Normal"]
    normal.font.name = "Times New Roman"
    normal.font.size = Pt(12)
    rpr = normal.element.get_or_add_rPr().get_or_add_rFonts()
    rpr.set(qn("w:eastAsia"), "Times New Roman")
    rpr.set(qn("w:cs"), "Times New Roman")
    normal.paragraph_format.space_after = Pt(0)
    normal.paragraph_format.space_before = Pt(0)

    body_align = (
        WD_ALIGN_PARAGRAPH.JUSTIFY
        if spec.get("body_alignment", "justify") == "justify"
        else WD_ALIGN_PARAGRAPH.LEFT
    )

    # ---- letterhead
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_run(p, FIRM_NAME, bold=True, size=16)

    for line in FIRM_ADDRESS:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        add_run(p, line, bold=True, size=14)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_run(p, FIRM_LICENSURE, italic=True)

    p = doc.add_paragraph()
    p.paragraph_format.tab_stops.add_tab_stop(
        Inches(RIGHT_TAB / 1440), WD_TAB_ALIGNMENT.RIGHT
    )
    add_run(p, FIRM_PHONE, bold=True, italic=True)
    add_run(p, "\t", bold=True, italic=True)
    add_run(p, "Email Address", bold=True, italic=True)

    p = doc.add_paragraph()
    p.paragraph_format.tab_stops.add_tab_stop(
        Inches(RIGHT_TAB / 1440), WD_TAB_ALIGNMENT.RIGHT
    )
    add_run(p, "%s(fax)" % spec.get("fax", FIRM_FAX), bold=True, italic=True)
    add_run(p, "\t", bold=True, italic=True)
    add_run(p, spec.get("email", FIRM_EMAIL), bold=True, italic=True)
    bottom_border(p)

    # ---- date, sitting directly under the letterhead rule, as the firm does it
    add_run(doc.add_paragraph(), spec["letter_date"])
    blank(doc)

    # ---- recipient block
    for line in spec["recipient"]:
        add_run(doc.add_paragraph(), line)
    blank(doc)

    # ---- RE block
    p = doc.add_paragraph()
    p.paragraph_format.tab_stops.add_tab_stop(Inches(0.5), WD_TAB_ALIGNMENT.LEFT)
    add_run(p, "RE:")
    add_run(p, "\t")
    add_run(p, spec["re_heading"], bold=True, underline=True)
    for line in spec["re_lines"]:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Inches(0.5)
        add_run(p, line)
    blank(doc)

    # ---- salutation
    add_run(doc.add_paragraph(), spec.get("salutation", "Dear USCIS Officer,"))
    blank(doc)

    # ---- body
    for para in spec["body"]:
        p = doc.add_paragraph()
        p.alignment = body_align
        emphasized(p, para)
        blank(doc)

    # ---- exhibit list, indented, no blank lines between entries
    exhibits = spec.get("exhibits") or []
    if exhibits:
        for line in exhibits:
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Inches(0.5)
            emphasized(p, line)
        blank(doc)

    for para in spec.get("body_after_exhibits") or []:
        p = doc.add_paragraph()
        p.alignment = body_align
        emphasized(p, para)
        blank(doc)

    # ---- signature block
    add_run(doc.add_paragraph(), spec.get("closing", "Sincerely,"))
    for _ in range(4):
        blank(doc)
    add_run(doc.add_paragraph(), spec.get("signer", DEFAULT_SIGNER))

    enc = spec.get("enclosures") or []
    if enc:
        blank(doc)
        add_run(doc.add_paragraph(), "Enclosures:")
        for line in enc:
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Inches(0.5)
            add_run(p, line)

    doc.save(out_path)
    return out_path


SPEC_TEMPLATE = {
    "letter_date": "August 14, 2026",
    "fax": FIRM_FAX,
    "email": FIRM_EMAIL,
    "body_alignment": "justify",
    "recipient": [
        "USCIS",
        "Attn: I-130 (Box 21700)",
        "2108 E. Elliot Rd.",
        "Tempe, AZ 85284-1806",
    ],
    "re_heading": "URGENT REQUEST FOR EXPEDITE FORM I-130",
    "re_lines": [
        "JANE DOE - PETITIONER",
        "JOHN DOE - BENEFICIARY A#000-000-000",
        "I-130 Receipt Number: IOE0000000000",
    ],
    "salutation": "Dear USCIS Officer,",
    "body": [
        "I represent the Petitioner in the above-referenced Form I-130, Petition for Alien Relative, filed on behalf of her husband, as indicated in the enclosed Form G-28. I respectfully request **expedited adjudication** of this petition based on **urgent humanitarian reasons**.",
        "[ground paragraph]",
        "[hardship paragraph]",
    ],
    "exhibits": [
        "Exhibit A: [document]",
        "Exhibit B: [document]",
    ],
    "body_after_exhibits": [
        "Given these compelling circumstances, we respectfully request that USCIS **expedite the adjudication** of this Form I-130 petition.",
        "Thank you for your prompt attention to this urgent matter. Please do not hesitate to contact my office should additional documentation be required.",
    ],
    "closing": "Sincerely,",
    "signer": DEFAULT_SIGNER,
    "enclosures": [],
}


def main():
    global ALLOW_NONASCII
    args = [a for a in sys.argv[1:] if a != "--allow-nonascii"]
    ALLOW_NONASCII = "--allow-nonascii" in sys.argv[1:]
    if args and args[0] == "--template":
        print(json.dumps(SPEC_TEMPLATE, indent=2))
        return
    if len(args) != 2:
        raise SystemExit(
            "Usage: python3 make_expedite_letter.py spec.json out.docx [--allow-nonascii]\n"
            "       python3 make_expedite_letter.py --template > spec.json"
        )
    with open(args[0]) as fh:
        spec = scrub(json.load(fh))
    report_nonascii()
    for key in ("letter_date", "recipient", "re_heading", "re_lines", "body"):
        if not spec.get(key):
            raise SystemExit("ERROR: spec is missing required key: %s" % key)
    for i, line in enumerate(spec["re_lines"]):
        line = str(line)
        if ":" in line and not line.split(":", 1)[1].strip():
            raise SystemExit(
                "ERROR: RE line %d is a label with no value: %r\n"
                "A filed firm letter once went out with a blank receipt number line, which\n"
                "leaves USCIS unable to associate the request with a case. Fill it or cut it."
                % (i + 1, line)
            )
    print("Wrote %s" % build(spec, args[1]))


if __name__ == "__main__":
    main()
