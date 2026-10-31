#!/usr/bin/env python3
"""
Applies an orthography check's certain fixes to the author's own Word file,
for the skill runner's make_corrected_copy tool
(src/services/skill-runner/tools/orthography-check.ts).

Usage:
    python3 apply_corrections.py spec.json out.docx

orthography-check's references/file-handling.md: "change only the runs that
contain an actual fix and leave every other run, style, table, and heading
exactly as it was. Do not rebuild the document from scratch; open it, apply
the specific text substitutions, and save." That is all this script does. It
is not one of the firm's scripts; nothing in it names a firm.

The spec (written by the tool, never by the model directly):
    source           bare file name of the uploaded .docx, next to spec.json
    report           bare file name for the JSON report written next to spec.json
    tracked_changes  true: each fix becomes a tracked deletion and insertion
    author, date     the tracked changes' author and ISO 8601 time
    corrections      [{original, corrected, replace_all?, occurrence?}]

Which text is searched and changed: exactly the paragraphs
src/services/ingest/docx_to_text.py gives skill runs (body paragraphs, the
paragraphs of body table cells, the default header and footer of each
section), read the way python-docx reads Paragraph.text (runs and hyperlinks
directly in the paragraph). A paragraph whose text this script would read
differently from python-docx is never changed. Text the model was never
shown (text boxes, footnotes, endnotes, comments, content controls, other
headers and footers, the inside of unaccepted tracked changes) is never
changed either; the report counts it, so the skill can say it was not checked.

Matching treats curly and straight quotes, and non-breaking and ordinary
spaces, as the same character, and changes only the characters that differ
between "original" and "corrected", so formatting runs around a fix stay as
they were.

All or nothing: if any correction cannot be applied exactly (not found,
ambiguous, overlapping another, crossing a tab or line break), nothing is
written; the script prints every problem to stderr and exits 1.
"""

import copy
import json
import os
import re
import sys

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph
from lxml import etree

W_P = qn("w:p")
W_R = qn("w:r")
W_T = qn("w:t")
W_RPR = qn("w:rPr")
W_HYPERLINK = qn("w:hyperlink")
W_TBL = qn("w:tbl")
W_TAB = qn("w:tab")
W_PTAB = qn("w:ptab")
W_BR = qn("w:br")
W_CR = qn("w:cr")
W_NO_BREAK_HYPHEN = qn("w:noBreakHyphen")
W_TYPE = qn("w:type")
W_ID = qn("w:id")
W_SDT = qn("w:sdt")
W_TXBX_CONTENT = qn("w:txbxContent")
REVISION_TAGS = (qn("w:ins"), qn("w:del"), qn("w:moveFrom"), qn("w:moveTo"))
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
MC_FALLBACK = "{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback"

REL_FOOTNOTES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes"
REL_ENDNOTES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes"
REL_COMMENTS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"

# One-for-one stand-ins used only to compare text, so a fix the model typed
# with a straight apostrophe still finds the document's curly one. Every
# entry maps one character to one character, so offsets never shift.
MATCH_EQUIVALENTS = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201b": "'",
        "\u2032": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u201f": '"',
        "\u2033": '"',
        "\u00a0": " ",
        "\u2007": " ",
        "\u202f": " ",
    }
)

# Characters XML 1.0 cannot carry (tab and newline are refused separately).
XML_INVALID = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")
BARE_FILE_NAME = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$")
CONTEXT_CHARS = 30
# Notes and comments parts are parsed only to count what was not checked.
SAFE_PARSER = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False)


class SpecError(Exception):
    pass


def for_matching(text):
    return text.translate(MATCH_EQUIVALENTS)


def shorten(text):
    return text if len(text) <= 60 else text[:57] + "..."


def describe(correction, index):
    return f'Correction {index + 1} ("{shorten(correction["original"])}" -> "{shorten(correction["corrected"])}")'


# ---------------------------------------------------------------- spec


