#!/usr/bin/env python3
"""
Lists or fills the fields of a fillable (AcroForm) PDF, for packet-build's
Form I-589 (references/i589-guide.md "Step 3: Fill the PDF", which the
skill's desktop environment does with the pdf skill). Run by the skill
runner's list_pdf_form_fields and fill_pdf_form tools
(src/services/skill-runner/tools/packet-build.ts), sandboxed: no network,
inputs and outputs in the working directory only.

Usage:
    python3 pdf_form.py list form.pdf
    python3 pdf_form.py fill spec.json

Both print one JSON object on stdout. Errors that stop the script (an
unreadable or password-protected PDF, a PDF without form fields) go to
stderr with exit status 1.

list prints the form's number and edition as printed on its pages, and
every terminal field: its fully qualified name, type, page, tooltip (the
accessible description USCIS forms give each field), maximum length, flags,
check box / radio states, choice options and current value, in page order,
top to bottom.

fill reads spec.json:
    {"input": "form.pdf", "output": "filled.pdf",
     "fields": [{"name": "<qualified name>", "value": "<text or state>", "fit": false}]}
It validates every entry against the form before writing anything (unknown
names, read-only and signature fields, values longer than the field allows,
characters the form's fonts cannot show, states a box does not have) and
prints {"ok": false, "problems": [...]} without writing when any fails. On
success it writes the output with the values set, the form left fillable
(never flattened), NeedAppearances on so viewers draw the values, and the
form's XFA layer and usage-rights signature removed (both would otherwise
hide or invalidate the AcroForm values). "fit": true (used for values the
server supplies, never the model's) drops punctuation and spaces from a
value too long for its field, and skips the field with a warning if it
still does not fit.
"""

import json
import re
import sys
import unicodedata

try:
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import (
        ArrayObject,
        BooleanObject,
        DictionaryObject,
        IndirectObject,
        NameObject,
        TextStringObject,
    )
except ImportError:
    raise SystemExit("ERROR: pypdf is not installed on this worker (see requirements.txt)")

# Field flags (PDF 32000-1, tables 221, 226, 228, 230).
FF_READ_ONLY = 1
FF_REQUIRED = 1 << 1
FF_MULTILINE = 1 << 12
FF_RADIO = 1 << 15
FF_PUSHBUTTON = 1 << 16
FF_EDIT = 1 << 18
FF_COMB = 1 << 24

MAX_DEPTH = 32
MAX_PROBLEMS = 60
MAX_VALUE_LEN = 4000

# plan_text's answer for a server value that cannot be written: leave the field as it is.
SKIP = object()

# A field whose name or tooltip says it is a signature (but not the date
# next to one) is signed by hand: the app never types into it.
SIGNATURE_WORD = re.compile(r"signature", re.I)
DATE_WORD = re.compile(r"\bdate\b", re.I)
FORM_NUMBER = re.compile(r"\bForm\s+(I-\d{2,4}[A-Z]?)\b")
EDITION = re.compile(r"\bEdition\s+(\d{1,2}/\d{1,2}/\d{2,4})\b")


def fail(message):
    raise SystemExit("ERROR: " + message)


def resolve(obj):
    while isinstance(obj, IndirectObject):
        obj = obj.get_object()
    return obj


def as_text(obj):
    obj = resolve(obj)
    if obj is None:
        return ""
    text = str(obj)
    # Names come back as "/Yes"; the tools speak in bare state names.
    if isinstance(obj, NameObject) and text.startswith("/"):
        return text[1:]
    return text


def inherited(node, key):
    """A field attribute, from the field itself or the nearest ancestor that has it."""
    depth = 0
    while isinstance(node, DictionaryObject) and depth < MAX_DEPTH:
        if key in node:
            return resolve(node[key])
        node = resolve(node.get("/Parent"))
        depth += 1
    return None


def open_reader(path):
    try:
        reader = PdfReader(path)
    except Exception as exc:  # pypdf raises several error types on a damaged file
        fail("could not read the PDF: %s" % exc)
    if reader.is_encrypted:
        try:
            decrypted = reader.decrypt("")
        except Exception as exc:  # e.g. AES without the crypto dependency
            fail("the PDF is encrypted and could not be opened: %s" % exc)
        if not decrypted:
            fail("the PDF is password-protected; upload a copy that opens without a password")
    return reader


def acroform_of(root):
    acroform = resolve(root.get("/AcroForm"))
    if not isinstance(acroform, DictionaryObject) or not resolve(acroform.get("/Fields")):
        fail(
            "the PDF has no fillable (AcroForm) fields. It may be a scanned or flattened copy, "
            "or an XFA-only form; upload the official fillable PDF"
        )
    return acroform


