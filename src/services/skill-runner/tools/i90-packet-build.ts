import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createGeneratedDocument } from "@/lib/documents/service";
import { looksLikePdf } from "@/lib/documents/file-kind";
import {
  type FirmIdentitySnapshot,
  type FirmIdentitySnapshotAttorney,
} from "@/lib/firm-identity/schema";
import { getObjectBytes } from "@/lib/s3";
import { execUntrusted, readToolOutput, TOOL_OUTPUT_LIMITS } from "@/services/sandbox/untrusted-exec";
import { cleanupWorkDir, DOCX_TEMPLATES_DIR, rasterizePdfPages } from "@/services/docx-generator/generate";
import { toJsonSchemaObject } from "../json-schema";
import {
  i90FormFillInputSchema,
  i90FormFillSpecSchema,
  type I90FormFillInput,
  type I90FormFillSpec,
  type I90FormFirmValue,
  type I90PacketForm,
} from "../skills/i90-packet-build";
// Types only: tools.ts imports this module for its registry.
import type { SkillTool, ToolExecutionContext } from "../tools";
import { createQaGateSkillTool } from "./companion-skills";
import { firmDetailIn, parseFirmAddress, splitPersonName } from "./shared/firm-values";
import { chargeRequestBytes } from "./shared/request-bytes";
import { resolveSigner } from "./shared/signer";
import {
  describeFormToolError,
  downloadBlankForm,
  findMatterDocument,
  removeAllButPageImages,
  safePdfFileName,
  sha256,
  type BlankFormDownloadFailure,
} from "./shared/uscis-forms";

/**
 * i90-packet-build's form filler, exposed to the model as fill_uscis_form_pdf:
 * SECTION 7 items 5 and 6, the filled Form I-90 and Form G-28, from the
 * official fillable PDFs. It stands in for "fill the fillable PDF from the
 * table" (SECTION 5), which the desktop skill does with a PDF library, around
 * src/services/docx-generator/templates/i90-packet-build/fill_uscis_form.py.
 *
 * Two actions on one blank form: inspect lists its fillable fields (full
 * name, type, page, the form's own tooltip, length limit, states or options),
 * so the model fills fields by the names the current edition really has,
 * never by names it remembers; fill fills them and stores the filled PDF on
 * the matter, with its rendered pages kept for render_and_qa_docx.
 *
 * The blank form is the current PDF on uscis.gov, or a blank form the
 * attorney uploaded to the matter (malware-clean, read at its scanned
 * version). The uscis.gov PDF is found here, not by the model
 * (downloadBlankForm in ./shared/uscis-forms.ts, shared with the I-589 and
 * VAWA form tools): the tool fetches the form's page
 * (https://www.uscis.gov/i-90 or /g-28, or another uscis.gov page the model
 * names), takes the link to the form's own PDF from its HTML, and downloads
 * that, on the same https-only, redirect-checked terms as fetch_uscis_page;
 * both requests go to the run's verification log with their hashes. Inspect
 * and fill read the same download. The download is scanned with ClamAV
 * before any parser reads it: only a scan that ran and found nothing lets it
 * be used, and otherwise the model is told to use an uploaded blank (fail
 * closed).
 *
 * What the model cannot control (docs/ADDING_A_SKILL.md 2.8): the firm's and
 * the representative's details. Fields that hold them (the G-28's attorney
 * blocks, the I-90 Part 7 preparer block) take a firm_value the server fills
 * from ctx.firmIdentity, the run's snapshot, for the default signer or the
 * roster entry the model names; a typed value carrying the firm's or a roster
 * member's name, bar number, EOIR ID, email or phone is refused. No signature
 * is ever put on a form: the script refuses signature fields, so no signature
 * image is read and no firm_signature.applied entry is written.
 */