def load_spec(spec_path):
    try:
        with open(spec_path, encoding="utf-8") as f:
            spec = json.load(f)
    except (OSError, ValueError) as exc:
        raise SpecError(f"Could not read the spec: {exc}")
    if not isinstance(spec, dict):
        raise SpecError("The spec must be a JSON object.")
    for key in ("source", "report"):
        value = spec.get(key)
        if not isinstance(value, str) or not BARE_FILE_NAME.match(value):
            raise SpecError(f"spec.{key} must be a bare file name next to spec.json.")
    if not isinstance(spec.get("tracked_changes"), bool):
        raise SpecError("spec.tracked_changes must be true or false.")
    for key in ("author", "date"):
        if not isinstance(spec.get(key), str) or not spec[key].strip():
            raise SpecError(f"spec.{key} must be a non-empty string.")
    corrections = spec.get("corrections")
    if not isinstance(corrections, list):
        raise SpecError("spec.corrections must be a list.")
    for i, c in enumerate(corrections):
        if not isinstance(c, dict) or not isinstance(c.get("original"), str) or not isinstance(c.get("corrected"), str):
            raise SpecError(f"spec.corrections[{i}] needs string original and corrected.")
        if not c["original"]:
            raise SpecError(f"spec.corrections[{i}].original is empty.")
        if c.get("replace_all") is not None and not isinstance(c["replace_all"], bool):
            raise SpecError(f"spec.corrections[{i}].replace_all must be true or false.")
        occurrence = c.get("occurrence")
        if occurrence is not None and (isinstance(occurrence, bool) or not isinstance(occurrence, int) or occurrence < 1):
            raise SpecError(f"spec.corrections[{i}].occurrence must be a whole number from 1.")
    return spec


def correction_problem(c):
    """Why a correction can never be applied, whatever the document says; None when it can."""
    original, corrected = c["original"], c["corrected"]
    if any(ch in original + corrected for ch in "\r\n"):
        return "contains a line break; a fix must lie within one paragraph or table cell."
    if XML_INVALID.search(original + corrected):
        return "contains a control character a Word document cannot hold."
    if c.get("replace_all") and c.get("occurrence") is not None:
        return "gives both replace_all and occurrence; use one."
    if for_matching(original) == for_matching(corrected):
        return (
            "changes nothing this tool can apply: original and corrected are the same, or differ only in "
            "curly versus straight quotes or non-breaking spaces, which it treats as the same character."
        )
    return None


# ---------------------------------------------------------------- reading the paragraphs the model saw


class Atom:
    """One piece of a paragraph's text: a w:t (editable) or a tab, break or hyphen (not)."""

    __slots__ = ("el", "run", "text", "start", "end", "editable")

    def __init__(self, el, run, text, start, editable):
        self.el = el
        self.run = run
        self.text = text
        self.start = start
        self.end = start + len(text)
        self.editable = editable


def run_pieces(run):
    # The children python-docx's Run.text reads, with the text it gives them.
    for child in run.iterchildren():
        tag = child.tag
        if tag == W_T:
            yield child, child.text or "", True
        elif tag in (W_TAB, W_PTAB):
            yield child, "\t", False
        elif tag == W_CR:
            yield child, "\n", False
        elif tag == W_BR:
            yield child, "\n" if child.get(W_TYPE) in (None, "textWrapping") else "", False
        elif tag == W_NO_BREAK_HYPHEN:
            yield child, "-", False


def paragraph_atoms(p):
    atoms = []
    position = 0
    for child in p.iterchildren():
        if child.tag == W_R:
            runs = [child]
        elif child.tag == W_HYPERLINK:
            runs = list(child.iterchildren(W_R))
        else:
            continue
        for run in runs:
            for el, text, editable in run_pieces(run):
                atom = Atom(el, run, text, position, editable)
                atoms.append(atom)
                position = atom.end
    return atoms


class ReviewedParagraph:
    def __init__(self, where, p):
        self.where = where
        self.p = p
        atoms = paragraph_atoms(p)
        self.text = "".join(a.text for a in atoms)
        self.match_text = for_matching(self.text)
        # Only a paragraph whose text reads exactly as python-docx (and so
        # the extracted text the model was given) reads it is ever edited.
        self.supported = self.text == Paragraph(p, None).text


