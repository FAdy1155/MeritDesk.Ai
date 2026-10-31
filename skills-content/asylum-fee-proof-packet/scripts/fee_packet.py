#!/usr/bin/env python3
"""
fee_packet.py
Proof of payment packet for an EOIR asylum fee (Annual Asylum Fee or I-589 initial filing fee)
in the house format of The Law Firm of Nisreen S. Mousa, PC.

  python3 fee_packet.py read RECEIPT.pdf      print the receipt fields as JSON
  python3 fee_packet.py build CONFIG.json     write <file_stem>.docx and <file_stem>.pdf, print a report

forum "IC"  : Immigration Court cover letter (cover with judge and next hearing, COMES NOW,
              exhibit index, WHEREFORE, certificate of service). Exhibits are numbered from 1.
forum "BIA" : Submission of Proof of Payment to the Board (numbered paragraphs, index,
              certificate of service). Pages are numbered from the first page after the cover.

Needs python-docx, pdfplumber, Pillow, reportlab, and the qpdf, pdftoppm and soffice commands.
"""
import copy
import datetime as dt
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pdfplumber
from PIL import Image
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Emu, Pt, Twips

FONT = "Times New Roman"
SECT = "\u00a7"
EMU_PT = 12700
FIRM = {
    "attorney": "Nisreen S. Mousa, Esq.",
    "firm_pc": "The Law Firm of Nisreen S. Mousa, PC",
    "firm_pc_dots": "The Law Firm of Nisreen S. Mousa, P.C.",
    "firm_plain": "The Law Firm of Nisreen S. Mousa",
    "bar": "Texas Bar No. 24007713",
    "street": "3730 Kirby Drive, Suite 1200",
    "city_long": "Houston, Texas 77098",
    "city_short": "Houston, TX 77098",
    "phone": "Office: (713) 828-0365",
    "fax": "Fax: (346) 553-8491",
    "email": "nmousalaw@yahoo.com",
    "signer": "Ms. Nisreen S. Mousa",
}
DHS_IC = ["Office of the Principal Legal Advisor - HOU", "126 Northpoint Drive, Room 2020",
          "Houston, TX 77060", "United States"]
DHS_BIA = ["DHS/ICE Office of Chief Counsel - HOU", "126 Northpoint Drive, Room 2020", "Houston, TX 77060"]
ECAS_SENTENCE = ("This document was electronically filed through ECAS and both parties are participating "
                 "in ECAS. Therefore, no separate service was completed.")
FEES = {
    "annual": {"fee": "Annual Asylum Fee", "up": "ANNUAL ASYLUM FEE"},
    "initial": {"fee": "I-589 Initial Filing Fee", "up": "I-589 INITIAL FILING FEE"},
}
BLANK = "____________________"


# ----------------------------------------------------------------------------- dates
def parse_date(s):
    s = " ".join(str(s).replace(",", ", ").split()).replace(" ,", ",")
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%m/%d/%Y", "%Y-%m-%d", "%B %d %Y"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    raise SystemExit(f"Unrecognized date: {s!r}. Use the form September 29, 2026.")


def long_date(d):
    return f"{d.strftime('%B')} {d.day}, {d.year}"


def num_date(d):
    return d.strftime("%m/%d/%Y")


# ----------------------------------------------------------------------------- receipt
RECEIPT_LABELS = [("a_number", "A-Number:"), ("tracking_id", "Payment Tracking ID:"),
                  ("processed_on", "Payment Processed On:"), ("payment_type", "Payment Type:"),
                  ("amount", "Payment Amount:"), ("filing_type", "Filing Type:")]


def read_receipt(path):
    with pdfplumber.open(path) as pdf:
        pg = pdf.pages[0]
        words = pg.extract_words()
        text = "\n".join((p.extract_text() or "") for p in pdf.pages)
        pages = len(pdf.pages)
        size = [round(float(pg.width)), round(float(pg.height))]
    out = {}
    for key, label in RECEIPT_LABELS:
        toks = label.split()
        for i in range(len(words) - len(toks) + 1):
            if [w["text"] for w in words[i:i + len(toks)]] == toks:
                top, x1 = words[i]["top"], words[i + len(toks) - 1]["x1"]
                hi = 16 if key == "filing_type" else 7
                vals = [w for w in words if w["x0"] > x1 + 0.5 and top - 7 <= w["top"] <= top + hi]
                vals.sort(key=lambda w: (round(w["top"] / 4), w["x0"]))
                out[key] = " ".join(w["text"] for w in vals).strip()
                break
    flat = " ".join(text.split())

    def rx(p):
        m = re.search(p, flat)
        return m.group(1) if m else ""

    if not re.fullmatch(r"\d{3}-\d{3}-\d{3}", out.get("a_number", "")):
        out["a_number"] = rx(r"\b(\d{3}-\d{3}-\d{3})\b")
    if not re.search(r"\d{1,2}/\d{1,2}/\d{4}", out.get("processed_on", "")):
        out["processed_on"] = rx(r"(\d{1,2}/\d{1,2}/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*[AP]M(?:\s+[A-Z]{2,4})?)")
    if "$" not in out.get("amount", ""):
        out["amount"] = rx(r"(\$\s?[\d,]+\.\d{2})")
    if "I-589" not in out.get("filing_type", ""):
        out["filing_type"] = rx(r"((?:Court|BIA)\s*-\s*Form I-589.*?(?:\(AAF\)|Removal))")
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", out.get("processed_on", ""))
    out["pay_date"] = long_date(dt.date(int(m.group(3)), int(m.group(1)), int(m.group(2)))) if m else ""
    ft = out.get("filing_type", "")
    out["fee_kind"] = ("annual" if ("Annual Asylum Fee" in ft or "(AAF)" in ft)
                       else "initial" if "I-589" in ft else "unknown")
    out["a_number_fmt"] = ("A" + out["a_number"]) if out.get("a_number") else ""
    out["pages"], out["page_size"], out["source"] = pages, size, str(path)
    missing = [k for k, _ in RECEIPT_LABELS if not out.get(k)]
    if missing:
        out["warning"] = "Could not read: " + ", ".join(missing) + ". Read the receipt and fill these in by hand."
    return out


