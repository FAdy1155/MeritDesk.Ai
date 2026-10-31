import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createGeneratedDocument } from "@/lib/documents/service";
import { detectFileKind } from "@/lib/documents/file-kind";
import {
  type FirmIdentitySnapshot,
  type FirmIdentitySnapshotAttorney,
} from "@/lib/firm-identity/schema";
import { getObjectBytes } from "@/lib/s3";
import { execUntrusted, readToolOutput, TOOL_OUTPUT_LIMITS } from "@/services/sandbox/untrusted-exec";
import { cleanupWorkDir, DOCX_TEMPLATES_DIR, rasterizePdfPages } from "@/services/docx-generator/generate";
import { toJsonSchemaObject } from "../json-schema";
import { createQaGateSkillTool } from "./companion-skills";
import { firmDetailIn, nationalPhoneDigits, parseFirmAddress, splitPersonName } from "./shared/firm-values";
import { chargeRequestBytes } from "./shared/request-bytes";
import { resolveSigner } from "./shared/signer";
import {
  COMBINING_MARKS,
  describeFormToolError,
  downloadBlankForm,
  findMatterDocument,
  removeAllButPageImages,
  safePdfFileName,
  sha256,
} from "./shared/uscis-forms";
// Types only: tools.ts imports this module for its registry.
import type { SkillTool, ToolExecutionContext } from "../tools";

/**
 * vawa-packet-build's tools beyond the shared ones.
 *
 * list_pdf_form_fields and fill_pdf_form (tool keys list_pdf_form_fields_vawa
 * and fill_pdf_form_vawa; packet-build and i90-packet-build have their own
 * form fillers with other input contracts under other keys) are
 * SKILL.md Section 6, "an answer table and a filled PDF" for each of Forms
 * I-360, I-485 and I-765: "Use the pdf skill to fill the form." They run
 * src/services/docx-generator/templates/vawa-packet-build/pdf_form.py
 * (pypdf) sandboxed. The blank form is either of Section 6.1's two sources:
 * the blank the attorney uploaded to the matter (malware-clean, read at its
 * scanned version), or, when none is named, the current PDF from the form's
 * uscis.gov page. That PDF is found here, as i90-packet-build's
 * fill_uscis_form_pdf finds its forms (downloadBlankForm in
 * ./shared/uscis-forms.ts): the tool fetches the form's page
 * (https://www.uscis.gov/i-360, /i-485 or /i-765, or another uscis.gov page
 * the model names), takes the link to the form's own PDF from its HTML and
 * downloads that, https only and redirect-checked within uscis.gov; both
 * requests go to the run's verification log with their hashes. ClamAV scans
 * the download before any parser reads it: only a scan that ran and found
 * nothing lets it be used, and otherwise the model is told to ask for an
 * upload (fail closed). Listing and filling read the same download (a
 * per-run cache). The fill logic is not VAWA-specific, but the descriptions
 * the model sees are written for this skill's Section 6.
 *
 * What the model cannot control (docs/ADDING_A_SKILL.md 2.8): the firm's and
 * the preparer's details. Section 6.2 wants the preparer part completed and
 * the G-28 box checked with the attorney bar number, and a VAWA safe mailing
 * address is often in care of the firm. The model names the field for each
 * such detail in firm_values, and the app fills it from ctx.firmIdentity, the
 * run's snapshot, for the default signer or the roster entry
 * preparer_attorney_id names; a typed value carrying the firm's or a roster
 * member's name, bar number, EOIR ID, email or phone is refused. No
 * signature is ever put on a form: the script refuses signature fields.
 *
 * load_qa_gate_skill_vawa_packet_review and load_qa_gate_skill_orthography_check
 * are Section 4 Step 10, "Run the vawa-packet-review skill over the assembled
 * packet ... Then run orthography-check over the cover letter and
 * declaration": createQaGateSkillTool (tools/companion-skills.ts)
 * returns each skill's seeded instructions so the model runs the gate in
 * this run and puts its reports in the build's own report.
 */

const SCRIPT_PATH = path.join(DOCX_TEMPLATES_DIR, "vawa-packet-build", "pdf_form.py");
const FORM_FILE = "form.pdf";
const FIELDS_FILE = "fields.json";
const VALUES_FILE = "values.json";
const FILLED_FILE = "filled.pdf";
const REPORT_FILE = "report.json";
const PDF_MIME = "application/pdf";
// USCIS forms run to a few MB; anything near this is not a blank form (or
// its uscis.gov page).
const MAX_FORM_PDF_BYTES = 25 * 1024 * 1024;
const FIELDS_TIMEOUT_MS = 120_000;
const FILL_TIMEOUT_MS = 180_000;
// One listing's share of the conversation: an I-485 has several hundred
// fields. A longer listing is cut at a field and the model asks for the rest
// by page. The cap guards one call; what keeps the three forms' listings
// small (they stay in every later request) is the compact line format below.
const MAX_LISTING_CHARS = 150_000;
// A USCIS tooltip opens with the Part and item and often ends with what
// distinguishes a check box ("Select Yes"); the question text between them
// is already in the answer table. Longer tooltips keep both ends.
const MAX_TOOLTIP_CHARS = 150;
const TOOLTIP_HEAD_CHARS = 100;
const TOOLTIP_TAIL_CHARS = 40;
// SKILL.md Hard Rule 8: plain ASCII in every deliverable. Line breaks only
// for multi-line fields (the script checks which those are).
const NON_ASCII = /[^\x20-\x7E\n]/;
// Section 6.2: a field with no supporting fact is left blank and its flag
// stays in the answer table. No bracketed text goes on a form: neither a
// drafting flag ([CLARIFY WITH CLIENT: ...], [ATTORNEY: VERIFY]) nor a
// placeholder such as [FIRM NAME].
const BRACKETED = /\[[^\]\n]*\]/;
const VAWA_FORMS = ["I-360", "I-485", "I-765"] as const;
type VawaForm = (typeof VAWA_FORMS)[number];
// Each form's page on uscis.gov, which links its current fillable PDF and its
// instructions. Used when the model names neither an uploaded blank nor
// another uscis.gov page.
const FORM_PAGE_URLS: Record<VawaForm, string> = {
  "I-360": "https://www.uscis.gov/i-360",
  "I-485": "https://www.uscis.gov/i-485",
  "I-765": "https://www.uscis.gov/i-765",
};
// The form number in the edition line pdf_form.py reads ("Form I-485 Edition ...").
const EDITION_FORM_NUMBER = /Form\s+([A-Z]{1,2}-\d+[A-Z]?)/;

