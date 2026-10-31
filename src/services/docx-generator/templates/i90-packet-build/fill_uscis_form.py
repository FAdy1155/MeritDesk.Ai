#!/usr/bin/env python3
"""Inspect or fill a fillable USCIS form PDF (its AcroForm fields).

Written for the app's i90-packet-build skill: the fill_uscis_form_pdf tool
(src/services/skill-runner/tools/i90-packet-build.ts) fills the official Form
I-90 and Form G-28 with it, from the skill's answer table. It is not a firm
script and prints nothing of its own on a form: the firm's and the
representative's details reach it only as field values the server already
filled in from the firm identity.

    python3 fill_uscis_form.py inspect <form.pdf>
    python3 fill_uscis_form.py fill <form.pdf> <spec.json> <out.pdf>

Both print one JSON object on stdout and exit 0. {"ok": false, "errors": [...]}
means nothing was written. spec.json:

    {"fields": [{"name": "<full field name>", "value": "text"},
                {"name": "...", "checked": true},
                {"name": "...", "state": "<on state>"}]}

USCIS publishes its forms as hybrid XFA / AcroForm PDFs. The script fills the
AcroForm fields, drops the XFA stream (or XFA-aware viewers would keep showing
the empty XFA form) and the usage-rights signature (any change invalidates
it), and sets NeedAppearances so viewers draw the filled values. Signature
fields are never filled: a form is signed by the person whose signature it is.

Runs sandboxed (no network, no secrets); reads and writes only its work
directory.
"""

import json
import re
import sys


def done(payload):
    print(json.dumps(payload, separators=(",", ":")))
    sys.exit(0)


def fail(*errors):
    done({"ok": False, "errors": list(errors)})


try:
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import BooleanObject, DictionaryObject, NameObject, StreamObject, TextStringObject
except ImportError:
    fail("pypdf is not installed on this worker (see requirements.txt).")

FF_READ_ONLY = 1
FF_MULTILINE = 1 << 12
FF_RADIO = 1 << 15
FF_PUSHBUTTON = 1 << 16
FF_EDIT = 1 << 18
MAX_DEPTH = 40
MAX_ERRORS = 100
PRINTABLE = re.compile(r"^[\x20-\x7e\n]*$")
SIGNATURE = re.compile(r"signature", re.IGNORECASE)
# Loose on purpose: field names run words together ("DateofSignature").
DATE = re.compile(r"date", re.IGNORECASE)
EDITION = re.compile(r"Form\s+([A-Z]{1,2}-\d+[A-Z]?)\s+Edition\s+(\d{2}/\d{2}/\d{2,4})", re.IGNORECASE)
FORM_NUMBER = re.compile(r"\bForm\s+([A-Z]{1,2}-\d+[A-Z]?)\b")


def resolve(obj):
    return obj.get_object() if hasattr(obj, "get_object") else obj


def pdf_name(value):
    text = str(value)
    return text[1:] if text.startswith("/") else text


def open_reader(path):
    try:
        reader = PdfReader(path)
        if reader.is_encrypted and not reader.decrypt(""):
            fail("The PDF is protected with a password, so it cannot be read here.")
        len(reader.pages)
    except Exception as exc:  # malformed file, missing AES backend
        fail(f"The PDF could not be read: {exc}")
    return reader


def inherited(node, key):
    """A field attribute, from the node or the nearest ancestor that has it."""
    current = node
    for _ in range(MAX_DEPTH):
        if current is None:
            return None
        if key in current:
            return resolve(current[key])
        parent = current.get("/Parent")
        current = resolve(parent) if parent is not None else None
    return None


def flags(node):
    value = inherited(node, "/Ff")
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def collect_fields(root):
    """Every terminal field under /AcroForm /Fields: its full name, node and widget references."""
    acro = root.get("/AcroForm")
    if acro is None:
        return None, []
    acro = resolve(acro)
    fields = []

    def walk(refs, prefix, depth):
        if depth > MAX_DEPTH:
            return
        for ref in resolve(refs):
            node = resolve(ref)
            partial = node.get("/T")
            if partial is None:
                name = prefix
            else:
                name = f"{prefix}.{partial}" if prefix else str(partial)
            kids = node.get("/Kids")
            kid_nodes = [resolve(kid) for kid in resolve(kids)] if kids is not None else []
            if any("/T" in kid for kid in kid_nodes):
                walk(kids, name, depth + 1)
            else:
                # The node's kids are its widgets, or the node is its own widget.
                widgets = list(resolve(kids)) if kids is not None else [ref]
                fields.append({"name": name, "node": node, "widgets": widgets})

    walk(acro.get("/Fields", []), "", 0)
    return acro, fields


