---
name: "eoir-written-pleadings"
description: "Draft Respondent's Written Pleadings for the Houston Immigration Court in the house format of The Law Firm of Nisreen S. Mousa, PC, from the Notice to Appear (Form I-862) and the I-94 or other entry record. Produces the full packet as one .docx: cover, pleadings, index, certificate of service, pleading declaration, certificate of interpretation. Use whenever Andrew asks to draft, prepare or write pleadings, written pleadings, MCH or master calendar pleadings, or to plead to an NTA, or uploads an NTA and I-94 and asks for pleadings. Trigger even without the word pleadings."
---

# EOIR Written Pleadings (Houston Immigration Court)

Builds the firm's standard Written Pleadings packet, matching the approved Issawi exemplar
exactly: cover page with counsel block and caption, the ten numbered representations,
WHEREFORE clause and signature block, INDEX (Tabs A and B), Certificate of Service,
Respondent's Pleading Declaration, and Certificate of Interpretation.

The skill never invents a fact. Every date, name, A number, allegation and charge comes from
the NTA; every entry fact is checked against the I-94 or other entry record the attorney sends.
When the record is silent, ask; do not guess.

## Inputs

1. Notice to Appear (Form I-862). Required. Usually a scanned PDF. If text extraction returns
   nothing, render the pages to PNG and read them (or OCR with tesseract). Read every page,
   including the Certificate of Service page.
2. I-94 or other entry record (CBP I-94 printout, passport admission stamp, I-589 travel
   history, I-797). Optional. If the attorney says there is no I-94, proceed on the NTA alone
   and say so in the cover note.
3. Anything else in the file that speaks to identity, entry, language, or relief (I-589,
   referral notice, prior filings).

## Workflow

### Step 1. Read the NTA and pull every variable

From the NTA capture: respondent's full name exactly as printed; A number; address and
phone; which of the three boxes is checked (arriving alien, present without admission,
admitted but removable); each numbered factual allegation verbatim; each charge with the
exact INA section; hearing date, time and court address printed on page 1; date the NTA was
signed; the Certificate of Service date and method (in person, certified mail, regular mail);
the language DHS says the respondent understands; issuing office.

Check the EOIR Automated Case Information page (acis.eoir.justice.gov) or ask the attorney
for the date the NTA was filed with the Court, the assigned Immigration Judge, and the next
hearing. If the attorney says no hearing has issued, use "Not yet assigned" and "Not yet
scheduled". Never put the NTA's printed hearing date in the caption unless it is confirmed on
the docket.

### Step 2. Check the allegations against the I-94

For each factual allegation, compare it to the I-94 or entry record:

- Allegation of admission (date, port, class): match the I-94 admission date, class of
  admission, and port. A one day difference is common (time zones) and is still a match.
- Allegation of the authorized period ("not to exceed" date): match the I-94 admit until
  date. A D/S admission (F, J) is not a fixed date; flag if the NTA states a date.
- Overstay allegation: confirm the respondent was in fact still here after that date
  (later filings, addresses, employment, the asylum application).
- Nationality allegation: check against passport, I-589 Part A, or birth certificate. If a
  parent was born elsewhere, note possible second nationality for the attorney; it does not
  by itself make the allegation false.
- Name and A number: check every page of the NTA against each other and against the I-94.

Default posture, which the firm uses when the record matches or when there is no I-94 and
nothing in the file contradicts the NTA: admit all allegations and concede the charge.

Deviate only when the record actually contradicts an allegation (wrong date, wrong class,
wrong port, wrong nationality, wrong statute) or when the NTA is defective (no charge, wrong
box checked, charge does not follow from the allegations). In that case stop and ask the
attorney which allegations to deny and whether to contest the charge before drafting.

### Step 3. Confirm the pleading choices with the attorney (one question round)

Ask once, with the defaults pre selected, only for items the file does not answer:

- Admit or deny each allegation; concede or deny each charge (default from Step 2).
- Country of removal: decline to designate (default for any asylum, withholding or CAT
  respondent) or name a country.