def reviewed_paragraphs(document):
    """The paragraphs docx_to_text.py extracts, in its order, each once."""
    found = []
    seen = set()

    def add(where, p):
        if p in seen:
            return
        seen.add(p)
        found.append(ReviewedParagraph(where, p))

    for child in document.element.body.iterchildren():
        if child.tag == W_P:
            add("body", child)
        elif child.tag == W_TBL:
            for row in Table(child, document).rows:
                for cell in row.cells:
                    for paragraph in cell.paragraphs:
                        add("table", paragraph._p)
    for section in document.sections:
        for where, part in (("header", section.header), ("footer", section.footer)):
            if part is None or part.is_linked_to_previous:
                continue
            for paragraph in part.paragraphs:
                add(where, paragraph._p)
    return found


def has_ancestor(el, tag):
    parent = el.getparent()
    while parent is not None:
        if parent.tag == tag:
            return True
        parent = parent.getparent()
    return False


def plural(n, one, many=None):
    return f"{n} {one if n == 1 else (many or one + 's')}"


def count_part_items(document, reltype, tag, skip_separators):
    count = 0
    for rel in document.part.rels.values():
        if rel.is_external or rel.reltype != reltype:
            continue
        try:
            root = etree.fromstring(rel.target_part.blob, SAFE_PARSER)
        except etree.XMLSyntaxError:
            continue
        for item in root.iter(tag):
            # Footnote and endnote separators carry a w:type; real notes do not.
            if skip_separators and item.get(W_TYPE) is not None:
                continue
            count += 1
    return count


def not_reviewed(document, paragraphs):
    """What the extracted text left out, so nothing in it was checked or changed."""
    notes = []
    body = document.element.body
    stories = [body]
    for section in document.sections:
        for part in (section.header, section.footer):
            if part is not None and not part.is_linked_to_previous:
                stories.append(part._element)

    text_boxes = sum(
        1 for story in stories for el in story.iter(W_TXBX_CONTENT) if not has_ancestor(el, MC_FALLBACK)
    )
    if text_boxes:
        notes.append(plural(text_boxes, "text box", "text boxes"))

    footnotes = count_part_items(document, REL_FOOTNOTES, qn("w:footnote"), True)
    if footnotes:
        notes.append(plural(footnotes, "footnote"))
    endnotes = count_part_items(document, REL_ENDNOTES, qn("w:endnote"), True)
    if endnotes:
        notes.append(plural(endnotes, "endnote"))
    comments = count_part_items(document, REL_COMMENTS, qn("w:comment"), False)
    if comments:
        notes.append(plural(comments, "comment"))

    content_controls = sum(1 for child in body.iterchildren() if child.tag == W_SDT)
    content_controls += sum(1 for para in paragraphs for child in para.p.iterchildren() if child.tag == W_SDT)
    if content_controls:
        notes.append(plural(content_controls, "content control") + " (for example a cover page or a form field)")

    revisions = sum(1 for story in stories for tag in REVISION_TAGS for _ in story.iter(tag))
    if revisions:
        notes.append(
            plural(revisions, "unaccepted tracked change")
            + " already in the document (the text inside them was not in the extracted text)"
        )

    other_headers = 0
    for section in document.sections:
        for part in (
            section.first_page_header,
            section.first_page_footer,
            section.even_page_header,
            section.even_page_footer,
        ):
            if part is not None and not part.is_linked_to_previous and any(p.text.strip() for p in part.paragraphs):
                other_headers += 1
    if other_headers:
        notes.append(plural(other_headers, "first-page or even-page header or footer", "first-page or even-page headers or footers"))

    unsupported = sum(1 for para in paragraphs if not para.supported)
    if unsupported:
        notes.append(plural(unsupported, "paragraph") + " whose structure this tool does not edit")
    return notes


# ---------------------------------------------------------------- planning


def find_all(haystack, needle):
    hits = []
    i = haystack.find(needle)
    while i != -1:
        hits.append(i)
        i = haystack.find(needle, i + len(needle))
    return hits


