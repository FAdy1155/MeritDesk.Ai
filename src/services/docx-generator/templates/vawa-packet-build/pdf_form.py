#!/usr/bin/env python3
"""List and fill the AcroForm fields of a fillable PDF form.

vawa-packet-build SKILL.md Section 6 delivers, for each of Forms I-360, I-485
and I-765, "a question-by-question answer table and a filled copy of the
current official fillable PDF". This script is the PDF half, run by the app's
list_pdf_form_fields and fill_pdf_form tools
(src/services/skill-runner/tools/vawa-packet-build.ts):

    python3 pdf_form.py fields <form.pdf> <fields.json>
    python3 pdf_form.py fill <form.pdf> <values.json> <filled.pdf> <report.json>

It is written for this app, not copied from a firm script. It runs sandboxed
(src/services/sandbox/untrusted-exec.ts): no network, an unprivileged user,
and only the files named on its command line, all in its work directory.

Field names are fully qualified (each /T up the /Parent chain, joined with
"."), the same names `fill` takes. values.json is a list of
{"field", "value"} items, or {"field", "checked"} for a check box the app
sets from the firm identity. `fill` checks every value before writing
anything and writes no PDF when any value is refused: a name the form does
not have, a read-only, signature or push-button field, a check box or radio
state the field does not have, a choice outside its list, or text longer
than the field allows. An item marked "fit": true is a firm-identity value
the app supplied, which the model cannot change: where it does not fit its
field (too long even without punctuation, not one of a choice field's
options, a check box without exactly one on-state) the field is left as it
is with a warning instead of refusing the fill.

The filled copy keeps its fields editable, drops the form's XFA data and
usage-rights signature (otherwise viewers that prefer XFA
show the blank XFA form, and Reader rejects the modified rights), and sets
NeedAppearances so every viewer redraws any text whose appearance stream
could not be regenerated here.

Errors go to stderr as "ERROR: ..." with a non-zero exit; a refused fill is
not an error: report.json says ok false and lists every problem.
"""

import json
import re
import sys

try:
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import BooleanObject, NameObject, StreamObject, TextStringObject
except ImportError:
    raise SystemExit("ERROR: pypdf is not installed; the worker image needs pypdf[crypto] (requirements.txt)")

# Field flags (PDF 32000-1:2008, tables 221, 226, 228 and 230), as bit values.
FF_READ_ONLY = 1 << 0
FF_REQUIRED = 1 << 1
FF_MULTILINE = 1 << 12
FF_RADIO = 1 << 15
FF_PUSHBUTTON = 1 << 16
FF_COMBO = 1 << 17
FF_EDIT = 1 << 18
FF_COMB = 1 << 24

MAX_PARENT_DEPTH = 64

# A signature, or the date of a signature, is written when the person signs.
SIGNATURE_NAME = re.compile(r"signature", re.I)

# The footer USCIS prints on every page, e.g. "Form I-485 Edition 01/20/25".
EDITION = re.compile(r"Form\s+[A-Z]{1,2}-\d+[A-Z]?\s+Edition\s+\d{1,2}/\d{1,2}/\d{2,4}")


def fail(message):
    raise SystemExit("ERROR: " + message)


def resolved(value):
    return value.get_object() if value is not None else None


def ancestors(node):
    """The node and its /Parent chain, nearest first (cycle-safe)."""
    seen = set()
    depth = 0
    while node is not None and depth < MAX_PARENT_DEPTH and id(node) not in seen:
        seen.add(id(node))
        yield node
        node = resolved(node.get("/Parent"))
        depth += 1


def inherited(node, key):
    """An inheritable field attribute (/FT, /Ff, /V, /MaxLen, /Opt, /DA)."""
    for current in ancestors(node):
        if key in current:
            return resolved(current.get(key))
    return None


def qualified_name(field):
    parts = []
    for current in ancestors(field):
        partial = resolved(current.get("/T"))
        if partial is not None:
            parts.append(str(partial))
    return ".".join(reversed(parts))


def terminal_field(widget):
    """The field a widget annotation belongs to: itself when merged, else its parent."""
    if "/T" in widget:
        return widget
    return resolved(widget.get("/Parent"))