def pdf_pages(path):
    with pdfplumber.open(path) as pdf:
        return [(float(p.width), float(p.height)) for p in pdf.pages]


# ----------------------------------------------------------------------------- docx helpers
def _rfonts(rpr, font):
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rpr.insert(0, rf)
    for a in list(rf.attrib):
        if a.endswith("Theme") or a.endswith("theme"):
            del rf.attrib[a]
    for a in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rf.set(qn(a), font)


def add_run(p, text, style="", size=12, font=FONT):
    r = p.add_run(text)
    r.font.name = font
    r.font.size = Pt(size)
    _rfonts(r._element.get_or_add_rPr(), font)
    if "b" in style:
        r.bold = True
    if "i" in style:
        r.italic = True
    if "u" in style:
        r.underline = True
    if "c" in style:
        r.font.all_caps = True
    return r


ALIGN = {"c": WD_ALIGN_PARAGRAPH.CENTER, "r": WD_ALIGN_PARAGRAPH.RIGHT,
         "j": WD_ALIGN_PARAGRAPH.JUSTIFY, "l": WD_ALIGN_PARAGRAPH.LEFT}
TABK = {"l": WD_TAB_ALIGNMENT.LEFT, "r": WD_TAB_ALIGNMENT.RIGHT, "c": WD_TAB_ALIGNMENT.CENTER}


def para(box, parts=(), align=None, before=0, after=0, line=1.0, exact=None, left=0, right=0,
         first=0, tabs=(), pbb=False, size=12, keep=False):
    p = box.add_paragraph()
    f = p.paragraph_format
    f.space_before, f.space_after = Pt(before), Pt(after)
    if exact:
        f.line_spacing = Pt(exact)
        f.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    else:
        f.line_spacing = line
    if left:
        f.left_indent = Twips(left)
    if right:
        f.right_indent = Twips(right)
    if first:
        f.first_line_indent = Twips(first)
    if align:
        p.alignment = ALIGN[align]
    for kind, pos in tabs:
        f.tab_stops.add_tab_stop(Twips(pos), TABK[kind])
    if pbb:
        f.page_break_before = True
    if keep:
        f.keep_with_next = True
    for part in parts:
        text, style = (part, "") if isinstance(part, str) else part
        add_run(p, text, style, size)
    return p


def blanks(box, n, exact=None):
    for _ in range(n):
        para(box, exact=exact)


def drop_first_paragraph(cell):
    ps = cell.paragraphs
    if len(ps) > 1 and not ps[0].text and not ps[0].runs:
        ps[0]._p.getparent().remove(ps[0]._p)


def _tcpr_insert(tcPr, el, after_tags):
    anchor = None
    for tag in after_tags:
        x = tcPr.find(qn(tag))
        if x is not None:
            anchor = x
    if anchor is not None:
        anchor.addnext(el)
    else:
        tcPr.insert(0, el)


def cell_borders(cell, top=False, bottom=False):
    tcPr = cell._tc.get_or_add_tcPr()
    b = OxmlElement("w:tcBorders")
    for edge, on in (("top", top), ("left", False), ("bottom", bottom), ("right", False)):
        el = OxmlElement(f"w:{edge}")
        if on:
            for k, v in (("val", "single"), ("sz", "4"), ("space", "0"), ("color", "000000")):
                el.set(qn(f"w:{k}"), v)
        else:
            el.set(qn("w:val"), "nil")
        b.append(el)
    _tcpr_insert(tcPr, b, ("w:tcW", "w:gridSpan", "w:hMerge", "w:vMerge"))


def cell_shade(cell, fill="D9D9D9"):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    _tcpr_insert(tcPr, shd, ("w:tcW", "w:gridSpan", "w:hMerge", "w:vMerge", "w:tcBorders"))


def table(doc, widths, rows=1):
    t = doc.add_table(rows=rows, cols=len(widths))
    t.autofit = False
    for i, w in enumerate(widths):
        t.columns[i].width = Twips(w)
        for r in t.rows:
            r.cells[i].width = Twips(w)
    return t


def page_setup(sec):
    sec.page_width, sec.page_height = Twips(12240), Twips(15840)
    sec.top_margin = sec.bottom_margin = sec.left_margin = sec.right_margin = Twips(1440)
    sec.header_distance, sec.footer_distance = Twips(720), Twips(540)


def set_pgnum_start(sec, start):
    sp = sec._sectPr
    for old in sp.findall(qn("w:pgNumType")):
        sp.remove(old)
    if start is None:
        return
    el = OxmlElement("w:pgNumType")
    el.set(qn("w:start"), str(start))
    el.set(qn("w:fmt"), "decimal")
    for tag in ("w:cols", "w:formProt", "w:vAlign", "w:noEndnote", "w:titlePg", "w:textDirection",
                "w:bidi", "w:rtlGutter", "w:docGrid", "w:printerSettings", "w:sectPrChange"):
        s = sp.find(qn(tag))
        if s is not None:
            s.addprevious(el)
            return
    sp.append(el)


def new_section(doc, first=False):
    sec = doc.sections[0] if first else doc.add_section(WD_SECTION.NEW_PAGE)
    page_setup(sec)
    set_pgnum_start(sec, None)
    return sec


def footer_blank(sec):
    sec.footer.is_linked_to_previous = False
    p = sec.footer.paragraphs[0]
    for r in list(p.runs):
        r._r.getparent().remove(r._r)


def footer_page_number(sec, start):
    sec.footer.is_linked_to_previous = False
    p = sec.footer.paragraphs[0]
    for r in list(p.runs):
        r._r.getparent().remove(r._r)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    def frun():
        r = p.add_run()
        r.font.size = Pt(8)
        _rfonts(r._element.get_or_add_rPr(), "Arial")
        return r

    r = frun()
    fc = OxmlElement("w:fldChar"); fc.set(qn("w:fldCharType"), "begin"); r._r.append(fc)
    r = frun()
    it = OxmlElement("w:instrText"); it.set(qn("xml:space"), "preserve"); it.text = " PAGE "; r._r.append(it)
    r = frun()
    fc = OxmlElement("w:fldChar"); fc.set(qn("w:fldCharType"), "separate"); r._r.append(fc)
    r = frun()
    r.text = str(start)
    r = frun()
    fc = OxmlElement("w:fldChar"); fc.set(qn("w:fldCharType"), "end"); r._r.append(fc)
    set_pgnum_start(sec, start)