def change_region(found, corrected):
    """The part of `found` that actually changes: (start, end, replacement), offsets within found."""
    nf, nc = for_matching(found), for_matching(corrected)
    prefix = 0
    while prefix < len(nf) and prefix < len(nc) and nf[prefix] == nc[prefix]:
        prefix += 1
    suffix = 0
    while (
        suffix < len(nf) - prefix
        and suffix < len(nc) - prefix
        and nf[len(nf) - 1 - suffix] == nc[len(nc) - 1 - suffix]
    ):
        suffix += 1
    return prefix, len(found) - suffix, corrected[prefix : len(corrected) - suffix]


def insertion_point(atoms, position):
    """The w:t that receives text inserted at `position`: the one holding the character before it, else the one starting there."""
    for atom in atoms:
        if atom.editable and atom.start < position <= atom.end:
            return atom, position - atom.start
    for atom in atoms:
        if atom.editable and atom.start == position:
            return atom, 0
    return None, 0


def context(text, start, end):
    before = text[max(0, start - CONTEXT_CHARS) : start]
    after = text[end : end + CONTEXT_CHARS]
    snippet = f"{'...' if start > CONTEXT_CHARS else ''}{before}[{text[start:end]}]{after}{'...' if end + CONTEXT_CHARS < len(text) else ''}"
    return snippet.replace("\t", " ").replace("\n", " / ")


class Edit:
    __slots__ = ("paragraph", "start", "end", "insert", "correction")

    def __init__(self, paragraph, start, end, insert, correction):
        self.paragraph = paragraph
        self.start = start
        self.end = end
        self.insert = insert
        self.correction = correction


def plan(paragraphs, corrections):
    """Every edit the corrections make, or the problems that stop them."""
    problems = []
    edits = []
    applied = []
    for ci, c in enumerate(corrections):
        label = describe(c, ci)
        problem = correction_problem(c)
        if problem:
            problems.append(f"{label} {problem}")
            continue
        needle = for_matching(c["original"])
        hits = []
        unsupported_hits = 0
        for pi, para in enumerate(paragraphs):
            found = find_all(para.match_text, needle)
            if para.supported:
                hits.extend((pi, start) for start in found)
            else:
                unsupported_hits += len(found)

        if not hits:
            if unsupported_hits:
                problems.append(
                    f"{label}: found only in a paragraph whose structure this tool does not edit; flag it for the author instead."
                )
            else:
                problems.append(
                    f"{label}: not found. Copy original exactly as the document has it, within a single paragraph or table cell "
                    "(text boxes, footnotes and comments are not reachable)."
                )
            continue
        occurrence = c.get("occurrence")
        if c.get("replace_all"):
            selected = hits
        elif occurrence is not None:
            if occurrence > len(hits):
                problems.append(f"{label}: occurrence {occurrence} was asked for, but original occurs {plural(len(hits), 'time')}.")
                continue
            selected = [hits[occurrence - 1]]
        elif len(hits) > 1:
            problems.append(
                f"{label}: original occurs {len(hits)} times. Set replace_all to fix every occurrence, give occurrence to fix one, "
                "or lengthen original with the surrounding words so it is unique."
            )
            continue
        else:
            selected = hits

        contexts = []
        ok = True
        for pi, start in selected:
            para = paragraphs[pi]
            found = para.text[start : start + len(c["original"])]
            rel_start, rel_end, insert = change_region(found, c["corrected"])
            a, b = start + rel_start, start + rel_end
            if a == b and not insert:
                problems.append(f"{label}: changes nothing in the document's own text.")
                ok = False
                break
            atoms = paragraph_atoms(para.p)
            if any(not atom.editable and atom.start < b and a < atom.end for atom in atoms):
                problems.append(
                    f"{label}: the change crosses a tab or line break, which this tool does not change; fix the text on each side separately."
                )
                ok = False
                break
            if a == b and insertion_point(atoms, a)[0] is None:
                problems.append(f"{label}: there is no text run to insert into at that point.")
                ok = False
                break
            edits.append(Edit(pi, a, b, insert, ci))
            contexts.append(f"{para.where}: {context(para.text, start, start + len(c['original']))}")
        if ok:
            applied.append({"index": ci, "applied": len(selected), "contexts": contexts[:10]})

    by_paragraph = {}
    for edit in edits:
        by_paragraph.setdefault(edit.paragraph, []).append(edit)
    for paragraph_edits in by_paragraph.values():
        paragraph_edits.sort(key=lambda e: (e.start, e.end))
        for earlier, later in zip(paragraph_edits, paragraph_edits[1:]):
            # Two edits starting at the same point conflict even when one only
            # inserts: the other would change the inserted text.
            if later.start < earlier.end or later.start == earlier.start:
                first, second = sorted((earlier.correction, later.correction))
                message = (
                    f"{describe(corrections[first], first)} and correction {second + 1} change overlapping text in the same paragraph; "
                    "merge them into one correction."
                    if first != second
                    else f"{describe(corrections[first], first)} overlaps itself; make original unique instead of replace_all."
                )
                if message not in problems:
                    problems.append(message)
    return edits, applied, problems


