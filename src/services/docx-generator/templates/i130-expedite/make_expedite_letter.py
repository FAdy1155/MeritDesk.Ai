#!/usr/bin/env python3
"""
Build an I-130 expedite letter on the letterhead of the firm named in the spec.

Multi-tenant copy of skills-content/i130-expedite-build/assets/make_expedite_letter.py
(the firm's canonical script, which hard-codes one firm's letterhead and
signer). Only the letterhead and the signature block differ: they come from
the spec's "firm" and "signer" objects, which the app fills server-side from
the tenant's firm identity (src/services/skill-runner/tools.ts); the model
never supplies them. The ASCII gate, the required-key checks and the RE line
check are unchanged.

Usage:
    python3 make_expedite_letter.py spec.json out.docx

The spec is JSON. See SPEC_TEMPLATE at the bottom of this file, or run:
    python3 make_expedite_letter.py --template > spec.json

Formatting is reverse engineered from the original firm's filed letters and
is reproduced exactly: Times New Roman 12pt body, 16pt bold firm name, 14pt
bold address lines, italic licensure line, a bordered phone and email block,
and a one inch top and bottom margin with 1.25 inch left and right margins.

Signature block: "Sincerely," (or the spec's closing), then, by
signer.signature: "image" puts the signature image (signer.signature_image,
a bare file name in the spec file's directory) above the typed name;
"conformed" puts "/s/ <name>" above it; "blank" leaves four blank lines for a
wet signature, as the original does. The typed name follows, then the
signer's title when there is one.

Inline emphasis: wrap a phrase in **double asterisks** anywhere in a body
paragraph and it comes out bold. Nothing else is interpreted, so ordinary
text passes through untouched.

Plain ASCII only. The script refuses to write a file containing an em dash,
an en dash, a curly quote, or any other non ASCII character, because those
characters do not survive the firm's print and scan workflow cleanly.
"""

import json
import os
import re
import sys

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml.ns import qn
from docx.shared import Emu, Inches, Pt

# Text width in twips: 12240 page - 1800 left - 1800 right.
RIGHT_TAB = 8640

# The signature image is scaled to this height, then narrowed to the width
# cap if it is very wide, keeping its proportions.
SIGNATURE_HEIGHT = Inches(0.6)
SIGNATURE_MAX_WIDTH = Inches(2.5)

SIGNATURE_MODES = ("image", "conformed", "blank")
# The signature image must be a plain file name next to the spec file.
SIGNATURE_FILE_NAME = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]*$")


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


def add_signature_image(doc, image_path):
    """The signature image on its own line, scaled to the signature height and width cap."""
    run = doc.add_paragraph().add_run()
    shape = run.add_picture(image_path, height=SIGNATURE_HEIGHT)
    width, height = shape.width, shape.height
    if width > SIGNATURE_MAX_WIDTH:
        shape.width = Emu(int(SIGNATURE_MAX_WIDTH))
        shape.height = Emu(int(height * SIGNATURE_MAX_WIDTH / width))


def build(spec, out_path, signature_path=None):
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

    # ---- letterhead, from the spec's firm object: name and address in
    # capitals as on the original letterhead, then the optional licensure and
    # website lines, then the phone / email block with the rule under it.
    firm = spec["firm"]
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_run(p, firm["name"].upper(), bold=True, size=16)

    for line in firm["address_lines"]:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        add_run(p, line.upper(), bold=True, size=14)

    for line in (firm.get("licensure_line"), firm.get("website")):
        if line:
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            add_run(p, line, italic=True)

    p = doc.add_paragraph()
    p.paragraph_format.tab_stops.add_tab_stop(
        Inches(RIGHT_TAB / 1440), WD_TAB_ALIGNMENT.RIGHT
    )
    add_run(p, firm["phone"], bold=True, italic=True)
    add_run(p, "\t", bold=True, italic=True)
    add_run(p, "Email Address", bold=True, italic=True)

    p = doc.add_paragraph()
    p.paragraph_format.tab_stops.add_tab_stop(
        Inches(RIGHT_TAB / 1440), WD_TAB_ALIGNMENT.RIGHT
    )
    if firm.get("fax"):
        add_run(p, "%s(fax)" % firm["fax"], bold=True, italic=True)
    add_run(p, "\t", bold=True, italic=True)
    add_run(p, firm["email"], bold=True, italic=True)
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

    # ---- signature block, from the spec's signer object
    signer = spec["signer"]
    mode = signer.get("signature", "blank")
    add_run(doc.add_paragraph(), spec.get("closing", "Sincerely,"))
    if mode == "image":
        blank(doc)
        add_signature_image(doc, signature_path)
    elif mode == "conformed":
        blank(doc)
        blank(doc)
        add_run(doc.add_paragraph(), "/s/ %s" % signer["name"])
    else:
        for _ in range(4):
            blank(doc)
    add_run(doc.add_paragraph(), signer["name"])
    if signer.get("title"):
        add_run(doc.add_paragraph(), signer["title"])

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
    "firm": {
        "name": "[FIRM NAME]",
        "address_lines": ["[STREET ADDRESS]", "[CITY, STATE ZIP]"],
        "licensure_line": "",
        "phone": "[FIRM PHONE]",
        "fax": "",
        "email": "[FIRM EMAIL]",
        "website": "",
    },
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
    "signer": {
        "name": "[ATTORNEY NAME]",
        "title": "",
        "signature": "blank",
    },
    "enclosures": [],
}


def check_firm_and_signer(spec, spec_path):
    """The letterhead and signer the app filled in. Returns the signature image path, or None."""
    firm = spec.get("firm")
    if not isinstance(firm, dict):
        raise SystemExit("ERROR: spec is missing required key: firm")
    for key in ("name", "phone", "email"):
        if not isinstance(firm.get(key), str) or not firm[key].strip():
            raise SystemExit("ERROR: spec is missing required key: firm.%s" % key)
    lines = firm.get("address_lines")
    if not isinstance(lines, list) or not lines or not all(isinstance(line, str) and line.strip() for line in lines):
        raise SystemExit("ERROR: spec is missing required key: firm.address_lines")
    for key in ("licensure_line", "fax", "website"):
        if firm.get(key) is not None and not isinstance(firm[key], str):
            raise SystemExit("ERROR: firm.%s must be a string" % key)

    signer = spec.get("signer")
    if not isinstance(signer, dict) or not isinstance(signer.get("name"), str) or not signer["name"].strip():
        raise SystemExit("ERROR: spec is missing required key: signer.name")
    if signer.get("title") is not None and not isinstance(signer["title"], str):
        raise SystemExit("ERROR: signer.title must be a string")
    mode = signer.get("signature", "blank")
    if mode not in SIGNATURE_MODES:
        raise SystemExit("ERROR: signer.signature must be one of %s" % ", ".join(SIGNATURE_MODES))
    if mode != "image":
        return None
    name = signer.get("signature_image")
    if not isinstance(name, str) or not SIGNATURE_FILE_NAME.match(name):
        raise SystemExit("ERROR: signer.signature_image must be a plain file name next to the spec")
    path = os.path.join(os.path.dirname(os.path.abspath(spec_path)), name)
    if not os.path.isfile(path):
        raise SystemExit("ERROR: signature image not found: %s" % name)
    return path


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
    signature_path = check_firm_and_signer(spec, args[0])
    print("Wrote %s" % build(spec, args[1], signature_path))


if __name__ == "__main__":
    main()
