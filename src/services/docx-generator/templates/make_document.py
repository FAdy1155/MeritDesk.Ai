#!/usr/bin/env python3
"""
Generic, firm-neutral Word document builder for the skill runner's
generate_document tool (src/services/skill-runner/tools.ts).

Usage:
    python3 make_document.py spec.json out.docx
    python3 make_document.py --template > spec.json

The spec is JSON; its contract is documentSpecSchema in
src/services/skill-runner/document-spec.ts, which the runner validates
before calling this script. This script validates it again and refuses to
write anything on a bad spec, with a message naming the field.

Defaults are court-appropriate: US Letter, 1 inch margins, Times New Roman
12 pt, justified body paragraphs with a 0.5 inch first-line indent, centered
page numbers in the footer. Nothing here is specific to any firm: letterhead,
counsel blocks, captions and signature blocks all come from the spec.

Inline markup in any text field: **bold**, *italic*, __underline__ (the
marked text must not start or end with a space or the marker character, so
a signature line of underscores or "2 * 3" passes through untouched). A
newline inside a string is a line break within the paragraph.
"""

import json
import re
import sys

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

PAGE_WIDTH_IN = 8.5
PAGE_HEIGHT_IN = 11
MARGIN_IN = 1.0
TEXT_WIDTH_IN = PAGE_WIDTH_IN - 2 * MARGIN_IN

DEFAULT_FONT = "Times New Roman"
DEFAULT_FONT_SIZE = 12
DEFAULT_LINE_SPACING = 1.0
DEFAULT_FIRST_LINE_INDENT = 0.5

BLOCK_TYPES = ("paragraph", "numbered", "bulleted", "table", "page_break", "signature", "spacer")
ALIGNMENTS = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
    "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
}

# Characters XML 1.0 cannot carry; python-docx raises on them. Tab, newline
# and carriage return are kept (they become tabs and line breaks).
XML_INVALID = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")

INLINE = re.compile(
    r"\*\*(?P<b>[^*\s](?:.*?[^*\s])?)\*\*"
    r"|__(?P<u>[^_\s](?:.*?[^_\s])?)__"
    r"|\*(?P<i>[^*\s](?:.*?[^*\s])?)\*",
    re.S,
)


def fail(message):
    raise SystemExit("ERROR: " + message)


# ----------------------------------------------------------------- validation


def check_str(value, path, required=True, max_len=20000):
    if value is None:
        if required:
            fail("%s is required" % path)
        return None
    if not isinstance(value, str):
        fail("%s must be a string" % path)
    if len(value) > max_len:
        fail("%s is longer than %d characters" % (path, max_len))
    return value


def check_lines(value, path, required=False):
    if value is None:
        if required:
            fail("%s is required" % path)
        return None
    if not isinstance(value, list):
        fail("%s must be a list of strings" % path)
    for i, line in enumerate(value):
        check_str(line, "%s[%d]" % (path, i), max_len=2000)
    return value


def check_number(value, path, low, high, integer=False):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail("%s must be a number" % path)
    if integer and int(value) != value:
        fail("%s must be a whole number" % path)
    if value < low or value > high:
        fail("%s must be between %s and %s" % (path, low, high))
    return value


def check_bool(value, path):
    if value is not None and not isinstance(value, bool):
        fail("%s must be true or false" % path)
    return value


def check_enum(value, path, allowed):
    if value is not None and value not in allowed:
        fail("%s must be one of: %s" % (path, ", ".join(allowed)))
    return value