# ---------------------------------------------------------------- editing


def set_text(t, text):
    t.text = text
    if text[:1].isspace() or text[-1:].isspace() or "  " in text:
        t.set(XML_SPACE, "preserve")


def new_run(template_run_attrs, rpr, text, text_tag):
    run = OxmlElement("w:r")
    for key, value in template_run_attrs.items():
        run.set(key, value)
    if rpr is not None:
        run.append(copy.deepcopy(rpr))
    t = OxmlElement(text_tag)
    set_text(t, text)
    run.append(t)
    return run


def has_content(run):
    return any(child.tag != W_RPR for child in run.iterchildren())


def isolate(run, t, local_start, local_end):
    """
    Splits `run` around characters [local_start, local_end) of its w:t `t`,
    so they sit alone in a run of their own with the same properties, and
    returns that run. Every other child of the run keeps its place, in the
    part before or the part after; parts left empty are dropped.
    """
    parent = run.getparent()
    index = list(run).index(t)
    text = t.text or ""
    rpr = run.find(W_RPR)

    before = copy.deepcopy(run)
    before_children = list(before)
    before_t = before_children[index]
    for i, child in enumerate(before_children):
        if i > index and child.tag != W_RPR:
            before.remove(child)
    if text[:local_start]:
        set_text(before_t, text[:local_start])
    else:
        before.remove(before_t)

    after = copy.deepcopy(run)
    after_children = list(after)
    after_t = after_children[index]
    for i, child in enumerate(after_children):
        if i < index and child.tag != W_RPR:
            after.remove(child)
    if text[local_end:]:
        set_text(after_t, text[local_end:])
    else:
        after.remove(after_t)

    middle = new_run(dict(run.attrib), rpr, text[local_start:local_end], "w:t")
    position = parent.index(run)
    parent.remove(run)
    pieces = [piece for piece in (before, middle, after) if piece is middle or has_content(piece)]
    for offset, piece in enumerate(pieces):
        parent.insert(position + offset, piece)
    return middle


class RevisionMarks:
    def __init__(self, document, author, date):
        self.author = author
        self.date = date
        self.next_id = self._max_id(document) + 1

    @staticmethod
    def _max_id(document):
        highest = 0
        for part in document.part.package.iter_parts():
            element = getattr(part, "_element", None)
            if element is None:
                continue
            for el in element.iter():
                value = el.get(W_ID) if isinstance(el.tag, str) else None
                if value is not None and value.lstrip("-").isdigit():
                    highest = max(highest, int(value))
        return highest

    def wrap(self, tag, run):
        mark = OxmlElement(tag)
        mark.set(W_ID, str(self.next_id))
        mark.set(qn("w:author"), self.author)
        mark.set(qn("w:date"), self.date)
        self.next_id += 1
        mark.append(run)
        return mark