- Relief boxes. The firm's standard set for a referred asylum case is Termination of
  Proceedings, Asylum, Withholding of Removal, Protection under the Convention Against
  Torture, Voluntary Departure, and Other. Adjustment of Status only when there is a
  qualifying relative or petition. Cancellation and Waiver only when told, with the INA
  section.
- Language for the interpreter (default: the language on the NTA or I-589; English means
  the second box is checked instead).
- Hours estimate (default 3).
- Signature date (default today, written out, e.g. September 10, 2026).

If the attorney has already answered these in the request, do not ask again.

### Step 4. Build the config and run the generator

Write a JSON config with these keys:

```json
{
  "name_caption": "SURNAME, Given Names",
  "name_full": "Given Names Surname",
  "a_number": "A123-456-789",
  "pronoun": "he",
  "judge": "Last, First  (or: Not yet assigned)",
  "next_hearing": "Month D, YYYY  (or: Not yet scheduled)",
  "nta_date": "Month D, YYYY",
  "service_method": "regular mail",
  "nta_served_date": "Month D, YYYY",
  "service_phrase": "served on Respondent by regular mail the same day",
  "nta_filed_date": "Month D, YYYY",
  "admit": [1, 2, 3, 4],
  "deny": [],
  "charges": [{"section": "237(a)(1)(B)", "concede": true}],
  "country_designated": null,
  "relief": {"termination": true, "asylum": true, "withholding": true, "cat": true,
             "adjustment": false, "cancellation": false, "waiver": false,
             "voluntary_departure": true, "other": true, "none": false},
  "cancellation_section": "240A(b)",
  "waiver_section": "212(h)",
  "hours": 3,
  "language": "Spanish",
  "sign_date": "Month D, YYYY"
}
```

Notes: `name_caption` is SURNAME in capitals followed by a comma and the given names in
title case, exactly as the firm captions. `service_phrase` overrides the default sentence in
paragraph 1; use "served on Respondent by regular mail the same day" when the NTA date and
service date are the same, otherwise omit it and the script writes "served on Respondent by
[method] on [date]". `pronoun` is "he" or "she" and drives the Other relief line and the
Certificate of Interpretation. Leave `country_designated` null to check "declines to
designate". The A number is written with hyphens (A216-842-561).

Save the generator below as `make_pleadings.py` (it needs python-docx: `pip install
python-docx --break-system-packages`), then run:

```
python3 make_pleadings.py config.json "Written Pleadings - Surname.docx"
```

File name convention: `Written Pleadings - [Surname or Surname Given].docx`.

### Step 5. Verify before delivering

Convert to PDF and look at every page. Confirm: seven pages; the caption appears on the
cover, the pleadings page and the index page; name and A number identical everywhere
(cover, both captions, COMES NOW, index caption, certificate of service header, pleading
declaration); the checked boxes match the attorney's choices; the allegations sentence and
the charge sentence read correctly; paragraph 1 dates match the NTA; the interpreter language
is right; nothing spills onto an eighth page.

### Step 6. Deliver with a short cover note

Present the .docx and give the attorney, in a few lines: the pleading posture used; anything
in the record that did not line up (name spellings, dates, addresses, second nationality,
NTA hearing date not on the docket); what still needs to be filled (service date, client and
interpreter signatures, EOIR-33 if the NTA address differs from the file); and the Tab A and
Tab B assembly reminder (NTA with certificate of service behind Tab A, signed declaration and
certificate of interpretation behind Tab B). Do not use em dashes or decorative special
characters in the note or the document beyond the section marks and check boxes the format
requires.

## House format rules (do not vary)

- Times New Roman 11 point throughout; body paragraphs justified at 1.5 line spacing.
- US Letter, 1 inch margins (top 0.94 inch).
- Cover page: counsel block top left (Nisreen S. Mousa, Esq.; firm name bold; 3730 Kirby
  Drive, Suite 1200; Houston, Texas 77098; Office: (713) 828-0365; Fax: (346) 553-8491;
  nmousalaw@yahoo.com), NON-DETAINED bold to the right, court heading, caption, the
  Immigration Judge and Next Hearing line, and the underlined bold title.