def anchor_picture(run, path, w_emu, h_emu, x_emu, y_emu, rel_h="page", rel_v="page", behind=True):
    run.add_picture(str(path), width=Emu(int(w_emu)), height=Emu(int(h_emu)))
    drawing = run._r.findall(qn("w:drawing"))[-1]
    inline = drawing.find(qn("wp:inline"))
    anchor = OxmlElement("wp:anchor")
    for k, v in (("distT", "0"), ("distB", "0"), ("distL", "0"), ("distR", "0"), ("simplePos", "0"),
                 ("relativeHeight", "251658240" if behind else "251660288"), ("behindDoc", "1" if behind else "0"),
                 ("locked", "0"), ("layoutInCell", "1"), ("allowOverlap", "1")):
        anchor.set(k, v)
    sp = OxmlElement("wp:simplePos"); sp.set("x", "0"); sp.set("y", "0"); anchor.append(sp)
    for tag, rel, off in (("wp:positionH", rel_h, x_emu), ("wp:positionV", rel_v, y_emu)):
        pos = OxmlElement(tag); pos.set("relativeFrom", rel)
        po = OxmlElement("wp:posOffset"); po.text = str(int(off)); pos.append(po)
        anchor.append(pos)
    anchor.append(copy.deepcopy(inline.find(qn("wp:extent"))))
    ee = inline.find(qn("wp:effectExtent"))
    if ee is None:
        ee = OxmlElement("wp:effectExtent")
        for a in ("l", "t", "r", "b"):
            ee.set(a, "0")
    anchor.append(copy.deepcopy(ee))
    anchor.append(OxmlElement("wp:wrapNone"))
    for tag in ("wp:docPr", "wp:cNvGraphicFramePr", "a:graphic"):
        el = inline.find(qn(tag))
        if el is not None:
            anchor.append(copy.deepcopy(el))
    drawing.remove(inline)
    drawing.append(anchor)


def init_document():
    doc = Document()
    styles = doc.styles.element
    rpr_default = styles.find(qn("w:docDefaults")).find(qn("w:rPrDefault")).find(qn("w:rPr"))
    _rfonts(rpr_default, FONT)
    ppr_default = styles.find(qn("w:docDefaults")).find(qn("w:pPrDefault")).find(qn("w:pPr"))
    sp = ppr_default.find(qn("w:spacing"))
    if sp is not None:
        sp.set(qn("w:after"), "0"); sp.set(qn("w:line"), "240"); sp.set(qn("w:lineRule"), "auto")
    normal = doc.styles["Normal"]
    normal.font.name = FONT
    normal.font.size = Pt(12)
    _rfonts(normal.element.get_or_add_rPr(), FONT)
    pf = normal.paragraph_format
    pf.space_before, pf.space_after, pf.line_spacing = Pt(0), Pt(0), 1.0
    zoom = doc.settings.element.find(qn("w:zoom"))
    if zoom is not None and zoom.get(qn("w:percent")) is None:
        zoom.set(qn("w:percent"), "100")
    doc.core_properties.author = FIRM["firm_pc"]
    return doc


# ----------------------------------------------------------------------------- shared blocks
def counsel_block(doc, cfg):
    flag = "DETAINED" if cfg.get("detained") else "NON-DETAINED"
    para(doc, [FIRM["attorney"], "\t" + flag], exact=13.2, left=40, tabs=[("l", 7200)])
    para(doc, [(FIRM["firm_pc"], "b")], exact=13.2, left=40)
    for line in (FIRM["street"], FIRM["city_long"], FIRM["phone"], FIRM["fax"], FIRM["email"]):
        para(doc, [line], exact=13.2, left=40)


def court_heading(doc, cfg, pbb=False):
    if cfg["forum"] == "BIA":
        lines = ["UNITED STATES DEPARTMENT OF JUSTICE", "EXECUTIVE OFFICE FOR IMMIGRATION REVIEW",
                 "BOARD OF IMMIGRATION APPEALS", "FALLS CHURCH, VIRGINIA"]
    else:
        lines = ["UNITED STATES DEPARTMENT OF JUSTICE", "EXECUTIVE OFFICE FOR IMMIGRATION REVIEW",
                 "IMMIGRATION COURT", cfg.get("court_city", "HOUSTON, TEXAS").upper()]
    for i, line in enumerate(lines):
        para(doc, [(line, "b")], align="c", exact=13.2, pbb=(pbb and i == 0))


def caption(doc, cfg):
    ic = cfg["forum"] == "IC"
    widths = [5040, 270, 4111] if ic else [5040, 276, 4044]
    t = table(doc, widths)
    left, mid, right = t.rows[0].cells
    cell_borders(left, top=True, bottom=True)
    cell_borders(mid, bottom=not ic)
    cell_borders(right)
    name, anum = cfg["name_caption"], cfg["a_number"]
    proc = cfg.get("proceedings") or "In Removal Proceedings"
    if ic:
        lrows = [None, None, ("In the Matter of:", "", 480, None), None, (name, "b", 0, None), None,
                 ("Respondent", "", 600, None), None, None]
        rrows = [None] * 4 + [(f"File No.: {anum}", "b", 0, "c"), None, (proc, "", 0, "c"),
                              None, None]
    else:
        lrows = [None, None, ("In the Matter of:", "", 480, None), None, (name, "b", 0, None), None, None,
                 ("Respondent", "", 540, None), None]
        rrows = [None] * 4 + [(f"File No.: {anum}", "b", 792, None), None, None,
                              (proc, "", 792, None), None]
    for cell, rows in ((left, lrows), (right, rrows)):
        for r in rows:
            if r:
                para(cell, [(r[0], r[1])], left=r[2], align=r[3])
            else:
                para(cell)
        drop_first_paragraph(cell)
    for _ in range(9):
        para(mid, [(SECT, "b")], align="r" if ic else None)
    drop_first_paragraph(mid)
    return t