def terminal_fields(acroform):
    """[(qualified name, field dict, [(widget dict, object number or None)])] for every terminal field."""
    found = []

    def visit(ref, parent_name, depth):
        node = resolve(ref)
        if not isinstance(node, DictionaryObject) or depth > MAX_DEPTH:
            return
        partial = node.get("/T")
        name = parent_name
        if partial is not None:
            part = as_text(partial)
            name = "%s.%s" % (parent_name, part) if parent_name else part
        field_kids, widget_kids = [], []
        for kid_ref in resolve(node.get("/Kids")) or []:
            kid = resolve(kid_ref)
            if not isinstance(kid, DictionaryObject):
                continue
            (field_kids if "/T" in kid else widget_kids).append(kid_ref)
        if field_kids:
            for kid_ref in field_kids:
                visit(kid_ref, name, depth + 1)
            return
        if not name:
            return
        if widget_kids:
            widgets = [(resolve(k), getattr(k, "idnum", None)) for k in widget_kids]
        else:
            widgets = [(node, getattr(ref, "idnum", None))]
        found.append((name, node, widgets))

    for ref in resolve(acroform.get("/Fields")) or []:
        visit(ref, "", 0)
    return found


def widget_pages(pages):
    """Object number of each annotation -> its 1-based page."""
    numbers = {}
    for index, page in enumerate(pages):
        for ref in resolve(page.get("/Annots")) or []:
            idnum = getattr(ref, "idnum", None)
            if idnum is not None:
                numbers[idnum] = index + 1
    return numbers


def field_type(node):
    ft = as_text(inherited(node, "/FT"))
    flags = int(inherited(node, "/Ff") or 0)
    if ft == "Tx":
        return "text"
    if ft == "Btn":
        if flags & FF_PUSHBUTTON:
            return "pushbutton"
        return "radio" if flags & FF_RADIO else "checkbox"
    if ft == "Ch":
        return "choice"
    if ft == "Sig":
        return "signature"
    return "unknown"


def on_states(widget):
    appearance = resolve(widget.get("/AP"))
    normal = resolve(appearance.get("/N")) if isinstance(appearance, DictionaryObject) else None
    if not isinstance(normal, DictionaryObject):
        return []
    return [as_text(NameObject(key)) for key in normal.keys() if key != "/Off"]


def choice_options(node):
    options = []
    for item in resolve(inherited(node, "/Opt")) or []:
        item = resolve(item)
        if isinstance(item, ArrayObject) and len(item) >= 2:
            options.append({"export": as_text(item[0]), "label": as_text(item[1])})
        else:
            options.append({"export": as_text(item), "label": as_text(item)})
    return options


def describe_field(name, node, widgets, pages):
    kind = field_type(node)
    flags = int(inherited(node, "/Ff") or 0)
    page = None
    rect = None
    for widget, idnum in widgets:
        if page is None and idnum is not None:
            page = pages.get(idnum)
        if rect is None and resolve(widget.get("/Rect")) is not None:
            try:
                rect = [round(float(resolve(v)), 1) for v in resolve(widget["/Rect"])][:4]
            except (TypeError, ValueError):
                rect = None
    tooltip = as_text(node.get("/TU")) or as_text(inherited(node, "/TU"))
    max_len = inherited(node, "/MaxLen")
    entry = {
        "name": name,
        "type": kind,
        "page": page,
        "tooltip": re.sub(r"\s+", " ", tooltip).strip(),
        "value": as_text(inherited(node, "/V")),
    }
    if kind == "text" and max_len is not None:
        entry["max_len"] = int(max_len)
    flag_names = [
        label
        for bit, label in (
            (FF_READ_ONLY, "read_only"),
            (FF_REQUIRED, "required"),
            (FF_MULTILINE, "multiline"),
            (FF_COMB, "comb"),
            (FF_EDIT, "editable"),
        )
        # The same bit means something else on another field type.
        if flags & bit
        and (bit not in (FF_MULTILINE, FF_COMB) or kind == "text")
        and (bit != FF_EDIT or kind == "choice")
    ]
    if flag_names:
        entry["flags"] = flag_names
    if kind in ("checkbox", "radio"):
        states = []
        for widget, _ in widgets:
            for state in on_states(widget):
                if state not in states:
                    states.append(state)
        entry["states"] = states
    if kind == "choice":
        entry["options"] = choice_options(node)
    if rect:
        entry["rect"] = rect
    return entry


def page_order(entry):
    rect = entry.get("rect") or [0, 0, 0, 0]
    top = max(rect[1], rect[3]) if len(rect) == 4 else 0
    return (entry["page"] or 10 ** 6, -top, rect[0] if rect else 0)