def widget_states(widget):
    """A button widget's appearance state names, without the leading slash."""
    appearances = resolved(widget.get("/AP"))
    if appearances is None:
        return []
    normal = resolved(appearances.get("/N"))
    if normal is None or isinstance(normal, StreamObject) or not hasattr(normal, "keys"):
        return []
    return [str(key)[1:] for key in normal.keys()]


def collect_fields(pages):
    """Every field with a widget on a page, in page order, with its widgets and pages."""
    by_name = {}
    order = []
    for index, page in enumerate(pages):
        annotations = resolved(page.get("/Annots"))
        if annotations is None:
            continue
        for reference in annotations:
            widget = resolved(reference)
            if widget is None or not hasattr(widget, "get") or widget.get("/Subtype") != "/Widget":
                continue
            field = terminal_field(widget)
            if field is None:
                continue
            name = qualified_name(field)
            if not name:
                continue
            entry = by_name.get(name)
            if entry is None:
                entry = {"name": name, "field": field, "widgets": [], "pages": []}
                by_name[name] = entry
                order.append(name)
            entry["widgets"].append(widget)
            if index + 1 not in entry["pages"]:
                entry["pages"].append(index + 1)
    return [by_name[name] for name in order]


def text_of(value):
    if value is None:
        return ""
    text = str(value)
    return text[1:] if text.startswith("/") else text


def choice_options(field):
    options = []
    for option in resolved(inherited(field, "/Opt")) or []:
        option = resolved(option)
        if isinstance(option, list) and len(option) >= 2:
            options.append({"export": text_of(resolved(option[0])), "display": text_of(resolved(option[1]))})
        else:
            options.append({"export": text_of(option), "display": text_of(option)})
    return options


def describe(entry):
    field = entry["field"]
    field_type = str(inherited(field, "/FT") or "")
    flags = int(inherited(field, "/Ff") or 0)
    if field_type == "/Tx":
        kind = "text"
    elif field_type == "/Btn":
        if flags & FF_PUSHBUTTON:
            kind = "pushbutton"
        elif flags & FF_RADIO:
            kind = "radio"
        else:
            kind = "checkbox"
    elif field_type == "/Ch":
        kind = "choice"
    elif field_type == "/Sig":
        kind = "signature"
    else:
        kind = "unknown"

    tooltip = None
    for current in ancestors(field):
        if "/TU" in current:
            tooltip = str(resolved(current.get("/TU")))
            break

    max_length = inherited(field, "/MaxLen")
    states = []
    if kind in ("checkbox", "radio"):
        for widget in entry["widgets"]:
            for state in widget_states(widget):
                if state != "Off" and state not in states:
                    states.append(state)

    partial = str(resolved(field.get("/T")) or "")
    return {
        "name": entry["name"],
        "type": kind,
        "pages": entry["pages"],
        "tooltip": tooltip,
        "max_length": int(max_length) if max_length is not None else None,
        "states": states,
        "options": choice_options(field) if kind == "choice" else [],
        "editable_choice": kind == "choice" and bool(flags & FF_COMBO) and bool(flags & FF_EDIT),
        "multiline": kind == "text" and bool(flags & FF_MULTILINE),
        "comb": kind == "text" and bool(flags & FF_COMB),
        "read_only": bool(flags & FF_READ_ONLY),
        "required": bool(flags & FF_REQUIRED),
        "signature_field": kind == "signature" or bool(SIGNATURE_NAME.search(partial)),
        "value": text_of(inherited(field, "/V")),
    }


def open_form(path):
    try:
        reader = PdfReader(path, strict=False)
    except Exception as exc:
        fail("could not read the PDF: %s" % exc)
    encrypted = bool(reader.is_encrypted)
    if encrypted:
        # Forms are commonly encrypted with an empty open password and an
        # owner password that only restricts editing; filling is permitted.
        try:
            result = reader.decrypt("")
        except Exception as exc:
            hint = ""
            if type(exc).__name__ == "DependencyError" or "cryptography" in str(exc):
                hint = " (an AES-encrypted form needs the cryptography package: pypdf[crypto] on the worker image)"
            fail("the PDF is encrypted and could not be decrypted: %s%s" % (exc, hint))
        if not result:
            fail("the PDF needs a password to open; upload an unprotected copy of the blank form")
    return reader, encrypted