def signature_line(doc, cfg, line_text, left=0, bold=False, tail=None, tabs=()):
    parts = [(line_text, "b" if bold else "")]
    if tail:
        parts.append(tail)
    p = para(doc, parts, left=left, tabs=tabs)
    sig = cfg.get("signature_png")
    if cfg.get("signature", "image") == "image" and sig and Path(sig).exists():
        with Image.open(sig) as im:
            w_px, h_px = im.size
        w = 1.5 * 72 * EMU_PT
        h = w * h_px / w_px
        anchor_picture(p.add_run(), sig, w, h, left * 635, -(h - 13 * EMU_PT), "column", "paragraph", behind=False)
    elif cfg.get("signature") == "conformed":
        p.runs[0].text = "/s/ Nisreen S. Mousa"
        p.runs[0].underline = True
    return p


# ----------------------------------------------------------------------------- IC format
def ic_cover(doc, cfg):
    fee = FEES[cfg["fee_kind"]]
    counsel_block(doc, cfg)
    blanks(doc, 3, exact=13.2)
    court_heading(doc, cfg)
    blanks(doc, 3, exact=13.2)
    caption(doc, cfg)
    judge = cfg.get("judge") or BLANK
    hearing = cfg.get("next_hearing") or BLANK
    para(doc, [(f"Immigration Judge: {judge}", "b"), (f"\tNext Hearing: {hearing}", "b")],
         before=82, tabs=[("r", 9360)])
    para(doc, [(f"RESPONDENT'S PROOF OF {fee['up']} PAYMENT", "bu")], align="c", before=108, size=14)


def ic_index_rows(cfg, nums):
    fee = FEES[cfg["fee_kind"]]
    rows = [("EXH.", "NAMES", "PAGE", "head"), ("", "", "", "blank"),
            ("A", f"{fee['up']} PAYMENT", "", "ex"), ("", "", "", "blank"),
            ("I.", f"Respondent's Payment Receipt, Tracking ID {cfg['tracking_id']}",
             nums["A_label"], "sub"), ("", "", "", "blank")]
    if nums.get("B"):
        od = parse_date(cfg["order"]["date"])
        rows += [("B", f"ORDER OF THE IMMIGRATION JUDGE DATED {num_date(od)}", "", "ex"), ("", "", "", "blank"),
                 ("I.", f"Order of the Immigration Judge dated {long_date(od)}", nums["B_label"], "sub"),
                 ("", "", "", "blank")]
    rows += [("", "CERTIFICATE OF SERVICE", "", "ex"), ("", "", "", "blank"),
             ("", "Certificate of Service", nums["cos_label"], "sub")]
    return rows


def ic_body(doc, cfg, nums):
    fee = FEES[cfg["fee_kind"]]
    court_heading(doc, cfg)
    blanks(doc, 3, exact=13.2)
    caption(doc, cfg)
    para(doc, [(f"RESPONDENT'S PROOF OF {fee['up']} PAYMENT", "bu")], align="c", before=14)
    order = cfg.get("order")
    if order and order.get("date"):
        middle = (f", by and through undersigned counsel, and, in compliance with the Order of the Immigration Judge "
                  f"dated {long_date(parse_date(order['date']))}, files Proof of {fee['fee']} Payment")
    else:
        middle = f", by and through undersigned counsel, and files Proof of {fee['fee']} Payment"
    text = (middle + ' in accordance with Chapter 2 of the Executive Office for Immigration Review ("EOIR") '
            "Immigration Court Practice Manual. In support thereof, Respondent submits as follows:")
    text = cfg.get("ic_comes_now") or text
    para(doc, [(f"COMES NOW, {cfg['name_full']}", "b"), text], align="j", before=28, line=2.0, first=720)
    rows = ic_index_rows(cfg, nums)
    t = table(doc, [918, 7362, 1075], rows=len(rows))
    for (c1, c2, c3, kind), row in zip(rows, t.rows):
        for i, (cell, txt) in enumerate(zip(row.cells, (c1, c2, c3))):
            if kind in ("head", "ex"):
                cell_shade(cell)
            style, align = "b", "c"
            if kind == "sub" and i == 1:
                style, align = "i", "l"
            para(cell, [(txt, style)] if txt else [], align=align, after=10, line=1.15)
            drop_first_paragraph(cell)
    wherefore = cfg.get("ic_wherefore") or (" premises considered, the Respondent respectfully requests that these "
                                            "exhibits be entered into evidence.")
    para(doc, [("WHEREFORE,", "b"), wherefore], before=14, line=2.0, first=720)
    para(doc, [("Respectfully submitted,", "b")], before=24, left=5040, keep=True)
    blanks(doc, 3)
    signature_line(doc, cfg, "______________________", left=5040, bold=True)
    para(doc, [FIRM["attorney"]], left=5040)
    para(doc, [(FIRM["firm_plain"], "b")], left=5040)
    for line in (FIRM["street"], FIRM["city_short"], FIRM["phone"], FIRM["fax"], FIRM["email"]):
        para(doc, [line], left=5040)