def validate_block(block, path):
    if not isinstance(block, dict):
        fail("%s must be an object" % path)
    kind = block.get("type")
    if kind not in BLOCK_TYPES:
        fail("%s.type must be one of: %s" % (path, ", ".join(BLOCK_TYPES)))
    if kind == "paragraph":
        check_str(block.get("text"), path + ".text")
        check_enum(block.get("style"), path + ".style", ("body", "quote", "indented"))
        check_enum(block.get("align"), path + ".align", tuple(ALIGNMENTS))
        check_number(block.get("first_line_indent"), path + ".first_line_indent", 0, 1.5)
    elif kind in ("numbered", "bulleted"):
        items = block.get("items")
        if not isinstance(items, list) or not items:
            fail("%s.items must be a non-empty list of strings" % path)
        for i, item in enumerate(items):
            check_str(item, "%s.items[%d]" % (path, i))
        if kind == "numbered":
            check_number(block.get("start"), path + ".start", 1, 10000, integer=True)
    elif kind == "table":
        columns = block.get("columns")
        if not isinstance(columns, list) or not columns or len(columns) > 12:
            fail("%s.columns must be a list of 1 to 12 strings" % path)
        for i, col in enumerate(columns):
            check_str(col, "%s.columns[%d]" % (path, i), max_len=500)
        rows = block.get("rows")
        if not isinstance(rows, list):
            fail("%s.rows must be a list of rows" % path)
        for r, row in enumerate(rows):
            if not isinstance(row, list):
                fail("%s.rows[%d] must be a list of cell strings" % (path, r))
            if len(row) > len(columns):
                fail("%s.rows[%d] has %d cells but the table has %d columns" % (path, r, len(row), len(columns)))
            for c, cell in enumerate(row):
                check_str(cell, "%s.rows[%d][%d]" % (path, r, c), max_len=5000)
        widths = block.get("column_widths")
        if widths is not None:
            if not isinstance(widths, list) or len(widths) != len(columns):
                fail("%s.column_widths must have one width per column" % path)
            for i, w in enumerate(widths):
                check_number(w, "%s.column_widths[%d]" % (path, i), 0.3, 7)
    elif kind == "signature":
        check_lines(block.get("lines"), path + ".lines", required=True)
        check_enum(block.get("align"), path + ".align", ("left", "right"))
    elif kind == "spacer":
        check_number(block.get("lines"), path + ".lines", 1, 30, integer=True)


def validate(spec):
    if not isinstance(spec, dict):
        fail("the spec must be a JSON object")
    title = check_str(spec.get("title"), "title", max_len=500)
    if not title.strip():
        fail("title must not be empty")
    check_bool(spec.get("show_title"), "show_title")
    check_bool(spec.get("firm_letterhead"), "firm_letterhead")
    validate_letterhead(spec)
    check_lines(spec.get("counsel_block"), "counsel_block")
    check_lines(spec.get("top_right_lines"), "top_right_lines")
    check_lines(spec.get("header_lines"), "header_lines")
    caption = spec.get("caption")
    if caption is not None:
        if not isinstance(caption, dict):
            fail("caption must be an object")
        for key in ("lines", "left", "right"):
            check_lines(caption.get(key), "caption." + key)
        check_str(caption.get("divider"), "caption.divider", required=False, max_len=3)
    check_lines(spec.get("after_caption_lines"), "after_caption_lines")
    sections = spec.get("sections")
    if not isinstance(sections, list) or not sections:
        fail("sections must be a non-empty list")
    for s, section in enumerate(sections):
        path = "sections[%d]" % s
        if not isinstance(section, dict):
            fail("%s must be an object" % path)
        check_str(section.get("heading"), path + ".heading", required=False, max_len=1000)
        check_number(section.get("level"), path + ".level", 1, 3, integer=True)
        check_bool(section.get("page_break_before"), path + ".page_break_before")
        check_bool(section.get("repeat_caption"), path + ".repeat_caption")
        blocks = section.get("blocks")
        if not isinstance(blocks, list):
            fail("%s.blocks must be a list" % path)
        for b, block in enumerate(blocks):
            validate_block(block, "%s.blocks[%d]" % (path, b))
    check_str(spec.get("footer_text"), "footer_text", required=False, max_len=300)
    check_str(spec.get("font"), "font", required=False, max_len=60)
    check_number(spec.get("font_size"), "font_size", 8, 16)
    check_number(spec.get("line_spacing"), "line_spacing", 1, 3)
    check_enum(spec.get("body_alignment"), "body_alignment", ("justify", "left"))
    check_number(spec.get("first_line_indent"), "first_line_indent", 0, 1.5)
    check_bool(spec.get("page_numbers"), "page_numbers")
    check_bool(spec.get("number_first_page"), "number_first_page")
    check_str(spec.get("confidentiality_banner"), "confidentiality_banner", required=False, max_len=200)
    check_bool(spec.get("plain_ascii"), "plain_ascii")
    check_bool(spec.get("forbid_typographic_punctuation"), "forbid_typographic_punctuation")