def page_numbers(pages):
    """Object number of each annotation -> the 1-based page it sits on."""
    numbers = {}
    for index, page in enumerate(pages, start=1):
        annots = page.get("/Annots")
        if annots is None:
            continue
        for annot in resolve(annots):
            idnum = getattr(annot, "idnum", None)
            if idnum is not None and idnum not in numbers:
                numbers[idnum] = index
    return numbers


def field_kind(node):
    field_type = inherited(node, "/FT")
    ff = flags(node)
    if field_type == "/Tx":
        return "text"
    if field_type == "/Ch":
        return "choice"
    if field_type == "/Sig":
        return "signature"
    if field_type == "/Btn":
        if ff & FF_PUSHBUTTON:
            return "pushbutton"
        return "radio" if ff & FF_RADIO else "checkbox"
    return "unknown"


def tooltip_of(field):
    tooltip = field["node"].get("/TU")
    if tooltip is None and field["widgets"]:
        tooltip = resolve(field["widgets"][0]).get("/TU")
    return " ".join(str(tooltip).split()) if tooltip is not None else ""


def partial_name(field):
    """The field's own name: the last part of its full name, without its parents'."""
    return field["name"].rsplit(".", 1)[-1]


def signature_like(field):
    """A signature field, or a text field for one (but not the signature date).

    Text fields are tested by their own partial name only ("SignatureofApplicant",
    "P6_Line6a_Signature"), never by the tooltip: every USCIS tooltip starts with
    its part's title, and "Part 5. Applicant's Statement, Contact Information,
    Certification, and Signature." heads the phone, email and preparer fields of
    that part too. A checkbox is never one, whatever its name or tooltip says.
    """
    kind = field_kind(field["node"])
    if kind == "signature":
        return True
    if kind != "text":
        return False
    name = partial_name(field)
    return bool(SIGNATURE.search(name)) and not DATE.search(name)


def widget_states(widget):
    appearance = widget.get("/AP")
    if appearance is None:
        return []
    normal = resolve(appearance).get("/N")
    if normal is None:
        return []
    normal = resolve(normal)
    if isinstance(normal, StreamObject) or not isinstance(normal, DictionaryObject):
        return []  # a single appearance stream (a text field), not a dictionary of states
    return [pdf_name(key) for key in normal.keys() if pdf_name(key) != "Off"]


def on_states(widgets):
    states = []
    for ref in widgets:
        for state in widget_states(resolve(ref)):
            if state not in states:
                states.append(state)
    return states


def choice_options(node):
    """(export value, display text) for each option of a choice field."""
    options = inherited(node, "/Opt")
    result = []
    if options is None:
        return result
    for item in resolve(options):
        item = resolve(item)
        if isinstance(item, list) and len(item) >= 2:
            result.append((str(resolve(item[0])), str(resolve(item[1]))))
        else:
            result.append((str(item), str(item)))
    return result


def current_value(node):
    value = inherited(node, "/V")
    if value is None:
        return ""
    value = resolve(value)
    if isinstance(value, list):
        return ", ".join(pdf_name(v) for v in value)
    return pdf_name(value)


def field_page(field, numbers):
    for ref in field["widgets"]:
        idnum = getattr(ref, "idnum", None)
        if idnum in numbers:
            return numbers[idnum]
    return None


def describe(field, numbers):
    node = field["node"]
    kind = field_kind(node)
    ff = flags(node)
    entry = {"name": field["name"], "type": kind}
    page = field_page(field, numbers)
    if page:
        entry["page"] = page
    tooltip = tooltip_of(field)
    if tooltip:
        entry["tooltip"] = tooltip[:300]
    if ff & FF_READ_ONLY:
        entry["read_only"] = True
    if kind == "text":
        max_len = inherited(node, "/MaxLen")
        if max_len is not None:
            entry["max_length"] = int(max_len)
        if ff & FF_MULTILINE:
            entry["multiline"] = True
    elif kind in ("checkbox", "radio"):
        entry["states"] = on_states(field["widgets"])
    elif kind == "choice":
        entry["options"] = [
            export if export == display else f"{export} ({display})" for export, display in choice_options(node)
        ]
        if ff & FF_EDIT:
            entry["editable"] = True
    if signature_like(field):
        entry["signature"] = True
    value = current_value(node)
    if value and value != "Off":
        entry["value"] = value[:200]
    return entry