def ic_cos(doc, cfg, nums):
    fee = FEES[cfg["fee_kind"]]
    flag = "DETAINED" if cfg.get("detained") else "NON-DETAINED"
    para(doc, [(cfg["name_caption"], "bc"), "\t" + flag], tabs=[("r", 9360)])
    para(doc, [cfg["a_number"]])
    para(doc, [("CERTIFICATE OF SERVICE", "bu")], align="c", before=36, after=8, line=1.08)
    exhibits = "Exhibits A and B" if nums.get("B") else "Exhibit A"
    sd = long_date(parse_date(cfg["sign_date"]))
    para(doc, ["\tOn ", (sd, "b"), ", ", (FIRM["signer"], "b"),
               f" served a copy of this PROOF OF {fee['up']} PAYMENT, with {exhibits}, on the following:"],
         before=24, after=8, line=1.08, tabs=[("l", 720)])
    if cfg.get("filing", "ECAS").upper() == "ECAS":
        para(doc, [("By the ", "i"), ("EOIR Courts and Appeals System (ECAS)", "bi")], align="c", before=16, after=8,
             line=1.08)
    else:
        para(doc, [("By first-class U.S. mail, postage prepaid", "i")], align="c", before=16, after=8, line=1.08)
    dhs = cfg.get("dhs_lines") or DHS_IC
    for i, line in enumerate(dhs):
        para(doc, [(line, "b" if i == 0 else "")], align="c", before=16 if i == 0 else 0, line=1.08,
             after=8 if i == len(dhs) - 1 else 0)
    if cfg.get("filing", "ECAS").upper() == "ECAS":
        para(doc, [ECAS_SENTENCE], before=8, after=8, line=1.08)
    blanks(doc, 3)
    signature_line(doc, cfg, "___________________________", bold=True, tail=(f"\t{sd}", "b"), tabs=[("l", 5040)])
    para(doc, [("Signature", "b"), ("\tDate", "b")], tabs=[("l", 5040)])


# ----------------------------------------------------------------------------- BIA format
def bia_paragraphs(cfg, nums):
    paras, intro, wherefore = bia_default_text(cfg, nums)
    return (cfg.get("bia_paragraphs") or paras, cfg.get("bia_intro") or intro, cfg.get("bia_wherefore") or wherefore)


def bia_default_text(cfg, nums):
    fee = FEES[cfg["fee_kind"]]["fee"]
    pay = long_date(parse_date(cfg["pay_date"]))
    amount = cfg["amount"]
    order = cfg.get("order") or {}
    name = cfg["name_full"]
    filing = cfg.get("filing", "paper").upper()
    method = ("This matter proceeds on an electronic record of proceedings. Accordingly, this submission is filed "
              "through the EOIR Courts and Appeals System (ECAS) and served on the Department of Homeland Security "
              "electronically through ECAS.") if filing == "ECAS" else (
              "This matter proceeds on a paper record of proceedings. Accordingly, this submission is filed in paper "
              "and served on the Department of Homeland Security by mail.")
    paid = (f"On {pay}, Respondent paid the {fee} of {amount} through the EOIR Payment Portal. "
            f"The Payment Tracking ID is {cfg['tracking_id']}.")
    if order.get("date"):
        od = long_date(parse_date(order["date"]))
        dl = long_date(parse_date(order["deadline"])) if order.get("deadline") else None
        intro = (f"Respondent, {name} ({cfg['a_number']}), by and through undersigned counsel, respectfully submits "
                 f"proof of payment of the {fee} in compliance with the Board's order dated {od}, and in support "
                 "states as follows:")
        p1 = (f"On {od}, the Board issued an order directing Respondent to pay the {fee} for the pending Form I-589 "
              "and to file a copy of the payment receipt, together with a copy of the order, with the Board"
              + (f" on or before {dl}." if dl else "."))
        p3 = "A copy of the payment receipt is attached as Exhibit A."
        if nums.get("B"):
            p3 += f" A copy of the Board's order dated {od} is attached as Exhibit B."
        paras = [p1, paid, p3]
        if dl:
            sd, dd = parse_date(cfg["sign_date"]), parse_date(order["deadline"])
            if sd < dd:
                paras.append(f"This submission is timely, as it precedes the {dl} deadline set by the Board.")
            elif sd == dd and filing == "ECAS":
                paras.append(f"This submission is timely, as it is filed on the {dl} deadline set by the Board.")
        paras.append(method)
        wherefore = (f", Respondent respectfully requests that the Board accept the attached proof of payment as timely "
                     f"compliance with its order dated {od}, and recognize the {fee} as satisfied for the current period.")
    else:
        intro = (f"Respondent, {name} ({cfg['a_number']}), by and through undersigned counsel, respectfully submits "
                 f"proof of payment of the {fee} for the pending Form I-589, and in support states as follows:")
        paras = []
        if cfg["fee_kind"] == "annual":
            paras.append("Respondent's Form I-589, Application for Asylum and for Withholding of Removal, remains "
                         "pending and has been pending for more than one year. The Annual Asylum Fee for the current "
                         "period therefore became due on the anniversary of its filing.")
        paras += [paid, "A copy of the payment receipt is attached as Exhibit A."]
        if cfg["fee_kind"] == "annual" and cfg.get("within_30_days"):
            paras.append("This payment is timely, as it was made within 30 days of the anniversary due date.")
        paras.append(method)
        wherefore = (f", Respondent respectfully requests that the Board accept the attached proof of payment and "
                     f"recognize the {fee} as timely paid and satisfied for the current period.")
    return paras, intro, wherefore


def bia_title(cfg):
    return "RESPONDENT'S SUBMISSION OF PROOF OF PAYMENT OF THE " + FEES[cfg["fee_kind"]]["up"]


def bia_signature_block(doc, cfg, date_line=True):
    sd = long_date(parse_date(cfg["sign_date"]))
    if date_line:
        para(doc, [f"Date: {sd}"], line=1.08, after=48)
    signature_line(doc, cfg, "_______________________________")
    para(doc, [(FIRM["attorney"], "b")], line=1.08)
    for line in (FIRM["bar"], FIRM["firm_pc_dots"], "Counsel for Respondent"):
        para(doc, [line], line=1.08)
    para(doc, [f"Dated: {sd}"], before=6, line=1.08)


def bia_cover(doc, cfg):
    counsel_block(doc, cfg)
    blanks(doc, 3, exact=13.2)
    court_heading(doc, cfg)
    blanks(doc, 3, exact=13.2)
    caption(doc, cfg)
    para(doc, [(bia_title(cfg), "bu")], align="c", before=168, line=1.08)