def form_identity(reader):
    """The form number and edition date printed on the pages ("Form I-589 Edition mm/dd/yy")."""
    identity = {"form": None, "edition": None}
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:  # text extraction is best effort
            continue
        if identity["form"] is None:
            match = FORM_NUMBER.search(text)
            if match:
                identity["form"] = match.group(1)
        if identity["edition"] is None:
            match = EDITION.search(text)
            if match:
                identity["edition"] = match.group(1)
        if identity["form"] and identity["edition"]:
            break
    return identity


def list_fields(pdf_path):
    reader = open_reader(pdf_path)
    acroform = acroform_of(reader.trailer["/Root"])
    pages = widget_pages(reader.pages)
    entries = [describe_field(name, node, widgets, pages) for name, node, widgets in terminal_fields(acroform)]
    entries.sort(key=page_order)
    result = {"page_count": len(reader.pages), "field_count": len(entries), "fields": entries}
    result.update(form_identity(reader))
    result["has_xfa"] = "/XFA" in acroform
    return result


def is_signature_field(name, tooltip):
    label = "%s %s" % (name, tooltip)
    return bool(SIGNATURE_WORD.search(label)) and not DATE_WORD.search(label)


def unsupported_characters(value):
    bad = []
    for ch in value:
        if ch in "\n\t":
            continue
        try:
            ch.encode("cp1252")
        except UnicodeEncodeError:
            if ch not in bad:
                bad.append(ch)
    return bad


def plan_text(name, node, entry, value, fit, problems, warnings):
    flags = int(inherited(node, "/Ff") or 0)
    if "\n" in value and not flags & FF_MULTILINE:
        value = re.sub(r"\s*\n\s*", " ", value)
        warnings.append("%s: single-line field; line breaks were replaced with spaces" % name)
    bad = unsupported_characters(value)
    if bad and fit:
        # A server value (the firm's name or address): drop accents rather than refuse the fill.
        value = "".join(c for c in unicodedata.normalize("NFKD", value) if not unicodedata.combining(c))
        if unsupported_characters(value):
            warnings.append("%s: left blank, the value has characters the form's fonts cannot show" % name)
            return SKIP
        warnings.append("%s: written without accents, which the form's fonts cannot show" % name)
        bad = []
    if bad:
        problems.append(
            "%s: characters the form's fonts cannot show (%s); use the spelling the record gives in Latin letters, "
            "or leave the field blank and flag it" % (name, ", ".join("U+%04X" % ord(c) for c in bad))
        )
        return None
    max_len = entry.get("max_len")
    if max_len is not None and len(value) > max_len:
        if fit:
            squeezed = re.sub(r"[^A-Za-z0-9]", "", value)
            if len(squeezed) <= max_len:
                warnings.append("%s: written without punctuation or spaces to fit %d characters" % (name, max_len))
                return squeezed
            warnings.append("%s: left blank, the value does not fit its %d characters" % (name, max_len))
            return SKIP
        problems.append(
            "%s: %d characters, but the field takes at most %d%s"
            % (name, len(value), max_len, " (one per box)" if "comb" in entry.get("flags", []) else "")
        )
        return None
    return value


def plan_entry(item, known, problems, warnings):
    name = item.get("name")
    value = item.get("value")
    fit = bool(item.get("fit"))
    if not isinstance(name, str) or not isinstance(value, str):
        problems.append("every field needs a string name and a string value")
        return None
    if len(value) > MAX_VALUE_LEN:
        problems.append("%s: value longer than %d characters" % (name, MAX_VALUE_LEN))
        return None
    if name not in known:
        problems.append("%s: no field with this name on the form (use the qualified names list_pdf_form_fields gives)" % name)
        return None
    targets = known[name]
    node, widgets, entry = targets[0]
    kind = entry["type"]
    if "read_only" in entry.get("flags", []):
        problems.append("%s: read-only field" % name)
        return None
    if kind in ("signature", "pushbutton", "unknown"):
        problems.append("%s: a %s field cannot be filled" % (name, kind))
        return None
    if value and is_signature_field(name, entry["tooltip"]):
        problems.append("%s: a signature is signed by hand on the printed form; leave it empty" % name)
        return None
    if kind == "text":
        planned = plan_text(name, node, entry, value, fit, problems, warnings)
        if planned is None:
            return None
        if planned is SKIP:
            return {"name": name, "kind": "skip", "targets": targets}
        return {"name": name, "kind": "text", "value": planned, "targets": targets}
    if kind == "choice":
        options = entry.get("options", [])
        if value and options:
            exports = [o["export"] for o in options]
            labels = {o["label"]: o["export"] for o in options}
            if value not in exports:
                if value in labels:
                    value = labels[value]
                elif fit and "editable" not in entry.get("flags", []):
                    warnings.append("%s: left blank, \"%s\" is not one of its options" % (name, value))
                    return {"name": name, "kind": "skip", "targets": targets}
                elif "editable" not in entry.get("flags", []):
                    problems.append("%s: \"%s\" is not one of the options (%s)" % (name, value, ", ".join(exports[:40])))
                    return None
        return {"name": name, "kind": "choice", "value": value, "targets": targets}
    # checkbox / radio
    state = value.strip()
    if state.startswith("/"):
        state = state[1:]
    if state in ("", "Off"):
        return {"name": name, "kind": "button", "value": None, "targets": targets}
    if state not in entry.get("states", []):
        problems.append(
            "%s: \"%s\" is not a state of this %s (states: %s, or Off)"
            % (name, value, kind, ", ".join(entry.get("states", [])) or "none")
        )
        return None
    return {"name": name, "kind": "button", "value": state, "targets": targets}