// ---------------------------------------------------------------- inputs

// Both tools take the same blank form source, so a fill reads the file the
// listing read.
const blankFormSourceShape = {
  form: z.enum(VAWA_FORMS).describe("The form: I-360, I-485 or I-765"),
  form_document: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe(
      "Section 6.1 source 1, a blank fillable form the attorney uploaded to this matter: its document id, or its file name exactly as its label shows it. Leave it out to use source 2, the current form from its uscis.gov page."
    ),
  blank_form_url: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Only without form_document, and only after a call on the default page failed: another uscis.gov page that links the form's fillable PDF, or one of the PDF links that call listed. The default is the form's own page (https://www.uscis.gov/i-360, /i-485 or /i-765)."
    ),
};
type BlankFormSource = { form: VawaForm; form_document?: string; blank_form_url?: string };

const listPdfFormFieldsInputSchema = z.object({
  ...blankFormSourceShape,
  first_page: z.number().int().min(1).optional().describe("First page whose fields to list (default 1)"),
  last_page: z.number().int().min(1).optional().describe("Last page whose fields to list (default: the last page)"),
});

// The firm's and the preparer's details a form asks for, filled by the app
// from the firm identity into the fields the model names (the field names
// differ by form and edition); the model never supplies the values.
const FIRM_VALUES = [
  "preparer_full_name",
  "preparer_family_name",
  "preparer_given_name",
  "preparer_email",
  "preparer_bar_number",
  "firm_name",
  "firm_street",
  "firm_unit_number",
  "firm_unit_is_apt",
  "firm_unit_is_ste",
  "firm_unit_is_flr",
  "firm_city",
  "firm_state",
  "firm_zip",
  "firm_phone",
  "firm_phone_digits",
  "firm_email",
] as const;
type FirmValue = (typeof FIRM_VALUES)[number];

const FIRM_VALUE_DESCRIPTIONS: Record<FirmValue, string> = {
  preparer_full_name: "the preparer's full name",
  preparer_family_name: "the preparer's family (last) name",
  preparer_given_name: "the preparer's given (first) name",
  preparer_email: "the preparer's email (the firm's when the roster entry has none)",
  preparer_bar_number: "the preparer's bar number (the attorney state bar number in the G-28 box)",
  firm_name: "the firm's legal name (the preparer's business or organization name, or the in care of name of a safe mailing address at the firm)",
  firm_street: "the firm's street number and name",
  firm_unit_number: "the firm's suite, floor or apartment number (blank when its address has none)",
  firm_unit_is_apt: "check box, checked when the firm's unit is an apartment",
  firm_unit_is_ste: "check box, checked when the firm's unit is a suite",
  firm_unit_is_flr: "check box, checked when the firm's unit is a floor",
  firm_city: "the firm's city",
  firm_state: "the firm's state (two-letter code)",
  firm_zip: "the firm's ZIP code",
  firm_phone: "the firm's phone number as on file",
  firm_phone_digits: "the firm's phone number as digits only, for a digits-only field",
  firm_email: "the firm's email",
};

const fillPdfFormInputSchema = z.object({
  ...blankFormSourceShape,
  file_name: z
    .string()
    .min(1)
    .max(120)
    .describe("File name for the filled copy in the matter's documents, e.g. \"Form I-360 - DRAFT.pdf\". Letters, digits, spaces, and . _ - ( ) only."),
  values: z
    .array(
      z.object({
        field: z.string().min(1).max(500).describe("The full field name, exactly as list_pdf_form_fields returned it"),
        value: z
          .string()
          .max(2_000)
          .describe("Text: the exact text. Check box or radio: one of the field's states, or Off. Choice: one of its options."),
      })
    )
    .min(1)
    .max(3_000),
  firm_values: z
    .array(
      z.object({
        field: z.string().min(1).max(500).describe("The full field name, exactly as list_pdf_form_fields returned it"),
        firm_value: z
          .enum(FIRM_VALUES)
          .describe(`Which detail the app fills in: ${FIRM_VALUES.map((key) => `${key}, ${FIRM_VALUE_DESCRIPTIONS[key]}`).join("; ")}`),
      })
    )
    .max(100)
    .optional()
    .describe(
      "Fields that hold the firm's or the preparer's details (the preparer part, the bar number in the G-28 box, an in care of name or safe mailing address at the firm): the app fills them from the firm identity. Never put these details in values."
    ),
  preparer_attorney_id: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "id of the roster entry (FIRM IDENTITY section) who prepared the form, when the matter or the case note names someone other than the default signer; omit for the default signer"
    ),
});
type FillPdfFormInput = z.infer<typeof fillPdfFormInputSchema>;