def validate_letterhead(spec):
    """The letterhead the app fills from the firm identity when firm_letterhead is set."""
    letterhead = spec.get("letterhead")
    if letterhead is None:
        if spec.get("firm_letterhead"):
            fail("firm_letterhead is set but no letterhead was supplied with the spec")
        return
    if not isinstance(letterhead, dict):
        fail("letterhead must be an object")
    for key in ("name", "phone", "email"):
        if not check_str(letterhead.get(key), "letterhead." + key, max_len=500).strip():
            fail("letterhead.%s must not be empty" % key)
    check_lines(letterhead.get("address_lines"), "letterhead.address_lines", required=True)
    for key in ("fax", "licensure_line", "website"):
        check_str(letterhead.get(key), "letterhead." + key, required=False, max_len=500)


# Characters forbid_typographic_punctuation refuses: en and em dashes, curly
# single and double quotation marks.
TYPOGRAPHIC_PUNCTUATION = "\u2013\u2014\u2018\u2019\u201c\u201d"


def model_text(spec):
    """The spec without the app-filled letterhead: the text the punctuation gates check."""
    return dict((k, v) for k, v in spec.items() if k != "letterhead")


def find_typographic(obj, path="spec", found=None):
    """Every dash or curly quote forbid_typographic_punctuation refuses, with where it first appears."""
    if found is None:
        found = {}
    if isinstance(obj, str):
        for ch in obj:
            if ch in TYPOGRAPHIC_PUNCTUATION:
                found.setdefault(ch, path)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            find_typographic(v, "%s[%d]" % (path, i), found)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            find_typographic(v, "%s.%s" % (path, k), found)
    return found


def find_non_ascii(obj, path="spec", found=None):
    """Every non-ASCII character in the spec's strings, with where it first appears."""
    if found is None:
        found = {}
    if isinstance(obj, str):
        for ch in obj:
            if ord(ch) > 126 or (ord(ch) < 32 and ch not in "\t\n\r"):
                found.setdefault(ch, path)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            find_non_ascii(v, "%s[%d]" % (path, i), found)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            find_non_ascii(v, "%s.%s" % (path, k), found)
    return found


def clean(text):
    return XML_INVALID.sub("", text)


# ------------------------------------------------------------------ helpers


def set_style_font(style, name, size, bold=None, italic=None):
    """Point a style at the document font, overriding the template's theme fonts and colors."""
    font = style.font
    font.name = name
    font.size = Pt(size)
    font.color.rgb = RGBColor(0, 0, 0)
    if bold is not None:
        font.bold = bold
    if italic is not None:
        font.italic = italic
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    # Theme attributes win over explicit names in Word, so drop them.
    for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        rfonts.attrib.pop(qn(attr), None)
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        rfonts.set(qn(attr), name)


def add_text_run(par, text, bold=False, italic=False, underline=False, size=None):
    if not text:
        return None
    run = par.add_run(clean(text))
    if bold:
        run.bold = True
    if italic:
        run.italic = True
    if underline:
        run.underline = True
    if size:
        run.font.size = Pt(size)
    return run