def apply_direct(p, edit):
    atoms = paragraph_atoms(p)
    if edit.start == edit.end:
        atom, local = insertion_point(atoms, edit.start)
        set_text(atom.el, atom.text[:local] + edit.insert + atom.text[local:])
        return
    pending = edit.insert
    for atom in atoms:
        if not atom.editable or atom.start == atom.end or atom.end <= edit.start or atom.start >= edit.end:
            continue
        local_start = max(edit.start, atom.start) - atom.start
        local_end = min(edit.end, atom.end) - atom.start
        set_text(atom.el, atom.text[:local_start] + pending + atom.text[local_end:])
        pending = ""


def apply_tracked(p, edit, marks):
    atoms = paragraph_atoms(p)
    if edit.start == edit.end:
        atom, local = insertion_point(atoms, edit.start)
        rpr = atom.run.find(W_RPR)
        attrs = dict(atom.run.attrib)
        placeholder = isolate(atom.run, atom.el, local, local)
        placeholder.addprevious(marks.wrap("w:ins", new_run(attrs, rpr, edit.insert, "w:t")))
        placeholder.getparent().remove(placeholder)
        return

    first = next(a for a in atoms if a.editable and a.start < edit.end and edit.start < a.end)
    first_rpr = first.run.find(W_RPR)
    insert_rpr = copy.deepcopy(first_rpr) if first_rpr is not None else None
    insert_attrs = dict(first.run.attrib)

    # Deleted pieces leave the visible text, so work from the end of the
    # region back: what lies before `end` never moves.
    end = edit.end
    last_deletion = None
    while end > edit.start:
        atoms = paragraph_atoms(p)
        atom = next(a for a in atoms if a.editable and a.start < end <= a.end)
        local_start = max(edit.start, atom.start) - atom.start
        local_end = end - atom.start
        attrs = dict(atom.run.attrib)
        rpr = atom.run.find(W_RPR)
        middle = isolate(atom.run, atom.el, local_start, local_end)
        deletion = marks.wrap("w:del", new_run(attrs, rpr, atom.text[local_start:local_end], "w:delText"))
        middle.addprevious(deletion)
        middle.getparent().remove(middle)
        if last_deletion is None:
            last_deletion = deletion
        end = atom.start + local_start

    if edit.insert:
        last_deletion.addnext(marks.wrap("w:ins", new_run(insert_attrs, insert_rpr, edit.insert, "w:t")))


# ---------------------------------------------------------------- main


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: apply_corrections.py <spec.json> <out.docx>\n")
        return 2
    spec_path, out_path = sys.argv[1], sys.argv[2]
    try:
        spec = load_spec(spec_path)
    except SpecError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2
    work_dir = os.path.dirname(os.path.abspath(spec_path))

    try:
        document = Document(os.path.join(work_dir, spec["source"]))
    except Exception as exc:  # python-docx raises several types for unreadable files
        sys.stderr.write(f"Could not open the source as a Word document: {exc}\n")
        return 1

    paragraphs = reviewed_paragraphs(document)
    unreviewed = not_reviewed(document, paragraphs)
    corrections = spec["corrections"]
    edits, applied, problems = plan(paragraphs, corrections)
    if problems:
        sys.stderr.write("Nothing was saved, because these corrections cannot be applied exactly:\n")
        for problem in problems:
            sys.stderr.write(f"- {problem}\n")
        return 1

    marks = RevisionMarks(document, spec["author"], spec["date"]) if spec["tracked_changes"] else None
    # From the end of each paragraph back: an edit changes nothing before
    # its own start, so the offsets of the edits still to come stay valid.
    for edit in sorted(edits, key=lambda e: (e.paragraph, e.start), reverse=True):
        p = paragraphs[edit.paragraph].p
        if marks:
            apply_tracked(p, edit, marks)
        else:
            apply_direct(p, edit)

    document.save(out_path)
    report = {
        "corrections": applied,
        "edits": len(edits),
        "tracked_changes": spec["tracked_changes"],
        "not_reviewed": unreviewed,
    }
    with open(os.path.join(work_dir, spec["report"]), "w", encoding="utf-8") as f:
        json.dump(report, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