// ---------------------------------------------------------------- script reports

// What `pdf_form.py fields` writes.
const fieldListingSchema = z.object({
  pages: z.number(),
  encrypted: z.boolean(),
  acroform: z.boolean(),
  xfa: z.boolean(),
  edition_text: z.string().nullable(),
  fields: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      pages: z.array(z.number()),
      tooltip: z.string().nullable(),
      max_length: z.number().nullable(),
      states: z.array(z.string()),
      options: z.array(z.object({ export: z.string(), display: z.string() })),
      editable_choice: z.boolean(),
      multiline: z.boolean(),
      comb: z.boolean(),
      read_only: z.boolean(),
      required: z.boolean(),
      signature_field: z.boolean(),
      value: z.string(),
    })
  ),
});
type FieldListing = z.infer<typeof fieldListingSchema>;
type ListedField = FieldListing["fields"][number];

// What `pdf_form.py fill` writes.
const fillReportSchema = z.union([
  z.object({ ok: z.literal(false), problems: z.array(z.string()) }),
  z.object({
    ok: z.literal(true),
    filled: z.number(),
    pages: z.number(),
    fields_total: z.number(),
    text_fields_left_blank: z.number(),
    warnings: z.array(z.string()),
  }),
]);

// What values.json holds: the model's values, and the app's firm values
// marked "fit" (the script leaves a field blank with a warning, rather than
// refusing the fill, when a firm value does not fit it).
type ScriptValue =
  | { field: string; value: string; fit?: true }
  | { field: string; checked: boolean; fit: true };

// ---------------------------------------------------------------- the blank form

type BlankForm = { bytes: Buffer; source: string; sha256: string };

/** Section 6.1 source 1: a matter PDF that passed the malware scan, read at its scanned version. */
async function loadMatterBlankForm(reference: string, ctx: ToolExecutionContext): Promise<BlankForm | string> {
  const doc = await findMatterDocument(reference, ctx);
  if (typeof doc === "string") return doc;
  if (doc.malwareScanStatus !== "clean") {
    return `"${doc.fileName}" has not passed the malware scan (status: ${doc.malwareScanStatus}), so it cannot be used. Only documents that scanned clean are read.`;
  }
  const byName = detectFileKind({ mimeType: doc.mimeType, fileName: doc.fileName });
  if (byName.kind !== "pdf" && byName.kind !== "other") {
    return `"${doc.fileName}" is not a PDF. Only a fillable PDF form can be listed or filled.`;
  }
  let bytes: Buffer;
  try {
    // The version the malware scan read, never bytes written to the key since.
    bytes = await getObjectBytes({
      bucket: doc.s3Bucket,
      key: doc.s3Key,
      versionId: doc.s3VersionId,
      maxBytes: MAX_FORM_PDF_BYTES,
    });
  } catch (err) {
    return `Could not read "${doc.fileName}": ${err instanceof Error ? err.message : String(err)}`;
  }
  if (detectFileKind({ bytes, mimeType: doc.mimeType, fileName: doc.fileName }).kind !== "pdf") {
    return `"${doc.fileName}" is not a PDF by its content. Only a fillable PDF form can be listed or filled.`;
  }
  return { bytes, source: `matter document "${doc.fileName}" (id ${doc.id})`, sha256: sha256(bytes) };
}

/**
 * Section 6.1 source 2: the form's blank fillable PDF from uscis.gov, scanned
 * clean. rawUrl is the form's page (the default) or another uscis.gov page
 * that links it, whose HTML gives the PDF's address, or the PDF itself. The
 * run reuses a download (downloadBlankForm), so the listing and the fill
 * read the same file.
 */
async function fetchBlankFormPdf(rawUrl: string, form: VawaForm, ctx: ToolExecutionContext): Promise<BlankForm | string> {
  const pending = `Ask for the current blank fillable Form ${form} to be uploaded to the matter (form_document), and until then deliver the answer table and say the PDF fill is pending the current blank form.`;
  const download = await downloadBlankForm({ rawUrl, form, maxBytes: MAX_FORM_PDF_BYTES, logTag: "vawa-packet-build" }, ctx);
  if (download.ok) return download.blank;
  const failure = download.failure;
  switch (failure.kind) {
    case "fetch_failed":
      return `${failure.message} ${pending}`;
    case "no_single_form_link":
      return (
        `${failure.page.toString()} is a web page, and ` +
        (failure.formPdfCount > 1
          ? `it links ${failure.formPdfCount} files named ${form.toLowerCase()}.pdf: ${failure.listed.join(", ")}. Call again with blank_form_url set to the one that is the current fillable Form ${form}.`
          : `it links no file named ${form.toLowerCase()}.pdf on uscis.gov` +
            (failure.listed.length > 0
              ? `; the PDFs it links are ${failure.listed.join(", ")}. If one of them is the fillable Form ${form}, call again with blank_form_url set to it.`
              : ".")) +
        ` Otherwise leave blank_form_url out to use ${FORM_PAGE_URLS[form]}. ${pending}`
      );
    case "linked_file_not_pdf":
      return `${failure.pdf.toString()}, the Form ${form} PDF link on ${failure.page.toString()}, did not return a PDF. ${pending}`;
    case "scan_failed":
      return `The blank Form ${form} downloaded from ${failure.blank.source} (sha256 ${failure.blank.sha256.slice(0, 16)}) is not used: it did not pass the malware scan (${failure.problem}). ${pending}`;
  }
}