def add_inline(par, text, bold=False, italic=False, underline=False, size=None):
    """Write text into a paragraph, honoring **bold**, *italic* and __underline__ (nestable)."""
    pos = 0
    for m in INLINE.finditer(text):
        if m.start() > pos:
            add_text_run(par, text[pos:m.start()], bold, italic, underline, size)
        if m.group("b") is not None:
            add_inline(par, m.group("b"), True, italic, underline, size)
        elif m.group("u") is not None:
            add_inline(par, m.group("u"), bold, italic, True, size)
        else:
            add_inline(par, m.group("i"), bold, True, underline, size)
        pos = m.end()
    if pos < len(text):
        add_text_run(par, text[pos:], bold, italic, underline, size)


def single_spaced(par, after=0):
    fmt = par.paragraph_format
    fmt.line_spacing = 1.0
    fmt.space_before = Pt(0)
    fmt.space_after = Pt(after)
    return par


def add_field(par, instruction, placeholder, size=None):
    """A Word field (e.g. PAGE): begin, instruction, separate, cached value, end."""

    def fld_char(kind):
        run = par.add_run()
        el = OxmlElement("w:fldChar")
        el.set(qn("w:fldCharType"), kind)
        run._r.append(el)
        if size:
            run.font.size = Pt(size)

    fld_char("begin")
    run = par.add_run()
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " %s " % instruction
    run._r.append(instr)
    if size:
        run.font.size = Pt(size)
    fld_char("separate")
    add_text_run(par, placeholder, size=size)
    fld_char("end")


def shade_cell(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tc_pr.append(shd)


# The w:pPr children that must come after w:pBdr (the schema's order).
PBDR_SUCCESSORS = (
    "w:shd", "w:tabs", "w:suppressAutoHyphens", "w:kinsoku", "w:wordWrap", "w:overflowPunct",
    "w:topLinePunct", "w:autoSpaceDE", "w:autoSpaceDN", "w:bidi", "w:adjustRightInd",
    "w:snapToGrid", "w:spacing", "w:ind", "w:contextualSpacing", "w:mirrorIndents",
    "w:suppressOverlap", "w:jc", "w:textDirection", "w:textAlignment", "w:textboxTightWrap",
    "w:outlineLvl", "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange",
)


def bottom_border(par):
    """A single 1.5 pt rule under the paragraph (the letterhead's)."""
    p_pr = par._p.get_or_add_pPr()
    p_bdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "12")
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), "auto")
    p_bdr.append(bottom)
    p_pr.insert_element_before(p_bdr, *PBDR_SUCCESSORS)


def repeat_as_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:tblHeader")
    el.set(qn("w:val"), "true")
    tr_pr.append(el)


def set_column_widths(table, widths_in):
    # autofit False writes <w:tblLayout w:type="fixed"/> in schema order, so
    # Word and LibreOffice both keep these widths instead of resizing to fit.
    table.autofit = False
    for i, width in enumerate(widths_in):
        table.columns[i].width = Inches(width)
        for cell in table.columns[i].cells:
            cell.width = Inches(width)


def write_cell(cell, text, size, bold=False, align=None):
    lines_in_cell = text.split("\n") if text else [""]
    first = True
    for line in lines_in_cell:
        par = cell.paragraphs[0] if first else cell.add_paragraph()
        first = False
        single_spaced(par)
        if align is not None:
            par.alignment = align
        add_inline(par, line, bold=bold, size=size)


# ------------------------------------------------------------------ builder