def apply(planned):
    for node, widgets, _ in planned["targets"]:
        if planned["kind"] in ("text", "choice"):
            node[NameObject("/V")] = TextStringObject(planned["value"])
            # Drop the blank form's stored appearance, so every viewer draws
            # the new value (NeedAppearances) instead of the empty box.
            for widget, _ in widgets:
                if "/AP" in widget:
                    del widget["/AP"]
        elif planned["kind"] == "button":
            state = planned["value"]
            node[NameObject("/V")] = NameObject("/" + state) if state else NameObject("/Off")
            for widget, _ in widgets:
                on = state is not None and state in on_states(widget)
                widget[NameObject("/AS")] = NameObject("/" + state) if on else NameObject("/Off")


def fill(spec_path):
    try:
        with open(spec_path, encoding="utf-8") as handle:
            spec = json.load(handle)
    except (OSError, ValueError) as exc:
        fail("could not read %s: %s" % (spec_path, exc))
    for key in ("input", "output"):
        if not isinstance(spec.get(key), str) or "/" in spec[key] or "\\" in spec[key]:
            fail("spec.%s must be a bare file name" % key)
    items = spec.get("fields")
    if not isinstance(items, list):
        fail("spec.fields must be a list")

    reader = open_reader(spec["input"])
    identity = form_identity(reader)
    writer = PdfWriter(clone_from=reader)
    root = getattr(writer, "root_object", None)
    if not isinstance(root, DictionaryObject):
        root = writer._root_object
    acroform = acroform_of(root)
    pages = widget_pages(writer.pages)

    known = {}
    for name, node, widgets in terminal_fields(acroform):
        entry = describe_field(name, node, widgets, pages)
        known.setdefault(name, []).append((node, widgets, entry))

    problems, warnings, plans, seen = [], [], [], set()
    for item in items:
        if not isinstance(item, dict):
            problems.append("every entry in fields must be an object with name and value")
            continue
        name = item.get("name")
        if name in seen:
            problems.append("%s: given more than once" % name)
            continue
        seen.add(name)
        planned = plan_entry(item, known, problems, warnings)
        if planned is not None:
            plans.append(planned)
    if problems:
        return {"ok": False, "problem_count": len(problems), "problems": problems[:MAX_PROBLEMS]}

    for planned in plans:
        if planned["kind"] != "skip":
            apply(planned)

    acroform[NameObject("/NeedAppearances")] = BooleanObject(True)
    if "/XFA" in acroform:
        del acroform["/XFA"]
    for key in ("/NeedsRendering", "/Perms"):
        if key in root:
            del root[key]

    with open(spec["output"], "wb") as handle:
        writer.write(handle)

    empty_by_page = {}
    for name, targets in known.items():
        node, _, entry = targets[0]
        if entry["type"] not in ("text", "choice", "checkbox", "radio"):
            continue
        if not as_text(inherited(node, "/V")) or as_text(inherited(node, "/V")) == "Off":
            key = str(entry["page"] or "unknown")
            empty_by_page[key] = empty_by_page.get(key, 0) + 1

    return {
        "ok": True,
        "page_count": len(writer.pages),
        "set": sum(1 for p in plans if p["kind"] != "skip" and p["value"]),
        "cleared": sum(1 for p in plans if p["kind"] != "skip" and not p["value"]),
        "skipped": [p["name"] for p in plans if p["kind"] == "skip"],
        "empty_or_unchecked_by_page": empty_by_page,
        "warnings": warnings,
        "form": identity["form"],
        "edition": identity["edition"],
    }


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("list", "fill"):
        fail("usage: pdf_form.py list <form.pdf> | pdf_form.py fill <spec.json>")
    command, path = sys.argv[1], sys.argv[2]
    result = list_fields(path) if command == "list" else fill(path)
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