def bia_body(doc, cfg, nums):
    counsel_block(doc, cfg)
    blanks(doc, 3, exact=13.2)
    court_heading(doc, cfg)
    blanks(doc, 3, exact=13.2)
    caption(doc, cfg)
    para(doc, [(bia_title(cfg), "bu")], align="c", before=46, after=13, line=1.08)
    paras, intro, wherefore = bia_paragraphs(cfg, nums)
    para(doc, [intro], line=1.08, after=10)
    for n, text in enumerate(paras, 1):
        para(doc, [f"{n}.\t{text}"], line=1.08, after=7, tabs=[("l", 720)])
    para(doc, [("WHEREFORE", "b"), wherefore or ""], before=4, line=1.08, after=15)
    para(doc, ["Respectfully submitted,"], line=1.08, after=44)
    bia_signature_block(doc, cfg)
    # index page
    court_heading(doc, cfg, pbb=True)
    blanks(doc, 3, exact=13.2)
    caption(doc, cfg)
    para(doc, [("INDEX", "bu")], align="c", before=46, after=20)
    fee = FEES[cfg["fee_kind"]]["fee"]
    rows = [("Exhibit", "Title", "Page", True), ("A", f"Proof of {fee} Payment", nums["A_label"], False)]
    if nums.get("B"):
        od = long_date(parse_date(cfg["order"]["date"]))
        rows.append(("B", f"Order of the Board dated {od}", nums["B_label"], False))
    t = table(doc, [1440, 6600, 1320], rows=len(rows))
    for (a, b, c, hdr), row in zip(rows, t.rows):
        for cell, txt in zip(row.cells, (a, b, c)):
            para(cell, [(txt, "b" if hdr else "")], align="c", after=20 if hdr else 14)
            drop_first_paragraph(cell)


def bia_cos(doc, cfg, nums):
    para(doc, [("CERTIFICATE OF SERVICE", "bu")], align="c", line=1.08, after=26)
    sd = long_date(parse_date(cfg["sign_date"]))
    exhibits = "Exhibits A and B" if nums.get("B") else "Exhibit A"
    how = ("was electronically filed through the EOIR Courts and Appeals System (ECAS) and served through ECAS upon "
           "the following:") if cfg.get("filing", "paper").upper() == "ECAS" else (
           "was served by first-class U.S. mail, postage prepaid, upon the following:")
    title = "Respondent's Submission of Proof of Payment of the " + FEES[cfg["fee_kind"]]["fee"]
    para(doc, [f"I hereby certify that on {sd}, a true and correct copy of the foregoing {title}, with {exhibits}, {how}"],
         line=1.08, after=10)
    dhs = cfg.get("dhs_lines") or DHS_BIA
    for i, line in enumerate(dhs):
        para(doc, [(line, "b" if i == 0 else "")], align="c", line=1.08, after=15 if i == len(dhs) - 1 else 0)
    if cfg.get("filing", "paper").upper() == "ECAS":
        para(doc, [ECAS_SENTENCE], line=1.08, after=15)
    para(doc, [], line=1.08, after=36)
    bia_signature_block(doc, cfg, date_line=False)


# ----------------------------------------------------------------------------- exhibits
def render_exhibit(pdf, work, tag):
    out = Path(work) / f"ex_{tag}"
    subprocess.run(["pdftoppm", "-r", "200", "-png", str(pdf), str(out)], check=True)
    pngs = sorted(Path(work).glob(f"ex_{tag}-*.png"), key=lambda p: int(p.stem.rsplit("-", 1)[1]))
    import numpy as np
    result, crowded = [], []
    for k, png in enumerate(pngs):
        arr = np.array(Image.open(png).convert("RGBA"))
        white = (arr[:, :, 0] > 242) & (arr[:, :, 1] > 242) & (arr[:, :, 2] > 242)
        arr[white, 3] = 0
        # the page number spot (bottom center): note any ink there, then clear it so the footer shows in Word
        h, w = arr.shape[:2]
        sx, sy = w / 8.5, h / 11.0
        y0, y1 = int(h - 0.62 * sy), int(h - 0.3 * sy)
        x0, x1 = int(w / 2 - 0.3 * sx), int(w / 2 + 0.3 * sx)
        spot = arr[y0:y1, x0:x1]
        if int(((spot[:, :, :3].min(axis=2) < 200) & (spot[:, :, 3] > 0)).sum()) > 25:
            crowded.append(k + 1)
        arr[y0:y1, x0:x1, 3] = 0
        dst = png.with_name(png.stem + "_t.png")
        Image.fromarray(arr).save(dst)
        result.append(dst)
    return result, crowded


def exhibit_pages(doc, pngs, sizes):
    for i, (png, (pw, ph)) in enumerate(zip(pngs, sizes)):
        p = para(doc, pbb=(i > 0))
        scale = min(612 / pw, 792 / ph)
        w, h = pw * scale, ph * scale
        anchor_picture(p.add_run(), png, w * EMU_PT, h * EMU_PT, (612 - w) / 2 * EMU_PT, (792 - h) / 2 * EMU_PT)


def tab_page(doc, letter):
    para(doc, exact=131)
    para(doc, [letter], align="c", size=300)


# ----------------------------------------------------------------------------- numbering
def label(forum, s, e):
    if forum == "BIA":
        return f"{s:02d}-{e:02d}"
    return f"{s}" if s == e else f"{s}-{e}"


def compute_numbers(cfg, exhibits, body_pages):
    forum = cfg["forum"]
    n = 1 if forum == "IC" else body_pages + 1
    nums = {"body_start": None if forum == "IC" else 1}
    for ex in exhibits:
        s, e = n, n + len(ex["sizes"]) - 1
        nums[ex["letter"]] = (s, e)
        nums[ex["letter"] + "_label"] = label(forum, s, e)
        n = e + 1
    nums["cos"] = n
    nums["cos_label"] = label(forum, n, n)
    return nums


