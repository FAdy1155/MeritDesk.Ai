#!/usr/bin/env python3
"""
Build Respondent's Written Pleadings (Houston Immigration Court) for the firm
named in the config.

Multi-tenant copy of the generator embedded in
skills-content/eoir-written-pleadings/SKILL.md ("Generator script (save as
make_pleadings.py)"), which hard-codes one firm's counsel block, signer and
certificate of service in its FIRM dict. Only those parts differ here:

- the counsel block on the cover and the signature block on the pleadings
  page come from the config's "firm" and "signer" objects;
- the certificate of service names signer.name as the person who serves;
- the signature line carries the signer's signature image or a /s/ line
  when signer.signature asks for one (the bare line, as in the firm's
  exemplar, when it is "blank", which the app sends unless the attorney's
  note asks for the pleadings to be signed).

The app fills firm and signer server-side from the tenant's firm identity
(src/services/skill-runner/tools/eoir-written-pleadings.ts); the model never
supplies them. Everything else (page setup, fonts, the caption, the ten
numbered representations and their wording, the check boxes, the index, the
Houston DHS service block, the pleading declaration and the certificate of
interpretation) is the firm's script unchanged.

Usage:  python3 make_pleadings.py config.json "Written Pleadings - Client.docx"

Requires python-docx.

firm:   name, address_lines (one line each), phone, email, and optionally
        fax (its line is left out without one).
signer: name (as the certificate of service and a /s/ line print it),
        name_line (first line of the counsel block and of the signature
        block, e.g. "Jane Doe, Esq."), credential_lines (under name_line in
        the signature block: the bar line, or an accredited representative's
        title and EOIR ID), and signature: "image" (signature_image, a bare
        file name next to the config, on the signature line), "conformed"
        ("/s/ name" on the signature line) or "blank" (the bare line).
"""
import json
import os
import re
import sys

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Emu, Inches, Pt, Twips

FONT = "Times New Roman"
BODY_PT = 11
FILLED = "■"   # black square
EMPTY = "□"    # white square
SECT = "§"     # section mark

# The DHS office the certificate of service names: the Office of the Principal
# Legal Advisor for the Houston Immigration Court, the same for every firm
# filing there (the "dhs" entry of the firm's FIRM dict).
DHS_SERVICE_BLOCK = ["Office of the Principal Legal Advisor - Houston",
                     "126 Northpoint Drive, Room 2020", "Houston, TX 77060", "United States"]

SIGNATURE_LINE = "_____________________________"
SIGNATURE_MODES = ("image", "conformed", "blank")
# The signature image is scaled to this height, then narrowed to the width
# cap if it is very wide, keeping its proportions.
SIGNATURE_HEIGHT = Inches(0.45)
SIGNATURE_MAX_WIDTH = Inches(2.4)
# The signature image must be a plain file name next to the config file.
SIGNATURE_FILE_NAME = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]*$")

RELIEF_ORDER = [
    ("termination", "Termination of Proceedings"),
    ("asylum", "Asylum"),
    ("withholding", "Withholding of Removal (Restriction on Removal)"),
    ("cat", "Protection under the Convention Against Torture"),
    ("adjustment", "Adjustment of Status"),
    ("cancellation", "Cancellation of Removal pursuant to INA {s} {cancellation_section}"),
    ("waiver", "Waiver of Inadmissibility pursuant to INA {s} {waiver_section}"),
    ("voluntary_departure", "Voluntary Departure"),
    ("other", "Other (Respondent respectfully reserves the right to designate and apply for any and all "
              "forms of relief for which {he} may be eligible, within the timeframe set by the Court.)"),
    ("none", "None"),
]


def set_cell_borders(cell, **edges):
    tcPr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    for edge in ("top", "left", "bottom", "right"):
        val = edges.get(edge, "none")
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), val)
        el.set(qn("w:sz"), "6" if val == "single" else "0")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "000000" if val == "single" else "FFFFFF")
        borders.append(el)
    tcPr.append(borders)


def no_table_borders(table):
    tblPr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "none")
        el.set(qn("w:sz"), "0")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "FFFFFF")
        borders.append(el)
    tblPr.append(borders)


def set_col_widths(table, widths_twips):
    table.autofit = False
    grid = table._tbl.tblGrid
    for gc, w in zip(grid.findall(qn("w:gridCol")), widths_twips):
        gc.set(qn("w:w"), str(w))
    for row in table.rows:
        for cell, w in zip(row.cells, widths_twips):
            cell.width = Twips(w)