def page_text(reader, index):
    try:
        return reader.pages[index].extract_text() or ""
    except Exception:
        return ""


def inspect(pdf_path):
    reader = open_reader(pdf_path)
    root = resolve(reader.trailer["/Root"])
    acro, fields = collect_fields(root)
    numbers = page_numbers(reader.pages)
    entries = [describe(field, numbers) for field in fields]
    fillable = [entry for entry in entries if entry["type"] != "pushbutton"]
    warnings = []
    first = page_text(reader, 0)
    last = page_text(reader, len(reader.pages) - 1) if len(reader.pages) > 1 else ""
    editions = sorted({f"Form {form} Edition {date}" for form, date in EDITION.findall(f"{first}\n{last}")})
    if not first.strip():
        warnings.append("No text could be read from page 1, so the edition and form number were not checked here.")
    if not fillable:
        warnings.append(
            "The PDF has no fillable AcroForm fields (a dynamic XFA-only form, or a flat scan); it cannot be filled here."
        )
    done(
        {
            "ok": True,
            "encrypted": bool(reader.is_encrypted),
            "has_xfa": acro is not None and "/XFA" in acro,
            "page_count": len(reader.pages),
            "edition_text": editions,
            "form_numbers": sorted(set(FORM_NUMBER.findall(first))),
            "field_count": len(fillable),
            "pushbuttons_skipped": len(entries) - len(fillable),
            "fields": fillable,
            "warnings": warnings,
        }
    )


def match_option(value, options):
    for export, display in options:
        if value in (export, display):
            return export
    folded = value.casefold()
    for export, display in options:
        if folded in (export.casefold(), display.casefold()):
            return export
    return None


def plan(field, request):
    """(problem, None) when the entry cannot be applied, else (None, action)."""
    node, widgets = field["node"], field["widgets"]
    kind = field_kind(node)
    ff = flags(node)
    given = [key for key in ("value", "checked", "state") if request.get(key) is not None]
    if len(given) != 1:
        return "give exactly one of value, checked or state.", None
    if kind in ("pushbutton", "unknown"):
        return f"a {kind} field cannot be filled.", None
    if signature_like(field):
        return "a signature field: it is left blank for the signer's own signature.", None
    if ff & FF_READ_ONLY:
        return "the field is read-only.", None

    value, checked, state = request.get("value"), request.get("checked"), request.get("state")
    if kind in ("text", "choice"):
        if not isinstance(value, str):
            return f"a {kind} field takes value.", None
        if not PRINTABLE.match(value):
            return "plain ASCII only: no accented letters, curly quotes, long dashes or control characters.", None
        if "\n" in value and not ff & FF_MULTILINE:
            return "a single-line field: no line breaks.", None
        if kind == "text":
            max_len = inherited(node, "/MaxLen")
            if max_len is not None and len(value) > int(max_len):
                return (
                    f"{len(value)} characters, but the field holds at most {int(max_len)}; "
                    "shorten it, or continue it in Part 8 (Additional Information).",
                    None,
                )
            return None, ("text", field, value)
        options = choice_options(node)
        export = match_option(value, options)
        if export is None:
            if not ff & FF_EDIT:
                listed = ", ".join(e if e == d else f"{e} ({d})" for e, d in options[:60])
                return f'"{value}" is not one of its options: {listed}.', None
            export = value
        return None, ("text", field, export)

    states = on_states(widgets)
    if checked is not None:
        if kind != "checkbox" or not isinstance(checked, bool):
            return "checked is for checkboxes only (true or false); a radio group takes state.", None
        if checked and len(states) != 1:
            return f"this checkbox has {len(states)} on-states ({', '.join(states) or 'none'}); give state instead.", None
        return None, ("button", field, states[0] if checked else "Off")
    if not isinstance(state, str):
        return "a checkbox or radio group takes checked or state, not value.", None
    if state != "Off" and state not in states:
        return f"state must be one of {', '.join(states) or '(none)'} or Off.", None
    return None, ("button", field, state)