/** The blank form from the source the model named: an uploaded blank, or the current one on uscis.gov. */
async function loadBlankForm(source: BlankFormSource, ctx: ToolExecutionContext): Promise<BlankForm | string> {
  const documentRef = source.form_document?.trim() ?? "";
  const url = source.blank_form_url?.trim() ?? "";
  if (documentRef && url) {
    return "Give form_document or blank_form_url, not both. Leave both out to take the form from its uscis.gov page.";
  }
  return documentRef
    ? loadMatterBlankForm(documentRef, ctx)
    : fetchBlankFormPdf(url || FORM_PAGE_URLS[source.form], source.form, ctx);
}

// ---------------------------------------------------------------- firm identity values

// The address split, the name split and the typed-value check are shared with
// the I-90 form tool (./shared/firm-values.ts). An address that does not read
// as "street, City, ST ZIP" leaves every address field blank.

/** A firm value in plain ASCII (Hard Rule 8), accents dropped; null when other characters remain. */
function foldToAscii(value: string): string | null {
  const folded = value.normalize("NFKD").replace(COMBINING_MARKS, "");
  return NON_ASCII.test(folded) || folded.includes("\n") ? null : folded;
}

type CompletedFirmValues = { items: ScriptValue[]; notes: string[] } | { error: string };

/**
 * The firm_values the model named, filled from the run's firm identity: the
 * preparer is the default signer, or the roster entry preparer_attorney_id
 * names when the case note names that person too (resolveSigner,
 * tools/shared/signer.ts); the address and phone are the firm's. A detail
 * the identity does not have leaves its field blank, and the notes say so,
 * so the report flags it (Section 6.2 wants the preparer part completed).
 */
function completeFirmValues(request: FillPdfFormInput, ctx: ToolExecutionContext): CompletedFirmValues {
  const entries = request.firm_values ?? [];
  const identity = ctx.firmIdentity;
  const chosen = resolveSigner(ctx, request.preparer_attorney_id, "preparer_attorney_id");
  if ("error" in chosen) return chosen;
  const preparer: FirmIdentitySnapshotAttorney | null = chosen.signer;
  if (entries.length === 0) return { items: [], notes: [] };

  const firm = identity?.firm ?? null;
  const address = parseFirmAddress(firm?.addressLines ?? []);
  const name = preparer ? splitPersonName(preparer.fullName) : null;
  const text = (value: string | null | undefined) => (value?.trim() ? { value: value.trim() } : null);
  const resolve = (key: FirmValue): { value: string } | { checked: boolean } | null => {
    switch (key) {
      case "preparer_full_name":
        return text(preparer?.fullName);
      case "preparer_family_name":
        return text(name?.family);
      case "preparer_given_name":
        return text(name?.given);
      case "preparer_email":
        return text(preparer?.email || firm?.email);
      case "preparer_bar_number":
        return text(preparer?.barNumber);
      case "firm_name":
        return text(firm?.legalName);
      case "firm_street":
        return text(address.street);
      case "firm_unit_number":
        return text(address.unitNumber);
      case "firm_unit_is_apt":
        return { checked: address.unitType === "apt" };
      case "firm_unit_is_ste":
        return { checked: address.unitType === "ste" };
      case "firm_unit_is_flr":
        return { checked: address.unitType === "flr" };
      case "firm_city":
        return text(address.city);
      case "firm_state":
        return text(address.state);
      case "firm_zip":
        return text(address.zip);
      case "firm_phone":
        return text(firm?.phone);
      case "firm_phone_digits":
        return text(firm?.phone ? nationalPhoneDigits(firm.phone) : null);
      case "firm_email":
        return text(firm?.email);
    }
  };

  const items: ScriptValue[] = [];
  const missing = new Set<string>();
  const notAscii = new Set<string>();
  let usesPreparer = false;
  let usesName = false;
  let usesAddress = false;
  for (const entry of entries) {
    const key = entry.firm_value;
    if (key.startsWith("preparer_")) usesPreparer = true;
    if (key === "preparer_family_name" || key === "preparer_given_name") usesName = true;
    if (/^firm_(street|unit|city|state|zip)/.test(key)) usesAddress = true;
    const resolved = resolve(key);
    if (!resolved) {
      // An address without a unit is complete: that field just stays blank.
      if (key !== "firm_unit_number") missing.add(FIRM_VALUE_DESCRIPTIONS[key]);
      continue;
    }
    if ("checked" in resolved) {
      items.push({ field: entry.field, checked: resolved.checked, fit: true });
      continue;
    }
    const ascii = foldToAscii(resolved.value);
    if (ascii === null) {
      notAscii.add(FIRM_VALUE_DESCRIPTIONS[key]);
      continue;
    }
    items.push({ field: entry.field, value: ascii, fit: true });
  }

  const notes = [
    `The app supplied ${items.length} value(s) from the firm identity of ${firm?.legalName ?? "(no firm details on file)"}` +
      (usesPreparer
        ? `, with ${preparer ? preparer.fullName : "no preparer (no default signer is set on the roster)"} as the preparer.`
        : "."),
  ];
  if (usesName && preparer && name) {
    notes.push(`The roster name "${preparer.fullName}" was split as given name "${name.given}", family name "${name.family}": check it on the rendered pages.`);
  }
  if (usesAddress && address.city) {
    notes.push(
      `The firm address was read as street "${address.street ?? ""}", ${address.unitType ? `${address.unitType} "${address.unitNumber}", ` : ""}city "${address.city}", state "${address.state}", ZIP "${address.zip}": check it on the rendered pages and flag any part that is wrong.`
    );
  }
  if (missing.size > 0) {
    notes.push(
      `Left blank because the firm identity does not have them (or its address does not read as "street, City, ST ZIP"): ${[...missing].join("; ")}. ` +
        "Flag in your report that the firm identity setup is incomplete and that these fields must be completed before filing."
    );
  }
  if (notAscii.size > 0) {
    notes.push(
      `Left blank because the firm identity writes them with characters outside plain ASCII: ${[...notAscii].join("; ")}. Flag them for the attorney to complete.`
    );
  }
  return { items, notes };
}