const SCRIPT_PATH = path.join(DOCX_TEMPLATES_DIR, "i90-packet-build", "fill_uscis_form.py");
const BLANK_FORM_FILE = "form.pdf";
const SPEC_FILE = "spec.json";
const FILLED_FORM_FILE = "filled.pdf";
const PDF_MIME = "application/pdf";
// A blank USCIS form is a few MB at most.
const MAX_FORM_PDF_BYTES = 20 * 1024 * 1024;
const SCRIPT_TIMEOUT_MS = 120_000;
// The field list of a long form, as JSON, is well under this.
const SCRIPT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_ENTRY_ERRORS = 50;
// Each form's page on uscis.gov, which links its current fillable PDF (as
// href="/sites/default/files/document/forms/i-90.pdf" when this was written)
// and its instructions. Used when the model names no other source.
const FORM_PAGE_URLS: Record<I90PacketForm, string> = {
  "I-90": "https://www.uscis.gov/i-90",
  "G-28": "https://www.uscis.gov/g-28",
};

// ---------------------------------------------------------------- script reports

const scriptFailureSchema = z.object({ ok: z.literal(false), errors: z.array(z.string()) });

const inspectedFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  page: z.number().optional(),
  tooltip: z.string().optional(),
  read_only: z.boolean().optional(),
  max_length: z.number().optional(),
  multiline: z.boolean().optional(),
  states: z.array(z.string()).optional(),
  options: z.array(z.string()).optional(),
  editable: z.boolean().optional(),
  signature: z.boolean().optional(),
  value: z.string().optional(),
});
type InspectedField = z.infer<typeof inspectedFieldSchema>;

const inspectReportSchema = z.object({
  ok: z.literal(true),
  encrypted: z.boolean(),
  has_xfa: z.boolean(),
  page_count: z.number(),
  edition_text: z.array(z.string()),
  form_numbers: z.array(z.string()),
  field_count: z.number(),
  pushbuttons_skipped: z.number(),
  fields: z.array(inspectedFieldSchema),
  warnings: z.array(z.string()),
});
type InspectReport = z.infer<typeof inspectReportSchema>;

const fillReportSchema = z.object({
  ok: z.literal(true),
  filled: z.number(),
  page_count: z.number(),
  blank_text_fields: z.array(z.string()),
  blank_text_field_count: z.number(),
  unset_checkboxes_and_radios: z.number(),
  signature_fields_left_blank: z.array(z.string()),
  removed: z.array(z.string()),
});
type FillReport = z.infer<typeof fillReportSchema>;

/** Runs the form script sandboxed in workDir: the JSON report it printed, or the errors it gave. */
async function runFormScript(args: string[], workDir: string): Promise<{ report: unknown } | { errors: string[] }> {
  const { stdout } = await execUntrusted("python3", [SCRIPT_PATH, ...args], {
    workDir,
    timeoutMs: SCRIPT_TIMEOUT_MS,
    maxBuffer: SCRIPT_MAX_BUFFER,
  });
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error(`fill_uscis_form.py printed no report: ${stdout.slice(0, 500)}`);
  const report: unknown = JSON.parse(stdout.slice(start, end + 1));
  const failure = scriptFailureSchema.safeParse(report);
  return failure.success ? { errors: failure.data.errors } : { report };
}

// ---------------------------------------------------------------- the blank form

type BlankForm = { bytes: Buffer; source: string; sha256: string };

/** What a uscis.gov download that is not used tells the model, with the way forward. */
function downloadFailureMessage(failure: BlankFormDownloadFailure, form: I90PacketForm): string {
  switch (failure.kind) {
    case "fetch_failed":
      return failure.message;
    case "no_single_form_link":
      return (
        `${failure.page.toString()} is a web page, and ` +
        (failure.formPdfCount > 1
          ? `it links ${failure.formPdfCount} files named ${form.toLowerCase()}.pdf: ${failure.listed.join(", ")}. Call again with blank_form_url set to the one that is the current fillable Form ${form}.`
          : `it links no file named ${form.toLowerCase()}.pdf on uscis.gov` +
            (failure.listed.length > 0
              ? `; the PDFs it links are ${failure.listed.join(", ")}. If one of them is the fillable Form ${form}, call again with blank_form_url set to it.`
              : ".")) +
        ` Otherwise leave blank_form_url out to use ${FORM_PAGE_URLS[form]}, or ask for the blank form to be uploaded to the matter (blank_form_document), and report the filled form as not generated until then.`
      );
    case "linked_file_not_pdf":
      return `${failure.pdf.toString()}, the Form ${form} PDF link on ${failure.page.toString()}, did not return a PDF. Use a blank form uploaded to the matter (blank_form_document) instead, or report the filled form as not generated.`;
    case "scan_failed":
      return (
        `The blank Form ${form} downloaded from ${failure.blank.source} (sha256 ${failure.blank.sha256.slice(0, 16)}) is not used: it did not pass the malware scan (${failure.problem}). ` +
        `Ask for the current blank fillable Form ${form} to be uploaded to the matter and use it with blank_form_document, and until then report the filled form as not generated, and why.`
      );
  }
}