- Caption: three column borderless table; left cell "In the Matter of:", SURNAME, Given
  (bold), "Respondent", with a rule above and below; middle cell a column of seven section
  marks; right cell "File No.: A###-###-###" (bold) and "In Removal Proceedings".
- The ten numbered representations, in this order and wording: 1 service of the NTA with Tab
  A cite; 2 advisals a through e; 3 admits or denies allegations; 4 concedes or denies the
  charge; 5 country designation boxes; 6 relief boxes; 7 the fifteen day filing rule and
  8 C.F.R. 1003.31(c); 8 biometrics and 8 C.F.R. 1003.47(d) with Tab B cite; 9 hours; 10
  interpreter boxes.
- Filled box is the black square, empty box the white square.
- WHEREFORE paragraph, then date at left and the signature block (name, Texas Bar No.
  24007713, firm, address, office, fax) at right.
- INDEX page: court heading, caption, shaded header row TAB / DESCRIPTION / PAGES, rows for
  the pleadings, Tab A (NTA description with date, charge, service), Tab B (Pleading
  Declaration and Certificate of Interpretation), and Certificate of Service.
- Certificate of Service page: caption name and file number bold at top left, title, "On
  [DATE], Ms. Nisreen S. Mousa, served a copy of this Written Pleadings, to the following:",
  By eService, Office of the Principal Legal Advisor - Houston, 126 Northpoint Drive, Room
  2020, Houston, TX 77060, United States, then signature and date lines.
- Pleading Declaration (six paragraphs) and Certificate of Interpretation on the last page.
- The firm's fax on pleadings is (346) 553-8491. Do not substitute the other firm fax number.

## Generator script (save as make_pleadings.py)

```python
#!/usr/bin/env python3
"""
Build Respondent's Written Pleadings (Houston Immigration Court) in the house
format of The Law Firm of Nisreen S. Mousa, PC.

Usage:  python3 make_pleadings.py config.json "Written Pleadings - Client.docx"

Requires python-docx (pip install python-docx --break-system-packages).
"""
import json
import sys

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Twips

FONT = "Times New Roman"
BODY_PT = 11
FILLED = "■"   # black square
EMPTY = "□"    # white square
SECT = "§"     # section mark

FIRM = {
    "attorney": "Nisreen S. Mousa, Esq.",
    "bar": "Texas Bar No. 24007713",
    "firm": "The Law Firm of Nisreen S. Mousa, PC",
    "street": "3730 Kirby Drive, Suite 1200",
    "city": "Houston, Texas 77098",
    "city_short": "Houston, TX 77098",
    "phone": "Office: (713) 828-0365",
    "fax": "Fax: (346) 553-8491",
    "email": "nmousalaw@yahoo.com",
    "dhs": ["Office of the Principal Legal Advisor - Houston",
            "126 Northpoint Drive, Room 2020", "Houston, TX 77060", "United States"],
}

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


def counsel_block(doc):
    t = doc.add_table(rows=1, cols=2)
    no_table_borders(t)
    set_col_widths(t, [4200, 5160])
    left, right = t.rows[0].cells
    cell_par(left, FIRM["attorney"])
    para(left, FIRM["firm"], bold=True)
    for line in (FIRM["street"], FIRM["city"], FIRM["phone"], FIRM["fax"], FIRM["email"]):
        para(left, line)
    cell_par(right, "NON-DETAINED", bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)


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


def build(cfg, out_path):
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
    counsel_block(doc)
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
    cell_par(r, "_____________________________", before=12)
    for line in (FIRM["attorney"], FIRM["bar"], FIRM["firm"], FIRM["street"], FIRM["city_short"], FIRM["phone"], FIRM["fax"]):
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
    para(doc, "On [DATE], Ms. Nisreen S. Mousa, served a copy of this Written Pleadings, to the following:", after=24)
    para(doc, "By eService", align=WD_ALIGN_PARAGRAPH.CENTER, after=12)
    for line in FIRM["dhs"]:
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


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: make_pleadings.py config.json out.docx")
    with open(sys.argv[1], encoding="utf-8") as f:
        build(json.load(f), sys.argv[2])
```