// ---------------------------------------------------------------- list_pdf_form_fields

function shortTooltip(tooltip: string | null): string {
  const text = (tooltip ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= MAX_TOOLTIP_CHARS) return text;
  return `${text.slice(0, TOOLTIP_HEAD_CHARS).trimEnd()} ... ${text.slice(-TOOLTIP_TAIL_CHARS).trimStart()}`;
}

/**
 * Buttons, read-only fields and fields of no fillable type are refused by
 * the script, so the listing only counts them. Signature fields stay listed,
 * so the model sees where the signer's fields are.
 */
function isListed(field: ListedField): boolean {
  return field.signature_field || (field.type !== "pushbutton" && field.type !== "unknown" && !field.read_only);
}

/**
 * One listing line: page | type | name | tooltip | limits and current value.
 * `optionLists` maps an option list already printed to the field it was
 * printed for, so a repeated list (a state or country dropdown on every
 * address) is named instead of printed again.
 */
function formatField(field: ListedField, optionLists: Map<string, string>): string {
  const limits: string[] = [];
  if (field.signature_field) limits.push("signature: left for the signer");
  if (field.max_length !== null) limits.push(`max ${field.max_length}${field.comb ? " (comb)" : ""}`);
  if (field.multiline) limits.push("multi-line");
  if (field.states.length > 0) limits.push(`states: ${field.states.join(", ")}`);
  if (field.options.length > 0) {
    const options = field.options
      .map((o) => (o.display && o.display !== o.export ? `${o.export} (${o.display})` : o.export))
      .join("; ");
    const label = `options${field.editable_choice ? " (or any text)" : ""}`;
    const first = optionLists.get(options);
    if (first) {
      limits.push(`${label}: same as ${first}`);
    } else {
      optionLists.set(options, field.name);
      limits.push(`${label}: ${options}`);
    }
  }
  if (field.required) limits.push("required");
  if (field.value) limits.push(`current value: ${field.value}`);
  const pages = field.pages.join(",");
  return `p${pages} | ${field.type} | ${field.name} | ${shortTooltip(field.tooltip)} | ${limits.join("; ")}`;
}