def shade(cell, fill="D9D9D9"):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tcPr.append(shd)


def run(par, text, bold=False, italic=False, underline=False, size=BODY_PT):
    r = par.add_run(text)
    r.font.name = FONT
    r._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    r.font.size = Pt(size)
    r.bold = bold
    r.italic = italic
    r.underline = underline
    return r


def para(container, text="", bold=False, italic=False, underline=False, align=None,
         after=0, before=0, line=None, left=None, hanging=None, first=None, size=BODY_PT):
    p = container.add_paragraph()
    pf = p.paragraph_format
    pf.space_after = Pt(after)
    pf.space_before = Pt(before)
    if line is not None:
        pf.line_spacing = line
    if left is not None:
        pf.left_indent = Twips(left)
    if hanging is not None:
        pf.first_line_indent = Twips(-hanging)
    if first is not None:
        pf.first_line_indent = Twips(first)
    if align is not None:
        p.alignment = align
    if text:
        run(p, text, bold=bold, italic=italic, underline=underline, size=size)
    return p


def rich(container, parts, align=WD_ALIGN_PARAGRAPH.JUSTIFY, after=6, line=1.5,
         left=None, hanging=None, first=None):
    p = para(container, align=align, after=after, line=line, left=left, hanging=hanging, first=first)
    for text, style in parts:
        run(p, text, bold="b" in style, italic="i" in style, underline="u" in style)
    return p


def page_break(doc):
    p = doc.add_paragraph()
    p.add_run().add_break(WD_BREAK.PAGE)


def cell_par(cell, text="", **kw):
    if len(cell.paragraphs) == 1 and not cell.paragraphs[0].text and not cell.paragraphs[0].runs:
        p = cell.paragraphs[0]
        pf = p.paragraph_format
        pf.space_after = Pt(kw.get("after", 0))
        pf.space_before = Pt(kw.get("before", 0))
        if kw.get("align") is not None:
            p.alignment = kw["align"]
        if text:
            run(p, text, bold=kw.get("bold", False), italic=kw.get("italic", False),
                underline=kw.get("underline", False), size=kw.get("size", BODY_PT))
        return p
    return para(cell, text, **kw)


def contact_lines(firm):
    """The office and fax lines, as the firm prints them; no fax line without a fax."""
    lines = ["Office: %s" % firm["phone"]]
    if firm.get("fax"):
        lines.append("Fax: %s" % firm["fax"])
    return lines


def counsel_block(doc, cfg):
    firm = cfg["firm"]
    t = doc.add_table(rows=1, cols=2)
    no_table_borders(t)
    set_col_widths(t, [4200, 5160])
    left, right = t.rows[0].cells
    cell_par(left, cfg["signer"]["name_line"])
    para(left, firm["name"], bold=True)
    for line in list(firm["address_lines"]) + contact_lines(firm) + [firm["email"]]:
        para(left, line)
    cell_par(right, "NON-DETAINED", bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)


def add_signature_image(p, image_path):
    """The signature image in paragraph p, scaled to the signature height and width cap."""
    shape = p.add_run().add_picture(image_path, height=SIGNATURE_HEIGHT)
    width, height = shape.width, shape.height
    if width > SIGNATURE_MAX_WIDTH:
        shape.width = Emu(int(SIGNATURE_MAX_WIDTH))
        shape.height = Emu(int(height * SIGNATURE_MAX_WIDTH / width))


def signature_line(cell, signer, signature_path):
    """The signature line at the top of the signature block: the signer's image or /s/ line above it, or the bare line."""
    mode = signer.get("signature", "blank")
    if mode == "image":
        add_signature_image(cell_par(cell, before=6), signature_path)
        para(cell, SIGNATURE_LINE)
    elif mode == "conformed":
        cell_par(cell, "/s/ %s" % signer["name"], before=12)
        para(cell, SIGNATURE_LINE)
    else:
        cell_par(cell, SIGNATURE_LINE, before=12)


def signature_block_lines(cfg):
    """Name, credentials, firm, address, office and fax, in the order the firm's block prints them."""
    firm, signer = cfg["firm"], cfg["signer"]
    return ([signer["name_line"]] + list(signer["credential_lines"]) + [firm["name"]] +
            list(firm["address_lines"]) + contact_lines(firm))


def court_heading(doc, before=0):
    lines = ["UNITED STATES DEPARTMENT OF JUSTICE", "EXECUTIVE OFFICE FOR IMMIGRATION REVIEW",
             "IMMIGRATION COURT", "HOUSTON, TEXAS"]
    for i, l in enumerate(lines):
        para(doc, l, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, before=before if i == 0 else 0)