class Builder(object):
    def __init__(self, spec):
        self.spec = spec
        self.font = spec.get("font") or DEFAULT_FONT
        self.size = spec.get("font_size") or DEFAULT_FONT_SIZE
        self.line_spacing = spec.get("line_spacing") or DEFAULT_LINE_SPACING
        indent = spec.get("first_line_indent")
        self.first_line_indent = DEFAULT_FIRST_LINE_INDENT if indent is None else indent
        self.body_align = ALIGNMENTS[spec.get("body_alignment") or "justify"]
        self.plain_ascii = bool(spec.get("plain_ascii"))
        self.small = max(8, self.size - 2)
        # Single-spaced body text needs space between paragraphs; double-spaced
        # text is separated by its first-line indent, as courts expect.
        self.body_after = Pt(self.size) if self.line_spacing < 1.5 else Pt(0)
        self.doc = Document()

    # ---- page setup and styles

    def setup(self):
        section = self.doc.sections[0]
        section.page_width = Inches(PAGE_WIDTH_IN)
        section.page_height = Inches(PAGE_HEIGHT_IN)
        for side in ("top_margin", "bottom_margin", "left_margin", "right_margin"):
            setattr(section, side, Inches(MARGIN_IN))

        normal = self.doc.styles["Normal"]
        set_style_font(normal, self.font, self.size)
        normal.paragraph_format.space_before = Pt(0)
        normal.paragraph_format.space_after = Pt(0)
        normal.paragraph_format.line_spacing = 1.0

        for level in (1, 2, 3):
            style = self.doc.styles["Heading %d" % level]
            set_style_font(style, self.font, self.size, bold=True, italic=(level == 3))
            fmt = style.paragraph_format
            fmt.space_before = Pt(self.size)
            fmt.space_after = Pt(self.size)
            fmt.line_spacing = 1.0
            fmt.keep_with_next = True
            fmt.alignment = WD_ALIGN_PARAGRAPH.CENTER if level == 1 else WD_ALIGN_PARAGRAPH.LEFT

        core = self.doc.core_properties
        core.title = clean(self.spec["title"])
        core.author = ""
        core.last_modified_by = ""
        core.comments = ""

    def header_footer(self):
        spec = self.spec
        section = self.doc.sections[0]
        banner = spec.get("confidentiality_banner")
        page_numbers = spec.get("page_numbers", True) is not False
        footer_text = spec.get("footer_text")
        number_first = spec.get("number_first_page", True) is not False

        if not number_first:
            section.different_first_page_header_footer = True

        headers = [section.header] + ([section.first_page_header] if not number_first else [])
        if banner:
            for header in headers:
                header.is_linked_to_previous = False
                par = header.paragraphs[0]
                par.alignment = WD_ALIGN_PARAGRAPH.CENTER
                add_text_run(par, banner, bold=True, size=self.small)

        footer = section.footer
        footer.is_linked_to_previous = False
        par = footer.paragraphs[0]
        par.alignment = WD_ALIGN_PARAGRAPH.CENTER
        used_first = False
        if page_numbers:
            add_field(par, "PAGE", "1", size=self.small)
            used_first = True
        if footer_text:
            target = footer.add_paragraph() if used_first else par
            target.alignment = WD_ALIGN_PARAGRAPH.CENTER
            add_inline(target, footer_text, size=self.small)
        # The first-page footer (when distinct) stays empty: a cover page.

    # ---- front matter

    def letterhead(self):
        """
        The firm letterhead the app filled from the firm identity: the name
        (16 pt) and address lines (14 pt) bold in capitals, the licensure line
        and website in italics, all centered, then two bold italic contact
        rows, the phone with "Email Address" and the fax with the email
        address flush right, and a rule under them.
        """
        letterhead = self.spec.get("letterhead")
        if not letterhead:
            return
        centered = []
        par = single_spaced(self.doc.add_paragraph())
        add_text_run(par, letterhead["name"].upper(), bold=True, size=16)
        centered.append(par)
        for line in letterhead.get("address_lines") or []:
            par = single_spaced(self.doc.add_paragraph())
            add_text_run(par, line.upper(), bold=True, size=14)
            centered.append(par)
        for line in (letterhead.get("licensure_line"), letterhead.get("website")):
            if line:
                par = single_spaced(self.doc.add_paragraph())
                add_text_run(par, line, italic=True)
                centered.append(par)
        for par in centered:
            par.alignment = WD_ALIGN_PARAGRAPH.CENTER

        fax = letterhead.get("fax")
        rows = [
            (letterhead["phone"], "Email Address"),
            ("%s(fax)" % fax if fax else "", letterhead["email"]),
        ]
        for i, (left, right) in enumerate(rows):
            par = single_spaced(self.doc.add_paragraph())
            par.paragraph_format.tab_stops.add_tab_stop(Inches(TEXT_WIDTH_IN), WD_TAB_ALIGNMENT.RIGHT)
            add_text_run(par, left, bold=True, italic=True)
            add_text_run(par, "\t", bold=True, italic=True)
            add_text_run(par, right, bold=True, italic=True)
            if i == len(rows) - 1:
                bottom_border(par)
        self.doc.add_paragraph()

    def counsel_block(self):
        block = self.spec.get("counsel_block") or []
        right = self.spec.get("top_right_lines") or []
        if not block and not right:
            return
        if right:
            # Counsel at the left and, level with it, lines flush right (e.g. a
            # detention status): one borderless row, drawn like the caption.
            table = self.doc.add_table(rows=1, cols=2)
            set_column_widths(table, [TEXT_WIDTH_IN - 2.0, 2.0])
            cells = table.rows[0].cells
            write_cell(cells[0], "\n".join(block), self.size)
            write_cell(cells[1], "\n".join(right), self.size, align=WD_ALIGN_PARAGRAPH.RIGHT)
        else:
            for line in block:
                add_inline(single_spaced(self.doc.add_paragraph()), line)
        self.doc.add_paragraph()

    def header_lines(self):
        lines = self.spec.get("header_lines")
        if not lines:
            return
        for line in lines:
            par = single_spaced(self.doc.add_paragraph())
            par.alignment = WD_ALIGN_PARAGRAPH.CENTER
            add_inline(par, line, bold=True)
        self.doc.add_paragraph()

    def caption(self):
        caption = self.spec.get("caption")
        if not caption:
            return
        wrote = False
        for line in caption.get("lines") or []:
            add_inline(single_spaced(self.doc.add_paragraph()), line)
            wrote = True
        left = caption.get("left") or []
        right = caption.get("right") or []
        if left or right:
            if wrote:
                self.doc.add_paragraph()
            divider = caption.get("divider") or ")"
            rows = max(len(left), len(right), 1)
            table = self.doc.add_table(rows=1, cols=3)
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            set_column_widths(table, [3.0, 0.5, 3.0])
            cells = table.rows[0].cells
            write_cell(cells[0], "\n".join(left), self.size)
            write_cell(cells[1], "\n".join([divider] * rows), self.size, align=WD_ALIGN_PARAGRAPH.CENTER)
            write_cell(cells[2], "\n".join(right), self.size)
            wrote = True
        if wrote:
            self.doc.add_paragraph()

    def after_caption(self):
        lines = self.spec.get("after_caption_lines")
        if not lines:
            return
        for line in lines:
            add_inline(single_spaced(self.doc.add_paragraph()), line)
        self.doc.add_paragraph()

    def title(self):
        if self.spec.get("show_title", True) is False:
            return
        par = self.doc.add_paragraph()
        par.alignment = WD_ALIGN_PARAGRAPH.CENTER
        single_spaced(par, after=self.size)
        par.paragraph_format.keep_with_next = True
        add_inline(par, self.spec["title"], bold=True)

    # ---- body

    def body_paragraph(self, text, style="body", align=None, first_line_indent=None):
        par = self.doc.add_paragraph()
        fmt = par.paragraph_format
        fmt.space_before = Pt(0)
        if style == "quote":
            fmt.line_spacing = 1.0
            fmt.left_indent = Inches(1)
            fmt.right_indent = Inches(1)
            fmt.space_after = Pt(self.size)
            par.alignment = ALIGNMENTS[align] if align else self.body_align
        else:
            fmt.line_spacing = self.line_spacing
            fmt.space_after = self.body_after
            indent = self.first_line_indent if first_line_indent is None else first_line_indent
            if style == "indented":
                fmt.left_indent = Inches(0.5)
            elif indent:
                fmt.first_line_indent = Inches(indent)
            par.alignment = ALIGNMENTS[align] if align else self.body_align
        add_inline(par, text)
        return par

    def list_paragraph(self, marker, text, indent_in, hang_in):
        par = self.doc.add_paragraph()
        fmt = par.paragraph_format
        fmt.line_spacing = self.line_spacing
        fmt.space_before = Pt(0)
        fmt.space_after = self.body_after
        fmt.left_indent = Inches(indent_in)
        fmt.first_line_indent = Inches(-hang_in)
        fmt.tab_stops.add_tab_stop(Inches(indent_in), WD_TAB_ALIGNMENT.LEFT)
        par.alignment = self.body_align
        add_text_run(par, marker + "\t")
        add_inline(par, text)

    def table(self, block):
        columns = block["columns"]
        rows = block.get("rows") or []
        table = self.doc.add_table(rows=1 + len(rows), cols=len(columns))
        table.style = "Table Grid"
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        widths = block.get("column_widths") or [TEXT_WIDTH_IN / len(columns)] * len(columns)
        set_column_widths(table, widths)
        cell_size = max(8, self.size - 1)
        header = table.rows[0]
        repeat_as_header(header)
        for i, label in enumerate(columns):
            write_cell(header.cells[i], label, cell_size, bold=True)
            shade_cell(header.cells[i], "D9D9D9")
        for r, row in enumerate(rows):
            cells = table.rows[r + 1].cells
            for c in range(len(columns)):
                write_cell(cells[c], row[c] if c < len(row) else "", cell_size)
        # A table must not run straight into the next paragraph.
        single_spaced(self.doc.add_paragraph())

    def signature(self, block):
        lines = block["lines"]
        single_spaced(self.doc.add_paragraph()).paragraph_format.keep_with_next = True
        for i, line in enumerate(lines):
            par = single_spaced(self.doc.add_paragraph())
            fmt = par.paragraph_format
            fmt.keep_together = True
            fmt.keep_with_next = i < len(lines) - 1
            if block.get("align", "right") != "left":
                fmt.left_indent = Inches(3.25)
            add_inline(par, line)

    def block(self, block):
        kind = block["type"]
        if kind == "paragraph":
            self.body_paragraph(
                block["text"], block.get("style") or "body", block.get("align"), block.get("first_line_indent")
            )
        elif kind == "numbered":
            number = block.get("start") or 1
            for item in block["items"]:
                self.list_paragraph("%d." % number, item, 0.5, 0.5)
                number += 1
        elif kind == "bulleted":
            bullet = "-" if self.plain_ascii else "\u2022"
            for item in block["items"]:
                self.list_paragraph(bullet, item, 0.75, 0.25)
        elif kind == "table":
            self.table(block)
        elif kind == "page_break":
            self.doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        elif kind == "signature":
            self.signature(block)
        elif kind == "spacer":
            for _ in range(block.get("lines") or 1):
                single_spaced(self.doc.add_paragraph())

    def section(self, section, first):
        heading = section.get("heading")
        page_break = bool(section.get("page_break_before")) and not first
        if section.get("repeat_caption"):
            # A brief's first text page after its cover page: the court
            # heading, caption and title again, without the first page's
            # counsel block, top_right_lines or after_caption_lines.
            if page_break:
                self.doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
                page_break = False
            self.header_lines()
            self.caption()
            self.title()
        if heading:
            level = section.get("level") or 1
            par = self.doc.add_paragraph(style="Heading %d" % level)
            if page_break:
                par.paragraph_format.page_break_before = True
            add_inline(par, heading)
        elif page_break:
            self.doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        for block in section["blocks"]:
            self.block(block)

    def build(self, out_path):
        self.setup()
        self.header_footer()
        self.letterhead()
        self.counsel_block()
        self.header_lines()
        self.caption()
        self.after_caption()
        self.title()
        for i, section in enumerate(self.spec["sections"]):
            self.section(section, first=(i == 0 and not self.has_front_matter()))
        self.doc.save(out_path)
        return out_path

    def has_front_matter(self):
        spec = self.spec
        return bool(
            spec.get("letterhead")
            or spec.get("counsel_block")
            or spec.get("top_right_lines")
            or spec.get("header_lines")
            or spec.get("caption")
            or spec.get("after_caption_lines")
            or spec.get("show_title", True) is not False
        )