async function executeListPdfFormFields(input: unknown, ctx: ToolExecutionContext) {
  const parsed = listPdfFormFieldsInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      content: `Input validation failed: ${parsed.error.message}. Call list_pdf_form_fields again with corrected input.`,
      isError: true,
    };
  }
  const { form } = parsed.data;
  const blank = await loadBlankForm(parsed.data, ctx);
  if (typeof blank === "string") return { content: blank, isError: true };

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdfform-"));
  let listing: FieldListing;
  try {
    await fs.writeFile(path.join(workDir, FORM_FILE), blank.bytes);
    try {
      await execUntrusted("python3", [SCRIPT_PATH, "fields", FORM_FILE, FIELDS_FILE], {
        workDir,
        timeoutMs: FIELDS_TIMEOUT_MS,
      });
    } catch (err) {
      return { content: `Could not read the form fields of the blank Form ${form} (${blank.source}): ${describeFormToolError(err)}`, isError: true };
    }
    const raw = fieldListingSchema.safeParse(JSON.parse(await readToolOutput(path.join(workDir, FIELDS_FILE), { maxBytes: TOOL_OUTPUT_LIMITS.report, encoding: "utf-8" })));
    if (!raw.success) {
      return { content: `pdf_form.py fields wrote an unexpected listing: ${raw.error.message}`, isError: true };
    }
    listing = raw.data;
  } finally {
    await cleanupWorkDir(workDir);
  }

  const first = parsed.data.first_page ?? 1;
  const last = Math.min(parsed.data.last_page ?? listing.pages, listing.pages);
  if (first > listing.pages) {
    return { content: `The blank Form ${form} has ${listing.pages} page(s); first_page ${first} is past the end.`, isError: true };
  }
  if (last < first) return { content: "last_page is before first_page.", isError: true };

  const printedForm = EDITION_FORM_NUMBER.exec(listing.edition_text ?? "")?.[1]?.toUpperCase();
  const header = [
    `Blank Form ${form}: ${blank.source} (sha256 ${blank.sha256.slice(0, 16)}), ${listing.pages} page(s), ${listing.fields.length} field(s) with a widget on a page.`,
    listing.edition_text
      ? `Edition printed on the form: "${listing.edition_text}" (read from the page text; confirm on uscis.gov that it is the current edition, and record it in the answer table's edition).`
      : "No edition line could be read from the page text; read the edition from the form's footer.",
  ];
  if (printedForm && printedForm !== form) {
    header.push(`The edition line names Form ${printedForm}, not Form ${form}: check that this is the right blank form before filling it.`);
  }
  if (!listing.acroform || listing.fields.length === 0) {
    header.push(
      "This PDF has no fillable AcroForm fields (a flattened, scanned or XFA-only form), so it cannot be filled here: deliver the answer table and say the PDF fill is pending a fillable blank form."
    );
    return { content: header.join("\n") };
  }
  if (listing.xfa) {
    header.push("The form also carries XFA data; the filled copy drops it so every viewer shows the filled values.");
  }
  if (listing.encrypted) {
    header.push("The form is encrypted with an empty open password; the filled copy is saved unencrypted.");
  }
  const inRange = listing.fields.filter((f) => f.pages.some((p) => p >= first && p <= last));
  const listed = inRange.filter(isListed);
  const notListed = inRange.length - listed.length;
  header.push(
    `Fields on pages ${first}-${last}, one per line (pages | type | field name to pass to fill_pdf_form | tooltip, long ones shortened in the middle | limits):`
  );

  const lines: string[] = [];
  const optionLists = new Map<string, string>();
  let length = header.join("\n").length;
  let cutAt: ListedField | null = null;
  for (const field of listed) {
    const line = formatField(field, optionLists);
    if (length + line.length + 1 > MAX_LISTING_CHARS) {
      cutAt = field;
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  const footer: string[] = [];
  if (cutAt) {
    const resume = Math.min(...cutAt.pages.filter((p) => p >= first));
    footer.push(
      `The listing stopped before ${cutAt.name} to keep the conversation small; call list_pdf_form_fields again with first_page ${resume} for the rest.`
    );
  }
  if (notListed > 0) {
    footer.push(`${notListed} button, read-only or other unfillable field(s) on these pages are not listed.`);
  }
  footer.push(
    "Signature and date-of-signature fields are listed for reference only: fill_pdf_form refuses them (they are completed when the person signs).",
    "Fields for the firm's or the preparer's details (the preparer part, the bar number in the G-28 box, an in care of name or safe mailing address at the firm) go in fill_pdf_form's firm_values, never in values.",
    "This listing stays in the conversation for the rest of the run: do not list this form again except to continue a cut listing."
  );
  const content = [...header, ...lines, ...footer].join("\n");

  // The listing stays in every later request of the run.
  if (!chargeRequestBytes(ctx, content)) {
    return {
      content:
        "The field listing does not fit: the conversation is too close to the API's request size limit. " +
        "List a narrower page range, or deliver the answer table and say the PDF fill is pending.",
      isError: true,
    };
  }
  return { content };
}

// ---------------------------------------------------------------- fill_pdf_form

/** Checks the values that need no knowledge of the form; the script checks the rest. */
function valueProblems(request: FillPdfFormInput, identity: FirmIdentitySnapshot | null): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { field, value } of request.values) {
    if (seen.has(field)) problems.push(`${field}: given more than once`);
    seen.add(field);
    if (BRACKETED.test(value)) {
      problems.push(
        `${field}: carries bracketed text (a drafting flag or a placeholder); leave the field out of values (blank) and keep the flag in the answer table (SKILL.md Section 6.2)`
      );
      continue;
    }
    if (NON_ASCII.test(value)) {
      problems.push(`${field}: contains a character outside plain ASCII (Hard Rule 8); write it in plain ASCII`);
      continue;
    }
    const detail = firmDetailIn(value, identity);
    if (detail) {
      problems.push(
        `${field}: the value carries ${detail}. Firm and preparer details are filled by the app: name this field in firm_values instead`
      );
    }
  }
  for (const { field } of request.firm_values ?? []) {
    if (seen.has(field)) {
      problems.push(`${field}: named more than once (in values and firm_values, or twice in firm_values)`);
    }
    seen.add(field);
  }
  return problems;
}