def caption(doc, cfg):
    t = doc.add_table(rows=1, cols=3)
    no_table_borders(t)
    set_col_widths(t, [5011, 320, 4090])
    left, mid, right = t.rows[0].cells
    set_cell_borders(left, top="single", bottom="single")
    cell_par(left, "  In the Matter of:", before=6)
    para(left)
    para(left, cfg["name_caption"], bold=True)
    para(left, "Respondent", after=6)
    cell_par(mid, SECT, bold=True)
    for _ in range(6):
        para(mid, SECT, bold=True)
    cell_par(right)
    para(right)
    para(right, f"File No.: {cfg['a_number']}", bold=True)
    para(right)
    para(right, "In Removal Proceedings")


def title(doc, text, before=12, after=12):
    para(doc, text, bold=True, underline=True, align=WD_ALIGN_PARAGRAPH.CENTER, before=before, after=after)


def checkbox_line(doc, checked, text, left=1080, after=6):
    return para(doc, f"{FILLED if checked else EMPTY} {text}", left=left, after=after, line=1.5)


def _tab(p, pos):
    pPr = p._p.get_or_add_pPr()
    tabs = OxmlElement("w:tabs")
    tab = OxmlElement("w:tab")
    tab.set(qn("w:val"), "left")
    tab.set(qn("w:pos"), str(pos))
    tabs.append(tab)
    pPr.append(tabs)


def numbered(doc, n, parts, after=6):
    p = para(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, after=after, line=1.5, left=720, hanging=360)
    run(p, f"{n}.\t")
    for text, style in parts:
        run(p, text, bold="b" in style, italic="i" in style, underline="u" in style)
    _tab(p, 720)
    return p


def lettered(doc, letter, text):
    p = para(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, after=4, line=1.5, left=1440, hanging=360)
    run(p, f"{letter}.\t{text}")
    _tab(p, 1440)
    return p


def allegations_sentence(cfg):
    adm = cfg.get("admit", [])
    den = cfg.get("deny", [])

    def fmt(nums):
        nums = [str(n) for n in nums]
        if len(nums) == 1:
            return f"Allegation {nums[0]}"
        if len(nums) == 2:
            return f"Allegations {nums[0]} and {nums[1]}"
        return "Allegations " + ", ".join(nums[:-1]) + f", and {nums[-1]}"

    parts = []
    if adm:
        parts.append(f"Respondent admits {fmt(adm)}")
    if den:
        parts.append(("Respondent denies " if not adm else "denies ") + fmt(den) +
                     " and demands that the Department of Homeland Security prove them by clear and convincing evidence")
    return (" and ".join(parts) if adm and den else "".join(parts)) + "."


def charge_sentence(cfg):
    charges = cfg["charges"]
    conc = [c["section"] for c in charges if c.get("concede", True)]
    deny = [c["section"] for c in charges if not c.get("concede", True)]
    s = []
    if conc:
        s.append("Respondent concedes the charge of removability under INA " + SECT + " " + (", INA " + SECT + " ").join(conc))
    if deny:
        s.append("Respondent denies the charge of removability under INA " + SECT + " " + (", INA " + SECT + " ").join(deny) +
                 " and demands that the Department of Homeland Security prove removability by clear and convincing evidence")
    return ". ".join(s) + "."