def apply(action):
    kind, field, value = action
    node = field["node"]
    if kind == "text":
        node[NameObject("/V")] = TextStringObject(value)
        for ref in field["widgets"]:
            widget = resolve(ref)
            # The blank form's appearance would hide the new value in viewers
            # that do not redraw; without it every viewer draws the value.
            if "/AP" in widget:
                del widget["/AP"]
        return
    node[NameObject("/V")] = NameObject(f"/{value}")
    for ref in field["widgets"]:
        widget = resolve(ref)
        widget[NameObject("/AS")] = NameObject(f"/{value}" if value in widget_states(widget) else "/Off")


def writer_root(writer):
    root = getattr(writer, "root_object", None)
    return resolve(root if root is not None else writer._root_object)


def fill(pdf_path, spec_path, out_path):
    try:
        with open(spec_path, encoding="utf-8") as handle:
            spec = json.load(handle)
    except Exception as exc:
        fail(f"spec.json could not be read: {exc}")
    requests = spec.get("fields") if isinstance(spec, dict) else None
    if not isinstance(requests, list) or not requests:
        fail("spec.json lists no fields to fill.")

    reader = open_reader(pdf_path)
    try:
        writer = PdfWriter(clone_from=reader)
    except Exception as exc:
        fail(f"The PDF could not be copied for filling: {exc}")
    root = writer_root(writer)
    acro, fields = collect_fields(root)
    if acro is None or not fields:
        fail("The PDF has no fillable AcroForm fields (a dynamic XFA-only form, or a flat scan); it cannot be filled here.")
    by_name = {}
    for field in fields:
        by_name.setdefault(field["name"], []).append(field)

    errors, planned, seen = [], [], set()
    for position, request in enumerate(requests, start=1):
        if not isinstance(request, dict) or not isinstance(request.get("name"), str):
            errors.append(f"Entry {position}: no field name.")
            continue
        name = request["name"]
        if name in seen:
            errors.append(f"{name}: listed more than once.")
            continue
        seen.add(name)
        matches = by_name.get(name)
        if not matches:
            errors.append(f"{name}: no field with this name on the form (use the full names action inspect lists).")
            continue
        for field in matches:
            problem, action = plan(field, request)
            if problem:
                errors.append(f"{name}: {problem}")
                break
            planned.append(action)
    if errors:
        more = len(errors) - MAX_ERRORS
        fail(*errors[:MAX_ERRORS], *([f"... and {more} more."] if more > 0 else []))

    for action in planned:
        apply(action)

    removed = []
    if "/XFA" in acro:
        del acro["/XFA"]
        removed.append("the XFA form data, so viewers show the filled AcroForm fields")
    acro[NameObject("/NeedAppearances")] = BooleanObject(True)
    if "/Perms" in root:
        del root["/Perms"]
        removed.append("the usage-rights signature, which any change to the form invalidates")
    if "/NeedsRendering" in root:
        del root["/NeedsRendering"]

    filled = {action[1]["name"] for action in planned}
    blank_text, unset_buttons, signature_fields = [], 0, []
    for field in fields:
        kind = field_kind(field["node"])
        if signature_like(field):
            signature_fields.append(field["name"])
            continue
        if kind in ("pushbutton", "unknown") or flags(field["node"]) & FF_READ_ONLY or field["name"] in filled:
            continue
        if current_value(field["node"]) in ("", "Off"):
            if kind in ("text", "choice"):
                blank_text.append(field["name"])
            else:
                unset_buttons += 1

    try:
        with open(out_path, "wb") as handle:
            writer.write(handle)
    except Exception as exc:
        fail(f"The filled PDF could not be written: {exc}")

    done(
        {
            "ok": True,
            "filled": len(planned),
            "page_count": len(writer.pages),
            "blank_text_fields": blank_text[:300],
            "blank_text_field_count": len(blank_text),
            "unset_checkboxes_and_radios": unset_buttons,
            "signature_fields_left_blank": signature_fields[:50],
            "removed": removed,
        }
    )


def main(argv):
    if len(argv) == 3 and argv[1] == "inspect":
        inspect(argv[2])
    elif len(argv) == 5 and argv[1] == "fill":
        fill(argv[2], argv[3], argv[4])
    print(__doc__, file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main(sys.argv)