SPEC_TEMPLATE = {
    "title": "RESPONDENT'S [DOCUMENT TITLE]",
    "counsel_block": ["[Attorney name], Esq.", "[Firm]", "[Address]", "[Phone]"],
    "header_lines": [
        "UNITED STATES DEPARTMENT OF JUSTICE",
        "EXECUTIVE OFFICE FOR IMMIGRATION REVIEW",
        "IMMIGRATION COURT",
        "[CITY, STATE]",
    ],
    "caption": {
        "left": ["In the Matter of:", "", "**[SURNAME, Given Names]**", "", "Respondent."],
        "right": ["", "File No.: A [000-000-000]", "", "In Removal Proceedings"],
    },
    "sections": [
        {
            "heading": "I. INTRODUCTION",
            "blocks": [{"type": "paragraph", "text": "[Body text. Case names in *italics*.]"}],
        },
        {
            "heading": "CERTIFICATE OF SERVICE",
            "page_break_before": True,
            "blocks": [
                {"type": "paragraph", "text": "[Service text.]"},
                {"type": "signature", "lines": ["______________________", "[Name]", "[Date]"]},
            ],
        },
    ],
    "line_spacing": 2,
    "page_numbers": True,
}


def main():
    args = sys.argv[1:]
    if args and args[0] == "--template":
        print(json.dumps(SPEC_TEMPLATE, indent=2))
        return
    if len(args) != 2:
        raise SystemExit(
            "Usage: python3 make_document.py spec.json out.docx\n"
            "       python3 make_document.py --template > spec.json"
        )
    with open(args[0], encoding="utf-8") as fh:
        try:
            spec = json.load(fh)
        except ValueError as err:
            fail("spec.json is not valid JSON: %s" % err)
    validate(spec)
    # Both gates check the model's text only: the letterhead is the firm's
    # own name and details, which the model cannot change.
    if spec.get("plain_ascii"):
        found = find_non_ascii(model_text(spec))
        if found:
            detail = "\n".join(
                "  U+%04X %r first seen in %s" % (ord(ch), ch, where) for ch, where in sorted(found.items())
            )
            fail(
                "plain_ascii is set, but the spec contains non-ASCII characters:\n%s\n"
                "Replace them (a hyphen or comma for a dash, straight quotes for curly ones) "
                "or drop plain_ascii if the characters are intended, e.g. an accent in a name." % detail
            )
    if spec.get("forbid_typographic_punctuation"):
        found = find_typographic(model_text(spec))
        if found:
            detail = "\n".join(
                "  U+%04X %r first seen in %s" % (ord(ch), ch, where) for ch, where in sorted(found.items())
            )
            fail(
                "forbid_typographic_punctuation is set, but the spec contains dashes or curly quotes:\n%s\n"
                "Replace each dash with a comma, colon, semicolon, parentheses or a new sentence, "
                "and each curly quote or apostrophe with a straight one." % detail
            )
    print("Wrote %s" % Builder(spec).build(args[1]))


if __name__ == "__main__":
    main()