def build_docx(cfg, exhibits, nums, path):
    doc = init_document()
    sec = new_section(doc, first=True)
    footer_blank(sec)
    (ic_cover if cfg["forum"] == "IC" else bia_cover)(doc, cfg)
    sec = new_section(doc)
    if cfg["forum"] == "IC":
        footer_blank(sec)
        ic_body(doc, cfg, nums)
    else:
        footer_page_number(sec, 1)
        bia_body(doc, cfg, nums)
    for ex in exhibits:
        sec = new_section(doc)
        footer_blank(sec)
        tab_page(doc, ex["letter"])
        sec = new_section(doc)
        footer_page_number(sec, nums[ex["letter"]][0])
        exhibit_pages(doc, ex["pngs"], ex["sizes"])
    sec = new_section(doc)
    footer_page_number(sec, nums["cos"])
    (ic_cos if cfg["forum"] == "IC" else bia_cos)(doc, cfg, nums)
    doc.core_properties.title = f"Proof of Payment {cfg['name_caption']} {cfg['a_number']}"
    doc.save(path)


# ----------------------------------------------------------------------------- pdf
def to_pdf(docx_path, outdir):
    pdf = Path(outdir) / (Path(docx_path).stem + ".pdf")
    if pdf.exists():
        pdf.unlink()
    profile = tempfile.mkdtemp(prefix="lo_profile_")
    env = dict(os.environ, SAL_USE_VCLPLUGIN="svp")
    cmd = ["soffice", f"-env:UserInstallation=file://{profile}", "--headless", "--convert-to", "pdf",
           "--outdir", str(outdir), str(docx_path)]
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=300)
    if not pdf.exists():
        helpers = glob.glob("/sessions/*/mnt/.claude/skills/docx/scripts/office/soffice.py")
        if helpers:
            sys.path.insert(0, str(Path(helpers[0]).parent.parent))
            from office.soffice import run_soffice
            r = run_soffice(["--headless", "--convert-to", "pdf", "--outdir", str(outdir), str(docx_path)],
                            capture_output=True, text=True, timeout=300)
    if not pdf.exists():
        raise SystemExit("LibreOffice could not convert the Word file: " + (r.stderr or "")[-600:])
    return pdf


def page_texts(pdf):
    out = []
    with pdfplumber.open(pdf) as doc:
        for pg in doc.pages:
            small = [c for c in pg.chars if c["size"] < 9 and c["top"] > float(pg.height) - 60]
            num = "".join(c["text"] for c in sorted(small, key=lambda c: c["x0"])).strip()
            pos = (small[0]["x0"], small[0]["matrix"][5]) if small else None
            out.append({"text": (pg.extract_text() or "").strip(), "num": num, "pos": pos})
    return out


def layout(texts, exhibits):
    idx = {}
    for i, t in enumerate(texts):
        for ex in exhibits:
            if t["text"] == ex["letter"] and ex["letter"] not in idx:
                idx[ex["letter"]] = i
    if len(idx) != len(exhibits):
        raise SystemExit("Could not find the exhibit tab pages in the rendered PDF.")
    return idx


def stamp_pdf(path, text, pos):
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    font = "Helvetica"
    for ttf in glob.glob("/usr/share/fonts/truetype/liberation*/LiberationSans-Regular.ttf"):
        pdfmetrics.registerFont(TTFont("LiberationSans", ttf))
        font = "LiberationSans"
        break
    c = canvas.Canvas(str(path), pagesize=(612, 792))
    c.setFont(font, 8)
    if pos:
        c.drawString(pos[0], pos[1], text)
    else:
        c.drawCentredString(306, 28.7, text)
    c.showPage()
    c.save()


def assemble(lo_pdf, texts, exhibits, where, out_pdf, work):
    spec = []
    cur = 1
    for ex in exhibits:
        first = where[ex["letter"]] + 2  # 1-based page number of the first exhibit page
        if first > cur:
            spec.append((str(lo_pdf), f"{cur}-{first - 1}"))
        for k, (pw, ph) in enumerate(ex["sizes"]):
            lo_index = first - 1 + k
            if abs(pw - 612) < 2 and abs(ph - 792) < 2:
                single = Path(work) / f"x_{ex['letter']}_{k}.pdf"
                stamped = Path(work) / f"x_{ex['letter']}_{k}_n.pdf"
                stamp = Path(work) / f"s_{ex['letter']}_{k}.pdf"
                subprocess.run(["qpdf", "--empty", "--pages", str(ex["pdf"]), str(k + 1), "--", str(single)], check=True)
                stamp_pdf(stamp, texts[lo_index]["num"], texts[lo_index]["pos"])
                subprocess.run(["qpdf", str(single), "--overlay", str(stamp), "--", str(stamped)], check=True)
                spec.append((str(stamped), "1"))
            else:
                spec.append((str(lo_pdf), str(lo_index + 1)))
        cur = first + len(ex["sizes"])
    if cur <= len(texts):
        spec.append((str(lo_pdf), f"{cur}-{len(texts)}"))
    args = ["qpdf", str(lo_pdf), "--pages"]
    for f, rng in spec:
        args += [f, rng]
    args += ["--", str(out_pdf)]
    subprocess.run(args, check=True)


# ----------------------------------------------------------------------------- build
def normalize(cfg):
    cfg = dict(cfg)
    cfg["forum"] = cfg.get("forum", "IC").upper()
    if cfg["forum"] not in ("IC", "BIA"):
        raise SystemExit('forum must be "IC" or "BIA"')
    for k in ("name_caption", "name_full", "a_number", "receipt_pdf", "tracking_id", "pay_date", "amount",
              "sign_date", "out_dir", "file_stem"):
        if not cfg.get(k):
            raise SystemExit(f"config is missing {k}")
    if cfg.get("fee_kind") not in FEES:
        raise SystemExit('fee_kind must be "annual" or "initial"')
    a = cfg["a_number"].replace(" ", "")
    if not a.upper().startswith("A"):
        a = "A" + a
    cfg["a_number"] = "A" + a[1:].lstrip("#-")
    cfg.setdefault("filing", "ECAS")
    cfg["sign_date"] = long_date(parse_date(cfg["sign_date"]))
    cfg["pay_date"] = long_date(parse_date(cfg["pay_date"]))
    return cfg


def scan_special(texts, skip):
    bad = set()
    for i, t in enumerate(texts):
        if i in skip:
            continue
        for ch in t["text"]:
            if ord(ch) > 126 and ch != SECT:
                bad.add(repr(ch))
    return sorted(bad)