def build(cfg, out_path, signature_path=None):
    doc = Document()
    sec = doc.sections[0]
    sec.page_width = Twips(12240)
    sec.page_height = Twips(15840)
    sec.top_margin = Twips(1350)
    sec.bottom_margin = Twips(1440)
    sec.left_margin = Twips(1440)
    sec.right_margin = Twips(1440)

    st = doc.styles["Normal"]
    st.font.name = FONT
    st.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    st.font.size = Pt(BODY_PT)
    st.paragraph_format.space_after = Pt(0)

    he = cfg.get("pronoun", "he")

    # Page 1: cover
    counsel_block(doc, cfg)
    para(doc)
    para(doc)
    court_heading(doc)
    para(doc)
    para(doc)
    caption(doc, cfg)
    para(doc)
    para(doc)
    t = doc.add_table(rows=1, cols=2)
    no_table_borders(t)
    set_col_widths(t, [4680, 4680])
    cell_par(t.rows[0].cells[0], f"Immigration Judge: {cfg['judge']}")
    cell_par(t.rows[0].cells[1], f"Next Hearing: {cfg['next_hearing']}", align=WD_ALIGN_PARAGRAPH.RIGHT)
    for _ in range(4):
        para(doc)
    title(doc, "RESPONDENT'S WRITTEN PLEADINGS")
    page_break(doc)

    # Page 2: pleadings
    court_heading(doc)
    para(doc)
    caption(doc, cfg)
    title(doc, "RESPONDENT'S WRITTEN PLEADINGS", before=18, after=12)

    rich(doc, [
        ("COMES NOW", "b"), (", ", ""), (cfg["name_full"], "b"),
        (" (\"Respondent\"), by and through undersigned counsel, and hereby files this Respondent's Written "
         "Pleadings in accordance with Chapter 3 of the Executive Office for Immigration Review (\"EOIR\") "
         "Immigration Court Practice Manual. In support thereof, Respondent makes the following representations:", ""),
    ], first=720, after=8)

    service_phrase = cfg.get("service_phrase") or f"served on Respondent by {cfg['service_method']} on {cfg['nta_served_date']}"
    numbered(doc, 1, [
        ("Respondent concedes proper service of the Notice to Appear (Form I-862), dated ", ""),
        (cfg["nta_date"], "b"),
        (f", {service_phrase}, and filed with this Court on ", ""),
        (cfg["nta_filed_date"], "b"),
        (". ", ""), ("See", "i"), (" Tab A - Notice to Appear (\"NTA\").", ""),
    ])

    numbered(doc, 2, [("Counsel has explained to the respondent (through an interpreter, if necessary):", "")], after=4)
    lettered(doc, "a", f"the rights set forth in 8 C.F.R. {SECT} 1240.10(a);")
    lettered(doc, "b", f"the consequences of failing to appear in court as set forth in INA {SECT} 240(b)(5);")
    lettered(doc, "c", f"the limitation on discretionary relief for failure to appear set forth in INA {SECT} 240(b)(7);")
    lettered(doc, "d", f"the consequences of knowingly filing or making a frivolous application as set forth in INA {SECT} 208(d)(6);")
    lettered(doc, "e", f"the requirement to notify the court within five days of any change of address or telephone number, "
                       f"using Form EOIR-33/IC pursuant to 8 C.F.R. {SECT} 1003.15(d).")

    numbered(doc, 3, [(allegations_sentence(cfg), "")])
    numbered(doc, 4, [(charge_sentence(cfg), "")])

    numbered(doc, 5, [("In the event of removal, the Respondent", "")], after=4)
    country = cfg.get("country_designated")
    if country:
        checkbox_line(doc, True, f"names {country} as the country to which removal should be directed;")
    else:
        checkbox_line(doc, False, "names                 as the country to which removal should be directed;")
    para(doc, "OR", left=1440, after=4, line=1.5)
    checkbox_line(doc, not country, "declines to designate a country of removal.")

    numbered(doc, 6, [("The respondent will be applying for the following forms of relief from removal:", "")], after=4)
    relief = cfg.get("relief", {})
    for key, label in RELIEF_ORDER:
        text = label.format(s=SECT, he=he,
                            cancellation_section=cfg.get("cancellation_section", "_____"),
                            waiver_section=cfg.get("waiver_section", "_____"))
        checkbox_line(doc, bool(relief.get(key, False)), text)

    numbered(doc, 7, [(
        "If the relief from removal requires an application, the respondent will file the application (other than "
        "asylum), no later than fifteen (15) days before the date of the individual calendar hearing, unless otherwise "
        "directed by the court. The respondent acknowledges that, if the application(s) are not timely filed, the "
        f"application(s) will be deemed waived and abandoned under 8 C.F.R. {SECT} 1003.31(c).", "")])

    numbered(doc, 8, [(
        "If background and security investigations are required, the respondent has received the DHS biometrics "
        "instructions and will timely comply with the instructions. I have explained the instructions to the respondent "
        "(through an interpreter, if necessary). In addition, I have explained to the respondent (through an interpreter, "
        f"if necessary), that, under 8 C.F.R. {SECT} 1003.47(d), failure to provide biometrics or other biographical "
        "information within the time allowed will constitute abandonment of the application unless the respondent "
        "demonstrates that such failure was the result of good cause. ", ""), ("See", "i"),
        (" Tab B - Respondent's Pleading Declaration.", "")])

    numbered(doc, 9, [("The respondent estimates that ", ""), (str(cfg.get("hours", 3)), "b"),
                      (" hours will be required for the respondent to present the case.", "")])

    lang = cfg.get("language")
    needs_interp = bool(lang) and lang.lower() != "english"
    numbered(doc, 10, [(f"{FILLED if needs_interp else EMPTY} It is requested that the Immigration Court order an "
                        f"interpreter proficient in the {lang if needs_interp else '__________'} language.", "")], after=4)
    para(doc, "OR", left=1440, after=4, line=1.5)
    checkbox_line(doc, not needs_interp, "The respondent speaks English and does not require the services of an interpreter.", left=720)

    para(doc)
    rich(doc, [("WHEREFORE", "b"),
               (", premises considered, Respondent respectfully requests this Honorable Court to accept the foregoing "
                "written pleadings to be entered as exhibits.", "")], first=720, after=18)

    t = doc.add_table(rows=1, cols=2)
    no_table_borders(t)
    set_col_widths(t, [4200, 5160])
    l, r = t.rows[0].cells
    cell_par(l, cfg["sign_date"])
    para(l, "  Date")
    signature_line(r, cfg["signer"], signature_path)
    for line in signature_block_lines(cfg):
        para(r, line)
    page_break(doc)

    # Page 3: index
    court_heading(doc)
    para(doc)
    caption(doc, cfg)
    title(doc, "INDEX", before=18, after=6)
    t = doc.add_table(rows=5, cols=3)
    set_col_widths(t, [900, 7060, 1400])
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    tblPr = t._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "none"); el.set(qn("w:sz"), "0"); el.set(qn("w:space"), "0"); el.set(qn("w:color"), "FFFFFF")
        borders.append(el)
    for edge in ("insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single"); el.set(qn("w:sz"), "4"); el.set(qn("w:space"), "0"); el.set(qn("w:color"), "auto")
        borders.append(el)
    tblPr.append(borders)
    hdr = t.rows[0].cells
    for c, txt in zip(hdr, ("TAB", "DESCRIPTION", "PAGES")):
        shade(c)
        cell_par(c, txt, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, size=9)
    charge_list = ", ".join(f"INA {SECT} {c['section']}" for c in cfg["charges"])
    rows = [
        ("", "Respondent's Written Pleadings", ""),
        ("A", f"Notice to Appear (Form I-862), dated {cfg['nta_date']}, charging removability under {charge_list}, "
              f"served on Respondent by {cfg['service_method']} on {cfg['nta_served_date']}, together with the Certificate of Service.", ""),
        ("B", "Respondent's Pleading Declaration and Certificate of Interpretation.", ""),
        ("", "Certificate of Service.", ""),
    ]
    for row, (tab, desc, pages) in zip(t.rows[1:], rows):
        cell_par(row.cells[0], tab, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, size=9)
        cell_par(row.cells[1], desc, size=9)
        cell_par(row.cells[2], pages, size=9)
    page_break(doc)

    # Page 4: certificate of service
    para(doc, cfg["name_caption"], bold=True)
    para(doc, f"File No.: {cfg['a_number']}", bold=True)
    title(doc, "CERTIFICATE OF SERVICE", before=36, after=18)
    para(doc, f"On [DATE], {cfg['signer']['name']}, served a copy of this Written Pleadings, to the following:", after=24)
    para(doc, "By eService", align=WD_ALIGN_PARAGRAPH.CENTER, after=12)
    for line in DHS_SERVICE_BLOCK:
        para(doc, line, align=WD_ALIGN_PARAGRAPH.CENTER)
    for _ in range(5):
        para(doc)
    t = doc.add_table(rows=2, cols=2)
    no_table_borders(t)
    set_col_widths(t, [4680, 4680])
    cell_par(t.rows[0].cells[0], "___________________________")
    cell_par(t.rows[0].cells[1], "_______________________", align=WD_ALIGN_PARAGRAPH.RIGHT)
    cell_par(t.rows[1].cells[0], "Signature")
    cell_par(t.rows[1].cells[1], "Date", align=WD_ALIGN_PARAGRAPH.RIGHT)
    page_break(doc)

    # Page 5: pleading declaration and certificate of interpretation
    title(doc, "RESPONDENT'S PLEADING DECLARATION", before=0, after=12)
    decl = [
        f"I, {cfg['name_full']}, have been advised of my rights in these proceedings by my attorney or representative. "
        "I understand those rights. I waive a further explanation of those rights by this court.",
        "I have been advised by my attorney or representative of the consequences of failing to appear for a hearing. "
        "I have also been advised by my attorney of the consequences of failing to appear for a scheduled date of "
        "departure or deportation. I understand those consequences.",
        "I have been advised by my attorney or representative of the consequences of knowingly filing a frivolous "
        "application. I understand those consequences.",
        "I have been advised by my attorney or representative of the consequences of failing to follow the DHS "
        "biometrics instructions within the time allowed. I understand those consequences.",
        "I understand that if my mailing address changes, I must notify the court within 5 days of such change by "
        "completing an Alien's Change of Address Form (Form EOIR-33/IC) and filing it with this court.",
        "Finally, my attorney or representative has explained to me what this Written Pleading says. I understand it, "
        "I agree with it, and I request that the court accept it as my pleading.",
    ]
    for d in decl:
        para(doc, d, align=WD_ALIGN_PARAGRAPH.JUSTIFY, after=6, line=1.3)
    para(doc)
    t = doc.add_table(rows=3, cols=2)
    no_table_borders(t)
    set_col_widths(t, [5400, 3960])
    cell_par(t.rows[0].cells[0], "______________________________")
    cell_par(t.rows[0].cells[1], f"__________________, {cfg.get('year', cfg['sign_date'][-4:])}")
    cell_par(t.rows[1].cells[0], cfg["name_full"])
    cell_par(t.rows[1].cells[1], "Date")
    cell_par(t.rows[2].cells[0], "Respondent")
    para(doc)
    title(doc, "CERTIFICATE OF INTERPRETATION", before=6, after=8)
    para(doc, "I, ______________________________, am competent to translate and interpret from", line=1.3)
    para(doc, "(name of interpreter)", left=720, size=9, after=6)
    para(doc, "____________________________ into English, and I certify that I have read this entire document to", line=1.3)
    para(doc, "(name of language)", left=720, size=9, after=6)
    para(doc, f"the respondent in ________________________, and that the respondent stated that {he} understood", line=1.3)
    para(doc, "(name of language)", left=3600, size=9, after=6)
    para(doc, f"the document before {he} signed the Pleading Declaration above.", line=1.3, after=18)
    para(doc, "_____________________________________________", after=0)
    para(doc, "(signature of interpreter)", size=9, after=12)
    para(doc, "_____________________________________________", after=0)
    para(doc, "(typed/printed name of interpreter)", size=9)

    doc.save(out_path)
    print("wrote", out_path)