/**
 * The form's blank fillable PDF from uscis.gov, scanned clean. rawUrl is the
 * form's page (the default) or another uscis.gov page that links it, whose
 * HTML gives the PDF's address, or the PDF itself. The run reuses a download
 * (downloadBlankForm), so inspect and fill read the same file.
 */
async function fetchBlankFormPdf(rawUrl: string, form: I90PacketForm, ctx: ToolExecutionContext): Promise<BlankForm | string> {
  const download = await downloadBlankForm({ rawUrl, form, maxBytes: MAX_FORM_PDF_BYTES, logTag: "i90-packet-build" }, ctx);
  return download.ok ? download.blank : downloadFailureMessage(download.failure, form);
}

/**
 * A blank form the attorney uploaded to this matter, named by id or by file
 * name (the document labels show file names; the inventory also lists each document_id): clean, a PDF by
 * content, read at the version the malware scan read.
 */
async function loadBlankFormDocument(reference: string, ctx: ToolExecutionContext): Promise<BlankForm | string> {
  const doc = await findMatterDocument(reference, ctx);
  if (typeof doc === "string") return doc;
  if (doc.malwareScanStatus !== "clean") {
    return `"${doc.fileName}" has not passed the malware scan (status: ${doc.malwareScanStatus}), so it is not used. Only documents that scanned clean are filled.`;
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
  if (!looksLikePdf(bytes)) return `"${doc.fileName}" is not a PDF by its content, so it is not a fillable form.`;
  return { bytes, source: `matter document "${doc.fileName}" (id ${doc.id})`, sha256: sha256(bytes) };
}

// ---------------------------------------------------------------- firm identity values

// The address split, the name split and the typed-value check are shared with
// the VAWA form tool (./shared/firm-values.ts). Where the firm's address does
// not read as "street, City, ST ZIP", the I-90 and G-28 print it whole as the
// street, with placeholders for the other parts (unreadAsStreet).
type ResolvedFirmValue = { value: string } | { checked: boolean };

/**
 * Resolves firm_value keys for one fill from the run's firm identity and the
 * chosen signer. Records the bracketed placeholders it had to print and what
 * it derived (the name split, the address split) for the tool's notes.
 */
function firmValueResolver(identity: FirmIdentitySnapshot | null, signer: FirmIdentitySnapshotAttorney | null) {
  const placeholders = new Set<string>();
  const derived = new Set<string>();
  const firm = identity?.firm ?? null;
  const address = parseFirmAddress(firm?.addressLines ?? [], { unreadAsStreet: true });
  const name = signer ? splitPersonName(signer.fullName) : null;

  const text = (value: string | null | undefined, placeholder: string): ResolvedFirmValue => {
    if (value) return { value };
    placeholders.add(placeholder);
    return { value: placeholder };
  };
  const digits = (value: string | null | undefined, placeholder: string): ResolvedFirmValue =>
    value ? { value: value.replace(/\D/g, "") } : text(null, placeholder);
  const addressPart = (value: string | null, placeholder: string): ResolvedFirmValue => {
    derived.add(
      `the firm address was read as street "${address.street ?? ""}", ${address.unitType ? `${address.unitType} "${address.unitNumber}", ` : ""}city "${address.city ?? ""}", state "${address.state ?? ""}", ZIP "${address.zip ?? ""}"`
    );
    return text(value, placeholder);
  };
  const namePart = (value: string | undefined, placeholder: string): ResolvedFirmValue => {
    if (signer && name) {
      derived.add(
        `the roster name "${signer.fullName}" was split as given "${name.given}", middle "${name.middle}", family "${name.family}"`
      );
    }
    return text(value, placeholder);
  };

  const resolve = (key: I90FormFirmValue): ResolvedFirmValue => {
    switch (key) {
      case "firm_name":
        return text(firm?.legalName, "[FIRM NAME]");
      case "firm_street_number_and_name":
        return addressPart(address.street, "[FIRM STREET ADDRESS]");
      case "firm_unit_number":
        // No unit is not a gap: the field stays blank.
        return { value: address.unitNumber ?? "" };
      case "firm_unit_is_apt":
        return { checked: address.unitType === "apt" };
      case "firm_unit_is_ste":
        return { checked: address.unitType === "ste" };
      case "firm_unit_is_flr":
        return { checked: address.unitType === "flr" };
      case "firm_city":
        return addressPart(address.city, "[FIRM CITY]");
      case "firm_state":
        return addressPart(address.state, "[FIRM STATE]");
      case "firm_zip_code":
        return addressPart(address.zip, "[FIRM ZIP CODE]");
      case "firm_phone":
        return text(firm?.phone, "[FIRM PHONE]");
      case "firm_phone_digits":
        return digits(firm?.phone, "[FIRM PHONE]");
      case "firm_fax":
        // A firm without a fax leaves the field blank; that is not a gap.
        return { value: firm?.fax ?? "" };
      case "firm_fax_digits":
        return { value: firm?.fax ? firm.fax.replace(/\D/g, "") : "" };
      case "firm_email":
        return text(firm?.email, "[FIRM EMAIL]");
      case "signer_full_name":
        return text(signer?.fullName, "[ATTORNEY NAME]");
      case "signer_family_name":
        return namePart(name?.family, "[ATTORNEY FAMILY NAME]");
      case "signer_given_name":
        return namePart(name?.given, "[ATTORNEY GIVEN NAME]");
      case "signer_middle_name":
        // Many names have none: blank, not a placeholder.
        return { value: name?.middle ?? "" };
      case "signer_licensing_authority":
        return text(signer?.barState, "[LICENSING AUTHORITY]");
      case "signer_bar_number":
        return text(signer?.barNumber, "[ATTORNEY BAR NUMBER]");
      case "signer_eoir_id":
        return text(signer?.eoirId, "[EOIR ID]");
      case "signer_email":
        return text(signer?.email, "[ATTORNEY EMAIL]");
      case "signer_is_attorney":
        return { checked: signer?.role === "attorney" };
      case "signer_is_accredited_representative":
        return { checked: signer?.role === "accredited_representative" };
    }
  };
  return { resolve, placeholders, derived };
}

type CompletedFill = {
  spec: I90FormFillSpec;
  firmValueCount: number;
  notes: string[];
};

/**
 * The script's spec from the model's entries: each firm_value replaced by the
 * value or checkbox state the server resolved from the run's firm identity,
 * every typed value checked for firm details. The signer is the default
 * signer, or the roster entry the model names by id when the case note names
 * that person too (resolveSigner, tools/shared/signer.ts).
 */
function completeFillSpec(request: I90FormFillInput, ctx: ToolExecutionContext): CompletedFill | { error: string } {
  const identity = ctx.firmIdentity;
  const chosen = resolveSigner(ctx, request.signer_attorney_id, "signer_attorney_id");
  if ("error" in chosen) return chosen;
  const signer = chosen.signer;
  const firmValues = firmValueResolver(identity, signer);

  const errors: string[] = [];
  const fields: I90FormFillSpec["fields"] = [];
  let firmValueCount = 0;
  let usesSigner = false;
  for (const entry of request.fields ?? []) {
    const given = (["value", "checked", "state", "firm_value"] as const).filter((key) => entry[key] !== undefined);
    if (given.length !== 1) {
      errors.push(`${entry.name}: give exactly one of value, checked, state or firm_value (got ${given.join(", ") || "none"}).`);
      continue;
    }
    if (entry.firm_value !== undefined) {
      firmValueCount++;
      if (entry.firm_value.startsWith("signer_")) usesSigner = true;
      fields.push({ name: entry.name, ...firmValues.resolve(entry.firm_value) });
      continue;
    }
    if (entry.value !== undefined) {
      const detail = firmDetailIn(entry.value, identity);
      if (detail) {
        errors.push(
          `${entry.name}: the value carries ${detail}. Firm and representative details are filled by the app: give the matching firm_value instead.`
        );
        continue;
      }
      fields.push({ name: entry.name, value: entry.value });
    } else if (entry.checked !== undefined) {
      fields.push({ name: entry.name, checked: entry.checked });
    } else {
      fields.push({ name: entry.name, state: entry.state });
    }
  }
  if (errors.length > 0) {
    const more = errors.length - MAX_ENTRY_ERRORS;
    return {
      error: `Not filled: ${errors.slice(0, MAX_ENTRY_ERRORS).join(" ")}${more > 0 ? ` ... and ${more} more.` : ""} Call again with corrected fields.`,
    };
  }
  const spec = i90FormFillSpecSchema.safeParse({ fields });
  if (!spec.success) return { error: `Could not complete the fill: ${spec.error.message}` };

  const notes: string[] = [];
  if (firmValueCount > 0) {
    const firmName = identity?.firm?.legalName ?? "[FIRM NAME]";
    notes.push(
      usesSigner && signer
        ? `The app filled ${firmValueCount} field(s) from the firm identity: ${firmName}, with ${signer.fullName} (${signer.role === "accredited_representative" ? "accredited representative" : "attorney"}) as the representative.`
        : `The app filled ${firmValueCount} field(s) from the firm identity of ${firmName}.`
    );
    if (usesSigner && !signer) notes.push("No default signer is set on the firm's roster, so the representative's details are placeholders.");
    if (firmValues.derived.size > 0) {
      notes.push(`Derived from the firm identity: ${[...firmValues.derived].join("; ")}. Check these on the rendered pages and flag any that is wrong.`);
    }
    if (firmValues.placeholders.size > 0) {
      notes.push(
        `The firm identity is incomplete, so the form carries ${[...firmValues.placeholders].join(", ")}. ` +
          "Flag in your report that the firm identity setup is incomplete and that these must be filled before the form is filed."
      );
    }
  }
  return { spec: spec.data, firmValueCount, notes };
}

// ---------------------------------------------------------------- results

/** One inspected field as a line: full name | type | page | tooltip | details. */
function formatField(field: InspectedField): string {
  const details: string[] = [];
  if (field.max_length !== undefined) details.push(`max ${field.max_length} characters`);
  if (field.multiline) details.push("multiline");
  if (field.states) details.push(`states: ${field.states.join(", ") || "none"}`);
  if (field.options) details.push(`options: ${field.options.join(", ")}`);
  if (field.editable) details.push("other values allowed");
  if (field.read_only) details.push("read-only");
  if (field.signature) details.push("SIGNATURE, never filled");
  if (field.value) details.push(`prefilled: ${field.value}`);
  return [
    field.name,
    field.type,
    field.page ? `p${field.page}` : "p?",
    field.tooltip || "(no tooltip)",
    ...(details.length ? [details.join("; ")] : []),
  ].join(" | ");
}

function formatInspection(report: InspectReport, form: string, blank: BlankForm): string {
  const formKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const otherForms = report.form_numbers.filter((f) => formKey(f) !== formKey(form));
  const header = [
    `Blank Form ${form}: ${blank.source} (sha256 ${blank.sha256.slice(0, 16)}), ${report.page_count} page(s).`,
    report.edition_text.length > 0
      ? `Edition printed on the form: ${report.edition_text.join("; ")}. Confirm on uscis.gov that it is the current edition.`
      : "No edition line could be read from the form's first or last page: confirm the edition from the form's page on uscis.gov and the rendered pages.",
    report.form_numbers.length > 0 && otherForms.length === report.form_numbers.length
      ? `Its first page names ${report.form_numbers.map((f) => `Form ${f}`).join(", ")}, not Form ${form}: check that this is the right blank form.`
      : "",
    report.has_xfa ? "It is a hybrid XFA form: filling removes the XFA data so every viewer shows the filled fields." : "",
    ...report.warnings,
    `${report.field_count} fillable field(s)${report.pushbuttons_skipped ? ` (${report.pushbuttons_skipped} buttons such as Print or Clear left out)` : ""}, one per line as: full name | type | page | the form's tooltip | details. Fill each by its full name exactly as written here.`,
  ];
  return [...header.filter(Boolean), "", ...report.fields.map(formatField)].join("\n");
}

function formatFillResult(params: {
  documentId: string;
  fileName: string;
  pageCount: number;
  form: string;
  blank: BlankForm;
  report: FillReport;
  completed: CompletedFill;
}): string {
  const { report } = params;
  const blankList = report.blank_text_fields.join(", ");
  return [
    `Filled Form ${params.form}: document_id ${params.documentId} ("${params.fileName}", ${params.pageCount} page(s)), from ${params.blank.source} (sha256 ${params.blank.sha256.slice(0, 16)}).`,
    `${report.filled} field(s) filled, ${params.completed.firmValueCount} of them from the firm identity.`,
    ...params.completed.notes,
    report.blank_text_field_count > 0
      ? `Text and choice fields still blank (${report.blank_text_field_count}${report.blank_text_field_count > report.blank_text_fields.length ? `, first ${report.blank_text_fields.length} listed` : ""}): ${blankList}.`
      : "No text or choice field is blank.",
    `Checkboxes and radio groups left unset: ${report.unset_checkboxes_and_radios}.`,
    report.signature_fields_left_blank.length > 0
      ? `Signature fields left blank for the signer: ${report.signature_fields_left_blank.join(", ")}.`
      : "",
    report.removed.length > 0 ? `Removed from the blank form: ${report.removed.join("; ")}.` : "",
    "Call render_and_qa_docx with this document_id to look at the filled pages, and check them against your answer table. Each fill saves a new document: refill only to fix a problem, and report only the final document_id.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------- the tool

async function executeFillUscisFormPdf(input: unknown, ctx: ToolExecutionContext) {
  const fail = (content: string) => ({ content, isError: true });
  const parsed = i90FormFillInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail(`Input validation failed: ${parsed.error.message}. Call fill_uscis_form_pdf again with corrected input.`);
  }
  const request = parsed.data;
  const url = request.blank_form_url?.trim() ?? "";
  const documentRef = request.blank_form_document?.trim() ?? "";
  if (url && documentRef) {
    return fail(
      "Give blank_form_url or blank_form_document, not both. Leave both out to take the form from its uscis.gov page."
    );
  }

  let completed: CompletedFill | null = null;
  if (request.action === "fill") {
    if (!request.fields?.length) {
      return fail("fill needs fields: one entry per field to fill, by the full names action inspect listed.");
    }
    const completion = completeFillSpec(request, ctx);
    if ("error" in completion) return fail(completion.error);
    completed = completion;
  }

  const blank = documentRef
    ? await loadBlankFormDocument(documentRef, ctx)
    : await fetchBlankFormPdf(url || FORM_PAGE_URLS[request.form], request.form, ctx);
  if (typeof blank === "string") return fail(blank);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "formfill-"));
  let keepWorkDir = false;
  try {
    await fs.writeFile(path.join(workDir, BLANK_FORM_FILE), blank.bytes);

    let outcome: Awaited<ReturnType<typeof runFormScript>>;
    if (!completed) {
      try {
        outcome = await runFormScript(["inspect", BLANK_FORM_FILE], workDir);
      } catch (err) {
        return fail(`Could not read the blank form: ${describeFormToolError(err)}`);
      }
      if ("errors" in outcome) return fail(`Could not read the blank form: ${outcome.errors.join(" ")}`);
      const report = inspectReportSchema.safeParse(outcome.report);
      if (!report.success) return fail(`fill_uscis_form.py inspect printed an unexpected report: ${report.error.message}`);
      const content = formatInspection(report.data, request.form, blank);
      // The field list stays in every later request of the run.
      if (!chargeRequestBytes(ctx, content)) {
        return fail(
          "The field list does not fit: the conversation is too close to the API's request size limit. Report the filled form as not generated, and why."
        );
      }
      return { content };
    }

    await fs.writeFile(path.join(workDir, SPEC_FILE), JSON.stringify(completed.spec, null, 2), "utf-8");
    try {
      outcome = await runFormScript(["fill", BLANK_FORM_FILE, SPEC_FILE, FILLED_FORM_FILE], workDir);
    } catch (err) {
      return fail(`Python form fill failed: ${describeFormToolError(err)}`);
    }
    if ("errors" in outcome) {
      return fail(`Not filled, nothing was saved: ${outcome.errors.join(" ")} Call again with corrected fields.`);
    }
    const report = fillReportSchema.safeParse(outcome.report);
    if (!report.success) return fail(`fill_uscis_form.py fill printed an unexpected report: ${report.error.message}`);

    const pdfPath = path.join(workDir, FILLED_FORM_FILE);
    const pdfBytes = await readToolOutput(pdfPath, { maxBytes: TOOL_OUTPUT_LIMITS.document });
    let pageImagePaths: string[];
    try {
      pageImagePaths = await rasterizePdfPages(workDir, pdfPath);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    // The blank form, the spec and the filled PDF's working copy are not
    // kept; the page images are, for render_and_qa_docx.
    await removeAllButPageImages(workDir);

    const fileName = safePdfFileName(request.file_name, `Form ${request.form} - DRAFT`);
    const row = await createGeneratedDocument({
      tenantId: ctx.tenantId,
      matterId: ctx.matterId,
      fileName,
      contentType: PDF_MIME,
      body: pdfBytes,
      uploadedBy: ctx.requestedBy,
      type: "generated_draft",
    });
    // From here on the work directory belongs to the stored document's entry,
    // and cleanupGeneratedDocuments removes it at the end of the run.
    ctx.generatedDocuments.set(row.id, { documentRowId: row.id, pageImagePaths, workDir, origin: "generated" });
    keepWorkDir = true;

    const content = formatFillResult({
      documentId: row.id,
      fileName,
      pageCount: pageImagePaths.length,
      form: request.form,
      blank,
      report: report.data,
      completed,
    });
    // The document is stored either way; an oversized note must not hide its id.
    chargeRequestBytes(ctx, content);
    return { content };
  } finally {
    if (!keepWorkDir) await cleanupWorkDir(workDir);
  }
}

export const fillUscisFormPdfTool: SkillTool = {
  definition: {
    name: "fill_uscis_form_pdf",
    description:
      "Fill the official fillable PDF of Form I-90 or Form G-28 (SECTION 7 items 5 and 6) and save it to the matter's documents. It is the only way to produce the filled forms here; never draft a form as a Word document. " +
      "Two steps per form. (1) action inspect, with form. By default the app takes the blank form from uscis.gov itself: it opens the form's page (https://www.uscis.gov/i-90 or https://www.uscis.gov/g-28), finds the link to the form's fillable PDF in the page's HTML (fetch_uscis_page shows you text only, so you never need the PDF's address), and downloads it, so the edition is the one USCIS publishes now; the download is scanned for malware before it is opened, and one that does not scan clean is not used. Give blank_form_url only to name another uscis.gov page that links the form, or a PDF link a failed call listed; give blank_form_document instead for a blank form the attorney uploaded to the matter (its id, or its file name exactly as its label shows it). It returns the edition printed on the form and every fillable field: its full name, type, page, the form's own tooltip (which names the part and item), length limit, and checkbox states or options. " +
      "(2) action fill, with the same form and the same blank form source plus fields (the run reuses the file inspect downloaded): one entry per field to fill, by its full name exactly as inspect listed it, with value (text and choice fields: the answer exactly as in your answer table, plain ASCII, None or N/A for a truthful negative), checked (checkboxes) or state (radio groups, and checkboxes with several states). " +
      "For a field that holds the firm's or the representative's details (the G-28's attorney or representative blocks, the I-90 Part 7 preparer block) give firm_value instead: the app fills it from the firm identity in the FIRM IDENTITY section, for the default signer unless signer_attorney_id names another roster member. A typed value carrying the firm's or a roster member's name, bar number, EOIR ID, email or phone is refused. " +
      "Signature fields are never filled and no form is signed: leave the signature and its date for the signer, as SECTION 5 and item 5 say. An unknown field name, an answer longer than its field holds, or a value that is not one of a choice field's options is refused with the reason, and nothing is saved until the whole fill is valid. " +
      "fill returns a document_id and the fields still blank: then call render_and_qa_docx with the document_id to look at the filled pages and check them against your answer table. Each fill saves a new document: refill only to fix a problem, and report only the final document_id. " +
      "Every request it makes to uscis.gov (the form's page and its PDF) is written to the run's verification log with the hash of what came back.",
    input_schema: toJsonSchemaObject(i90FormFillInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeFillUscisFormPdf,
};

/**
 * i90-packet-build's QA gate (SECTION 8: "run i90-packet-review over your own
 * output and append its report"): loads i90-packet-review's instructions as
 * seeded. Tool key load_qa_gate_skill_i90_packet_review; the model sees it as
 * load_qa_gate_skill.
 */
export const loadI90PacketReviewTool: SkillTool = createQaGateSkillTool({
  toolName: "load_qa_gate_skill",
  companionSkill: "i90-packet-review",
  description:
    "Load the firm's i90-packet-review skill: the QA gate your SKILL.md SECTION 8 says to run over your own output. " +
    "Call it once, after the I-90 and G-28 are filled and the cover letter and client instruction sheet are generated, and you have checked their pages with render_and_qa_docx. " +
    "It returns that skill's instructions. Review the packet under them, as that skill's reviewer, put its report in qaGateReport, and what you resolved or left open in qaGateResolution. " +
    "If the build stopped at the scope or a routing gate (routingDetermination.buildProceeded false), no packet was assembled and there is nothing to review: do not call it, and omit qaGateReport. Takes no input.",
  unavailableInstruction:
    "Run the QA gate yourself: review the packet against your own SKILL.md (SECTIONS 1 to 6), fill qaGateReport in the shape its schema gives (i90-packet-review's report format, items 1 to 13), " +
    "and put in qaGateReport.escalationFlags that the i90-packet-review skill itself could not be loaded and must be run separately on this matter.",
  runNotes: [
    "You are now the reviewer this skill hands its output to. Apply the instructions below to the packet you built in this run: the answer table, the filled I-90 and G-28 (fill_uscis_form_pdf), the cover letter and client instruction sheet (generate_document), the evidence index, and the fee and filing checklist.",
    "Its \"Before anything\" basics come from the matter documents in the first message and the attorney's case note: a basic they do not confirm is not provided. The packet under review is what this run built; a component it did not build (fee payment, signed forms, the client file copy, proof of mailing) is not provided.",
    "The forms are unsigned by design: fill_uscis_form_pdf never fills a signature field, and the signatures are the client's and the representative's own. Report signatures the way the review's report format says.",
    "Its run-time verification uses fetch_uscis_page. Rely on the uscis.gov pages you already fetched in this run, and fetch only what you have not yet checked.",
    "Review the documents as built: the inputs you passed to fill_uscis_form_pdf and generate_document and the pages render_and_qa_docx showed you. If you fix anything after this review, rebuild it, run the review's checks against the new document, and report only the final document ids, so the report describes the documents the attorney opens.",
    "Put the review's report in qaGateReport, item for item (its Report format items 1 to 13), and in qaGateResolution the blocking items you resolved, those still open, and whether the packet is filing ready. The app prints the work-product header.",
    "Its text was written for the same firm as your own skill text, and the FIRM IDENTITY section in your instructions applies to it in the same way.",
  ],
});