async function executeFillPdfForm(input: unknown, ctx: ToolExecutionContext) {
  const parsed = fillPdfFormInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      content: `Input validation failed: ${parsed.error.message}. Call fill_pdf_form again with corrected input.`,
      isError: true,
    };
  }
  const request = parsed.data;
  const early = valueProblems(request, ctx.firmIdentity);
  if (early.length > 0) {
    return { content: `Nothing was filled. Fix these values and call fill_pdf_form again:\n- ${early.join("\n- ")}`, isError: true };
  }
  const firmValues = completeFirmValues(request, ctx);
  if ("error" in firmValues) return { content: firmValues.error, isError: true };

  const blank = await loadBlankForm(request, ctx);
  if (typeof blank === "string") return { content: blank, isError: true };

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdffill-"));
  let keepWorkDir = false;
  try {
    const values: ScriptValue[] = [...request.values.map(({ field, value }) => ({ field, value })), ...firmValues.items];
    await fs.writeFile(path.join(workDir, FORM_FILE), blank.bytes);
    await fs.writeFile(path.join(workDir, VALUES_FILE), JSON.stringify(values), "utf-8");
    try {
      await execUntrusted("python3", [SCRIPT_PATH, "fill", FORM_FILE, VALUES_FILE, FILLED_FILE, REPORT_FILE], {
        workDir,
        timeoutMs: FILL_TIMEOUT_MS,
      });
    } catch (err) {
      return { content: `Could not fill the blank Form ${request.form} (${blank.source}): ${describeFormToolError(err)}`, isError: true };
    }
    const report = fillReportSchema.safeParse(JSON.parse(await readToolOutput(path.join(workDir, REPORT_FILE), { maxBytes: TOOL_OUTPUT_LIMITS.report, encoding: "utf-8" })));
    if (!report.success) {
      return { content: `pdf_form.py fill wrote an unexpected report: ${report.error.message}`, isError: true };
    }
    if (!report.data.ok) {
      return {
        content: `Nothing was filled: ${report.data.problems.length} value(s) were refused. Fix them and call fill_pdf_form again with every value:\n- ${report.data.problems.join("\n- ")}`,
        isError: true,
      };
    }
    const filled = report.data;

    const pdfPath = path.join(workDir, FILLED_FILE);
    const pdfBytes = await readToolOutput(pdfPath, { maxBytes: TOOL_OUTPUT_LIMITS.document });
    let pageImagePaths: string[];
    try {
      pageImagePaths = await rasterizePdfPages(workDir, pdfPath);
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
    // The blank form, the values and the script's files are not kept; the
    // page images are, for render_and_qa_docx.
    await removeAllButPageImages(workDir);

    const fileName = safePdfFileName(request.file_name, "Filled Form");
    const row = await createGeneratedDocument({
      tenantId: ctx.tenantId,
      matterId: ctx.matterId,
      fileName,
      contentType: PDF_MIME,
      body: pdfBytes,
      uploadedBy: ctx.requestedBy,
      type: "generated_draft",
    });
    // From here on the work directory belongs to the stored document's
    // entry, and cleanupGeneratedDocuments removes it at the end of the run.
    ctx.generatedDocuments.set(row.id, { documentRowId: row.id, pageImagePaths, workDir, origin: "generated" });
    keepWorkDir = true;

    return {
      content: [
        `Filled Form ${request.form}: document_id ${row.id}, saved as "${fileName}" (${filled.pages} page(s)), from ${blank.source} (sha256 ${blank.sha256.slice(0, 16)}). ${filled.filled} field(s) filled of ${filled.fields_total}; ${filled.text_fields_left_blank} fillable text or choice field(s) left blank.`,
        ...firmValues.notes,
        ...filled.warnings,
        "Call render_and_qa_docx with this document_id, and first_page / last_page for the pages you need to check against the answer table (page images are limited per run, and the declaration, the cover letter and the other forms need theirs); blank fields stay marked for follow-up in the answer table.",
        "Each fill_pdf_form call saves a new document: refill only to fix a problem, and report only the final document_id.",
      ].join("\n"),
    };
  } finally {
    if (!keepWorkDir) await cleanupWorkDir(workDir);
  }
}

// ---------------------------------------------------------------- the tools