def build(cfg_path):
    cfg = normalize(json.loads(Path(cfg_path).read_text(encoding="utf-8")))
    work = Path(tempfile.mkdtemp(prefix="feepkt_"))
    exhibits = [{"letter": "A", "pdf": cfg["receipt_pdf"]}]
    order = cfg.get("order") or {}
    if order.get("pdf"):
        exhibits.append({"letter": "B", "pdf": order["pdf"]})
    for ex in exhibits:
        ex["sizes"] = pdf_pages(ex["pdf"])
        ex["pngs"], ex["crowded"] = render_exhibit(ex["pdf"], work, ex["letter"])
    stem = cfg["file_stem"]
    docx_path = work / f"{stem}.docx"
    body_guess = 3
    for attempt in range(3):
        nums = compute_numbers(cfg, exhibits, body_guess)
        build_docx(cfg, exhibits, nums, docx_path)
        lo_pdf = to_pdf(docx_path, work)
        texts = page_texts(lo_pdf)
        where = layout(texts, exhibits)
        body_pages = where["A"] - 1
        if cfg["forum"] == "IC" or body_pages == body_guess:
            break
        body_guess = body_pages
    out_dir = Path(cfg["out_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    final_pdf = out_dir / f"{stem}.pdf"
    assemble(lo_pdf, texts, exhibits, where, final_pdf, work)
    shutil.copy(docx_path, out_dir / f"{stem}.docx")
    # report
    final = page_texts(final_pdf)
    expected = []
    for i in range(len(final)):
        expected.append(None)
    if cfg["forum"] == "BIA":
        for i in range(1, where["A"]):
            expected[i] = str(i)
    for ex in exhibits:
        s, _ = nums[ex["letter"]]
        for k in range(len(ex["sizes"])):
            expected[where[ex["letter"]] + 1 + k] = str(s + k)
    last_ex = exhibits[-1]
    cos_first = where[last_ex["letter"]] + 1 + len(last_ex["sizes"])
    for i in range(cos_first, len(final)):
        expected[i] = str(nums["cos"] + i - cos_first)
    pages = []
    mismatches = []
    for i, t in enumerate(final):
        kind = "cover" if i == 0 else "letter"
        for ex in exhibits:
            if i == where[ex["letter"]]:
                kind = f"tab {ex['letter']}"
            elif where[ex["letter"]] < i <= where[ex["letter"]] + len(ex["sizes"]):
                kind = f"exhibit {ex['letter']}"
        if i >= cos_first:
            kind = "certificate of service"
        pages.append({"page": i + 1, "part": kind, "number": t["num"] or None})
        if (t["num"] or None) != expected[i]:
            mismatches.append(f"page {i + 1}: printed {t['num'] or 'none'}, expected {expected[i] or 'none'}")
    exhibit_pages_idx = {where[ex["letter"]] + 1 + k for ex in exhibits for k in range(len(ex["sizes"]))}
    generated = " ".join(t["text"] for i, t in enumerate(final) if i not in exhibit_pages_idx)
    warnings = []
    if cfg["forum"] == "IC" and (not cfg.get("judge") or not cfg.get("next_hearing")):
        warnings.append("Judge or next hearing left as a blank line on the cover.")
    if cfg.get("signature", "image") == "image" and not (cfg.get("signature_png") and Path(cfg["signature_png"]).exists()):
        warnings.append("Signature image not found; signature lines are blank.")
    if order.get("date") and not order.get("pdf"):
        warnings.append("An order is cited but no order PDF was attached as Exhibit B.")
    paper = cfg.get("filing", "ECAS").upper() != "ECAS"
    bia = cfg["forum"] == "BIA"
    if order.get("deadline"):
        sd, dd = parse_date(cfg["sign_date"]), parse_date(order["deadline"])
        if parse_date(cfg["pay_date"]) > dd:
            warnings.append("The payment date is after the order deadline. Tell Andrew before this is filed.")
        if sd > dd:
            warnings.append("The signing date is after the order deadline" +
                            ("; the timeliness paragraph was left out." if bia else ". Tell Andrew before filing."))
        elif paper and sd == dd:
            warnings.append("Paper filing dated on the deadline: a mailed filing cannot arrive that day"
                            + (", so the timeliness paragraph was left out" if bia else "")
                            + ". Ask how it will be delivered.")
        elif paper and (dd - sd).days < 7:
            warnings.append(f"Paper filing {(dd - sd).days} days before the deadline: the court and the Board count a "
                            "filing when it is received, not when it is mailed. Confirm overnight delivery.")
    if paper and cfg.get("signature", "image") == "image":
        warnings.append("Paper filing with the signature image: the practice manuals expect an ink signature on paper, "
                        "so have Ms. Mousa sign the printed copy.")
    for ex in exhibits:
        for k in ex["crowded"]:
            warnings.append(f"Exhibit {ex['letter']} page {k} has marks where the page number is stamped; "
                            "look at the bottom of that page.")
    city = (cfg.get("court_city") or "HOUSTON, TEXAS").upper()
    if cfg["forum"] == "IC" and "HOUSTON" not in city and not cfg.get("dhs_lines"):
        warnings.append("The court is not Houston but the DHS service block is still OPLA Houston; set dhs_lines.")
    report = {
        "pdf": str(final_pdf), "docx": str(out_dir / f"{stem}.docx"), "pages": pages,
        "index": {k: v for k, v in nums.items() if k.endswith("_label")},
        "page_number_problems": mismatches,
        "a_number_mentions": generated.count(cfg["a_number"]),
        "tracking_id_in_letter": cfg["tracking_id"] in generated,
        "special_characters": scan_special(final, exhibit_pages_idx),
        "warnings": warnings,
    }
    print(json.dumps(report, indent=2))


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("read", "build"):
        raise SystemExit(__doc__)
    if sys.argv[1] == "read":
        print(json.dumps(read_receipt(sys.argv[2]), indent=2))
    else:
        build(sys.argv[2])


if __name__ == "__main__":
    main()