def acroform_of(root):
    return resolved(root.get("/AcroForm")) if root is not None else None


def edition_text(reader):
    count = len(reader.pages)
    for index in sorted({0, count - 1}):
        if index < 0:
            continue
        try:
            text = reader.pages[index].extract_text() or ""
        except Exception:
            continue
        match = EDITION.search(" ".join(text.split()))
        if match:
            return match.group(0)
    return None


def cmd_fields(form_path, out_path):
    reader, encrypted = open_form(form_path)
    acroform = acroform_of(resolved(reader.trailer.get("/Root")))
    listing = {
        "pages": len(reader.pages),
        "encrypted": encrypted,
        "acroform": acroform is not None,
        "xfa": acroform is not None and "/XFA" in acroform,
        "edition_text": edition_text(reader),
        "fields": [describe(entry) for entry in collect_fields(reader.pages)],
    }
    with open(out_path, "w", encoding="utf-8") as out:
        json.dump(listing, out, ensure_ascii=True)


def plan_values(values, entries):
    """Checks every requested value; returns (planned changes, problems, warnings)."""
    by_name = {entry["name"]: entry for entry in entries}
    planned = []
    problems = []
    warnings = []
    seen = set()
    for index, item in enumerate(values):
        if not isinstance(item, dict) or not isinstance(item.get("field"), str):
            problems.append("values[%d]: each value needs a field name" % index)
            continue
        name = item["field"]
        value = item.get("value")
        checked = item.get("checked")
        fit = item.get("fit") is True
        # Exactly one of a string value and a true/false checked.
        if isinstance(value, str) == isinstance(checked, bool):
            problems.append("%s: give a string value" % name)
            continue
        if name in seen:
            problems.append("%s: given more than once" % name)
            continue
        seen.add(name)
        entry = by_name.get(name)
        if entry is None:
            problems.append("%s: this form has no field by that name; use a name list_pdf_form_fields returned" % name)
            continue
        info = describe(entry)
        kind = info["type"]
        if info["signature_field"]:
            problems.append("%s: a signature or signature-date field; it is completed when the person signs" % name)
            continue
        if info["read_only"]:
            problems.append("%s: read-only field" % name)
            continue
        if kind in ("pushbutton", "unknown"):
            problems.append("%s: a %s field cannot be filled" % (name, kind))
            continue
        if checked is not None:
            # Only the app sends checked (a firm-identity check box).
            if kind != "checkbox":
                problems.append("%s: a %s field, not a check box; name a check box for this firm value" % (name, kind))
                continue
            if not checked:
                planned.append(("button", entry, "Off"))
                continue
            if len(info["states"]) != 1:
                message = "%s: this check box has %d on-states (%s)" % (
                    name,
                    len(info["states"]),
                    ", ".join(info["states"]) or "none",
                )
                if fit:
                    warnings.append(
                        message + "; it was left as it is: to set it, refill with it in values by its state, not in firm_values"
                    )
                else:
                    problems.append(message + "; give one of them as its value")
                continue
            planned.append(("button", entry, info["states"][0]))
            continue
        if kind == "text":
            if "\n" in value and not info["multiline"]:
                if not fit:
                    problems.append("%s: a single-line field; remove the line break" % name)
                    continue
                value = " ".join(value.split())
            max_length = info["max_length"]
            if max_length is not None and len(value) > max_length:
                if not fit:
                    problems.append("%s: %d characters, but the field holds at most %d" % (name, len(value), max_length))
                    continue
                squeezed = re.sub(r"[^A-Za-z0-9]", "", value)
                if len(squeezed) > max_length:
                    warnings.append(
                        "%s: left blank, the firm identity's value does not fit its %d characters" % (name, max_length)
                    )
                    continue
                warnings.append(
                    "%s: the firm identity's value was written without punctuation or spaces to fit its %d characters"
                    % (name, max_length)
                )
                value = squeezed
            planned.append(("text", entry, value))
        elif kind in ("checkbox", "radio"):
            if fit:
                problems.append("%s: a %s field; name a text or choice field for this firm value" % (name, kind))
                continue
            state = value[1:] if value.startswith("/") else value
            if state != "Off" and state not in info["states"]:
                problems.append(
                    "%s: \"%s\" is not one of its states (%s, or Off)" % (name, value, ", ".join(info["states"]) or "none")
                )
                continue
            planned.append(("button", entry, state))
        elif kind == "choice":
            export = None
            for option in info["options"]:
                if value in (option["export"], option["display"]):
                    export = option["export"]
                    break
            if export is None:
                if not info["editable_choice"]:
                    labels = ", ".join(option["display"] for option in info["options"])
                    message = "%s: \"%s\" is not one of its options (%s)" % (name, value, labels or "none")
                    if fit:
                        warnings.append(message + "; left blank")
                    else:
                        problems.append(message)
                    continue
                export = value
            planned.append(("choice", entry, export))
    return planned, problems, warnings