def check_firm_and_signer(cfg, config_path):
    """The counsel block and signer the app filled in. Returns the signature image path, or None."""
    firm = cfg.get("firm")
    if not isinstance(firm, dict):
        sys.exit("ERROR: config is missing required key: firm")
    for key in ("name", "phone", "email"):
        if not isinstance(firm.get(key), str) or not firm[key].strip():
            sys.exit("ERROR: config is missing required key: firm.%s" % key)
    lines = firm.get("address_lines")
    if not isinstance(lines, list) or not lines or not all(isinstance(line, str) and line.strip() for line in lines):
        sys.exit("ERROR: config is missing required key: firm.address_lines")
    if firm.get("fax") is not None and not isinstance(firm["fax"], str):
        sys.exit("ERROR: firm.fax must be a string")

    signer = cfg.get("signer")
    if not isinstance(signer, dict):
        sys.exit("ERROR: config is missing required key: signer")
    for key in ("name", "name_line"):
        if not isinstance(signer.get(key), str) or not signer[key].strip():
            sys.exit("ERROR: config is missing required key: signer.%s" % key)
    creds = signer.get("credential_lines")
    if not isinstance(creds, list) or not creds or not all(isinstance(line, str) and line.strip() for line in creds):
        sys.exit("ERROR: config is missing required key: signer.credential_lines")
    mode = signer.get("signature", "blank")
    if mode not in SIGNATURE_MODES:
        sys.exit("ERROR: signer.signature must be one of %s" % ", ".join(SIGNATURE_MODES))
    if mode != "image":
        return None
    name = signer.get("signature_image")
    if not isinstance(name, str) or not SIGNATURE_FILE_NAME.match(name):
        sys.exit("ERROR: signer.signature_image must be a plain file name next to the config")
    path = os.path.join(os.path.dirname(os.path.abspath(config_path)), name)
    if not os.path.isfile(path):
        sys.exit("ERROR: signature image not found: %s" % name)
    return path


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: make_pleadings.py config.json out.docx")
    with open(sys.argv[1], encoding="utf-8") as f:
        config = json.load(f)
    build(config, sys.argv[2], check_firm_and_signer(config, sys.argv[1]))