/** Tool key list_pdf_form_fields_vawa; the model sees it as list_pdf_form_fields. */
export const listVawaPdfFormFieldsTool: SkillTool = {
  definition: {
    name: "list_pdf_form_fields",
    description:
      "List the fillable fields of the blank fillable PDF of Form I-360, I-485 or I-765, for SKILL.md Section 6. " +
      "The blank form is either Section 6.1 source. Give form_document for the blank the attorney uploaded to the matter (its id, or its file name exactly as its label shows it; only PDFs that passed the malware scan). " +
      "Otherwise leave it out and the app takes the current form from uscis.gov itself: it opens the form's page (https://www.uscis.gov/i-360, /i-485 or /i-765), finds the link to the fillable PDF in the page's HTML (fetch_uscis_page shows you text only, so you never need the PDF's address), downloads it and scans it for malware; a download that does not scan clean is not used. Both requests go to the run's verification log. Give blank_form_url only to name another uscis.gov page that links the form, or a PDF link a failed call listed. " +
      "Returns the source, the edition printed on the form when it can be read from the page text (confirm it is the current edition, Section 2, and note it in the output), and one line per fillable or signature field: its page(s), type (text, checkbox, radio, choice, signature), the full field name fill_pdf_form takes, its tooltip (usually the Part and item number; long ones shortened in the middle), and its limits (maximum length, check box or radio states, choice options). " +
      "The listing stays in the conversation for the rest of the run, which still has to reach the Step 10 QA gates: list each form once, after its answer table is drafted, and use first_page / last_page only to continue a cut listing. " +
      "If no blank form can be had (none uploaded, and the download fails or does not scan clean), deliver the answer table and say the PDF fill is pending the current blank form.",
    input_schema: toJsonSchemaObject(listPdfFormFieldsInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeListPdfFormFields,
};

/** Tool key fill_pdf_form_vawa; the model sees it as fill_pdf_form. */
export const fillVawaPdfFormTool: SkillTool = {
  definition: {
    name: "fill_pdf_form",
    description:
      "Fill the blank fillable PDF of Form I-360, I-485 or I-765 from your answer table and save the filled copy to the matter's documents (SKILL.md Section 6.2). " +
      "Input: form and the same blank form source as list_pdf_form_fields (the run reuses the file it downloaded), file_name for the filled copy, values, and firm_values. " +
      "values: one { field, value } per field you fill, using the full field names list_pdf_form_fields returned. Text: the exact text, within the field's maximum length (for a comb field such as an A-number, only the characters the boxes take). Check box or radio: one of the field's states, or Off. Choice: one of its options. " +
      "Fill only from facts in the record. A field with no supporting fact stays out of values (blank) and its [CLARIFY WITH CLIENT] flag stays in the answer table: a value carrying bracketed text is refused, as are characters outside plain ASCII, signature and date-of-signature fields (completed when the person signs), read-only fields and names the form does not have. " +
      "firm_values: the firm's and the preparer's details (the preparer part, the attorney bar number in the G-28 box, an in care of name or safe mailing address at the firm) are never typed. Name each such field with the firm_value it holds and the app fills it from the firm identity in the FIRM IDENTITY section, for the default signer unless preparer_attorney_id names another roster member. A typed value carrying the firm's or a roster member's name, bar number, EOIR ID, email or phone is refused. A detail the firm identity lacks leaves its field blank, and the result says so. " +
      "Every value is checked before anything is written; if any is refused, nothing is saved and the result lists every problem. " +
      "The filled copy keeps its fields editable and drops the form's XFA data so every viewer shows the values. Returns a document_id: call render_and_qa_docx with it to look at the filled pages. Each call saves a new document; report only the final document_id.",
    input_schema: toJsonSchemaObject(fillPdfFormInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeFillPdfForm,
};

/**
 * Section 4 Step 10's first QA gate: loads vawa-packet-review.
 * Tool key load_qa_gate_skill_vawa_packet_review; the model sees it as
 * load_vawa_packet_review_skill.
 */
export const loadVawaPacketReviewTool: SkillTool = createQaGateSkillTool({
  toolName: "load_vawa_packet_review_skill",
  companionSkill: "vawa-packet-review",
  description:
    "Load the firm's vawa-packet-review skill: the QA gate SKILL.md Section 4 Step 10 says to run over the assembled packet (\"Run the vawa-packet-review skill over the assembled packet and hand the attorney that report with the packet\"). " +
    "Call it once, after the declaration, affidavit templates, cover letter and forms are built and you have checked their pages. " +
    "Step 10 is required, so keep room in the run for it: fetch, list and render only what the build needs. " +
    "It returns that skill's instructions. Review the packet under them, as that skill's reviewer, put its report in vawaPacketReviewAndOrthographyCheckReports.vawaPacketReviewReport, and set vawaPacketReviewSkillLoaded to true. " +
    "If the run ends before the review is done, omit vawaPacketReviewReport (never fill it with a verdict no review reached) and say why in qaGateNotes. Takes no input.",
  unavailableInstruction:
    "Review the packet yourself against SKILL.md Sections 3, 6.5 and 8, put the result in vawaPacketReviewAndOrthographyCheckReports.vawaPacketReviewReport, set vawaPacketReviewSkillLoaded to false, " +
    "and say in qaGateNotes that the vawa-packet-review skill itself could not be loaded and must be run separately on this matter.",
  runNotes: [
    "You are now the independent reviewer this skill hands its packet to. Apply the instructions below to the packet assembled in this run, in that skill's posture: look for defects, not for confirmation of the build.",
    "The packet is what this run built plus the matter documents in the first message: the declaration, affidavit templates, cover letter and memo as passed to generate_document and shown by render_and_qa_docx, the filled forms as passed to fill_pdf_form (the answer tables where a PDF is pending), and the exhibits on the matter. Anything not built or not provided is missing, never assumed.",
    "Its Section 1 run-time verification is the verification already done in this run: rely on the pages fetched in this run, fetch only what was not checked, and mark the rest [ATTORNEY: VERIFY].",
    "Review the packet as it will be delivered. If you change a document after this review (for example to apply the orthography-check fixes), re-check the changed parts under the review's steps before reporting, so the report describes the documents the attorney opens.",
    "Put the review's report in vawaPacketReviewAndOrthographyCheckReports.vawaPacketReviewReport, item for item: its SECTION 4 items 1 to 12, then its escalation flags. Every BLOCKER and MATERIAL item it lists also goes on your master action checklist. The app prints the work-product header.",
    "Its text was written for the same firm as your own skill text, and the FIRM IDENTITY section in your instructions applies to it in the same way.",
  ],
});

/**
 * Section 4 Step 10's second QA gate: loads orthography-check.
 * Tool key load_qa_gate_skill_orthography_check; the model sees it as
 * load_orthography_check_skill.
 */
export const loadOrthographyCheckTool: SkillTool = createQaGateSkillTool({
  toolName: "load_orthography_check_skill",
  companionSkill: "orthography-check",
  description:
    "Load the firm's orthography-check skill: SKILL.md Section 4 Step 10's second pass (\"Then run orthography-check over the cover letter and declaration\"). " +
    "Call it once, after the cover letter and the declaration are generated. It returns that skill's instructions and references. " +
    "Check both documents under them, put one report per document in vawaPacketReviewAndOrthographyCheckReports.orthographyCheckReports, and set orthographyCheckSkillLoaded to true. Takes no input.",
  unavailableInstruction:
    "Run the pass yourself over the cover letter and the declaration for name spellings, pronouns carried over from another client, and duplicated sentences (SKILL.md Sections 5.5, 9.2 and 9.7 item 10), " +
    "report it in orthographyCheckReports, set orthographyCheckSkillLoaded to false, and say in qaGateNotes that the orthography-check skill itself could not be loaded and must be run separately on both documents.",
  runNotes: [
    "Check the cover letter and the declaration generated in this run: their text is what you passed to generate_document, and their pages are what render_and_qa_docx showed.",
    "Its corrected copy is the same document generated again with generate_document with only the certain fixes applied; what it flags stays as written. Report the regenerated document's id as the final declaration or cover letter id, after checking its pages with render_and_qa_docx.",
    "Put one report per document in vawaPacketReviewAndOrthographyCheckReports.orthographyCheckReports, following its Report structure: summary, fixed, flagged for your decision, name and term consistency, document-wide notes. Say so briefly where a category had no issues. No separate report file is delivered.",
    "Its references/file-handling.md describes desktop file handling; in this run the only file operations are generate_document and render_and_qa_docx.",
  ],
});