def apply_values(writer, planned):
    """Writes the values; returns warnings about appearance streams."""
    text_by_page = {}
    for kind, entry, value in planned:
        field = entry["field"]
        if kind == "button":
            state = NameObject("/" + value)
            field[NameObject("/V")] = state
            for widget in entry["widgets"]:
                on = value != "Off" and value in widget_states(widget)
                widget[NameObject("/AS")] = state if on else NameObject("/Off")
        else:
            field[NameObject("/V")] = TextStringObject(value)
            for page in entry["pages"]:
                text_by_page.setdefault(page, {})[entry["name"]] = value

    # pypdf draws appearance streams for text and choice values, so viewers
    # that do not honor NeedAppearances still show them. A page where it
    # cannot (a font the form does not carry, an unusual field) keeps the
    # value set above, and NeedAppearances makes viewers draw it.
    warnings = []
    for page_number in sorted(text_by_page):
        try:
            writer.update_page_form_field_values(
                writer.pages[page_number - 1], text_by_page[page_number], auto_regenerate=False
            )
        except Exception as exc:
            warnings.append(
                "page %d: text appearances were not regenerated (%s); viewers draw the values from NeedAppearances"
                % (page_number, exc)
            )
    return warnings


def cmd_fill(form_path, values_path, out_path, report_path):
    with open(values_path, encoding="utf-8") as source:
        values = json.load(source)
    if not isinstance(values, list):
        fail("values.json must be a list of {field, value} objects")

    reader, _ = open_form(form_path)
    writer = PdfWriter(clone_from=reader)
    entries = collect_fields(writer.pages)
    if not entries:
        fail("the PDF has no fillable AcroForm fields (an XFA-only or flattened form cannot be filled here)")

    planned, problems, warnings = plan_values(values, entries)
    if problems:
        with open(report_path, "w", encoding="utf-8") as out:
            json.dump({"ok": False, "problems": problems}, out, ensure_ascii=True)
        return

    warnings = warnings + apply_values(writer, planned)

    root = getattr(writer, "root_object", None)
    if root is None:
        root = writer._root_object
    acroform = acroform_of(root)
    if acroform is not None:
        if "/XFA" in acroform:
            del acroform["/XFA"]
        # After update_page_form_field_values, which may have cleared it.
        acroform[NameObject("/NeedAppearances")] = BooleanObject(True)
    if "/Perms" in root:
        del root["/Perms"]

    with open(out_path, "wb") as out:
        writer.write(out)

    filled_names = {entry["name"] for _, entry, _ in planned}
    left_blank = [
        info["name"]
        for info in (describe(entry) for entry in entries)
        if info["name"] not in filled_names
        and info["type"] in ("text", "choice")
        and not info["value"]
        and not info["read_only"]
        and not info["signature_field"]
    ]
    with open(report_path, "w", encoding="utf-8") as out:
        json.dump(
            {
                "ok": True,
                "filled": len(planned),
                "pages": len(writer.pages),
                "fields_total": len(entries),
                "text_fields_left_blank": len(left_blank),
                "warnings": warnings,
            },
            out,
            ensure_ascii=True,
        )


def main(argv):
    if len(argv) == 4 and argv[1] == "fields":
        cmd_fields(argv[2], argv[3])
    elif len(argv) == 6 and argv[1] == "fill":
        cmd_fill(argv[2], argv[3], argv[4], argv[5])
    else:
        fail(
            "usage: pdf_form.py fields <form.pdf> <fields.json> | "
            "pdf_form.py fill <form.pdf> <values.json> <filled.pdf> <report.json>"
        )


if __name__ == "__main__":
    main(sys.argv)
