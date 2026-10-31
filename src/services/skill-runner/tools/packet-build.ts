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
// Types only: tools.ts imports this module for its registry.
import type { SkillTool, ToolExecutionContext } from "../tools";
import { loadCompanionSkillText } from "./companion-skills";
import { ESQUIRE, nationalPhoneDigits, normalizeText } from "./shared/firm-values";
import { chargeRequestBytes } from "./shared/request-bytes";
import { resolveSigner } from "./shared/signer";
import {
  describeFormToolError,
  downloadBlankForm,
  findMatterDocument,
  removeAllButPageImages,
  safePdfFileName,
  sha256,
} from "./shared/uscis-forms";

// packet-build's three tools. The skill is the orchestrator of the firm's
// asylum skills, and two of its steps need something the generic tools do
// not give it:
//
// - references/i589-guide.md "Step 3: Fill the PDF" fills the official
//   fillable I-589 with the pdf skill. list_pdf_form_fields and
//   fill_pdf_form stand in for it, around
//   src/services/docx-generator/templates/packet-build/pdf_form.py (pypdf),
//   run sandboxed. Their tool keys carry a _packet_build suffix because
//   vawa-packet-build registers its own, differently shaped tools under
//   _vawa keys; the model sees the bare names in both skills (a model-facing
//   name only has to be distinct within one skill). The blank form follows
//   the guide's Step 1 order: first the copy the attorney provides, here a
//   matter document that passed the malware scan, read at its scanned
//   version; otherwise the current edition from the official USCIS I-589
//   page. That page is fetched here, not by the model (fetch_uscis_page
//   returns text without links), the link to the form's own PDF is taken
//   from its HTML, and the PDF is downloaded on fetch_uscis_page's
//   https-only, redirect-checked terms, both requests logged with their
//   hashes, then scanned with ClamAV before any parser reads it (a filled
//   copy is stored as clean, so the scan cannot be skipped); listing and
//   filling read the same download. That download logic is shared with the
//   I-90 and VAWA form tools (./shared/uscis-forms.ts). The filled form is
//   stored as a generated PDF on the matter, never flattened, and its
//   rendered pages are kept for render_and_qa_docx. Part E's preparer block
//   is the one part of the form that names the firm: the model says which
//   fields hold it, and the app fills them from the run's firm identity
//   (docs/ADDING_A_SKILL.md 2.8), never from the model's input; a typed
//   value that carries the firm's or a roster member's details is refused.
// - The build order runs the other asylum skills in sequence: "If a
//   companion skill is available in the environment, invoke it".
//   load_companion_skill makes them available: it returns a companion's
//   instructions as seeded (its latest skill_definitions version, the text a
//   separate run of that skill would send), with the lines that map it onto
//   this run, and the model performs that step under them. It shares
//   loadCompanionSkillText (./companion-skills.ts) with the QA-gate loaders,
//   for six companions and one step each instead of a single QA gate.

const SCRIPT_PATH = path.join(DOCX_TEMPLATES_DIR, "packet-build", "pdf_form.py");
const FORM_FILE = "form.pdf";
const FILLED_FILE = "filled.pdf";
const SPEC_FILE = "spec.json";
const PDF_MIME = "application/pdf";
// The I-589 is a dozen pages; anything near this is not a blank form (or
// its uscis.gov page).
const MAX_FORM_PDF_BYTES = 25 * 1024 * 1024;
const LIST_TIMEOUT_MS = 60_000;
const FILL_TIMEOUT_MS = 120_000;
// The official USCIS I-589 form page (references/i589-guide.md Step 1),
// which links the current fillable PDF and its instructions. Used when the
// model names no other source.
const I589_PAGE_URL = "https://www.uscis.gov/i-589";

// ---------------------------------------------------------------- the blank form

/** The blank form a call reads: its bytes, and where they came from for the result text. */
type BlankForm = { bytes: Buffer; source: string; sha256: string; downloaded: boolean };

/** The attorney's blank form: a matter PDF that passed the malware scan, read at its scanned version. */
async function loadFormDocument(reference: string, ctx: ToolExecutionContext): Promise<BlankForm | string> {
  const doc = await findMatterDocument(reference, ctx);
  if (typeof doc === "string") return doc;
  if (doc.malwareScanStatus !== "clean") {
    return `"${doc.fileName}" has not passed the malware scan (status: ${doc.malwareScanStatus}), so it is not opened. Only documents that scanned clean are used.`;
  }
  const byName = detectFileKind({ mimeType: doc.mimeType, fileName: doc.fileName });
  if (byName.kind !== "pdf" && byName.kind !== "other") {
    return `"${doc.fileName}" is not a PDF. The form must be the official fillable PDF.`;
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
    return `"${doc.fileName}" is not a PDF by its content. The form must be the official fillable PDF.`;
  }
  return { bytes, source: `matter document "${doc.fileName}" (document_id ${doc.id})`, sha256: sha256(bytes), downloaded: false };
}

/**
 * The current blank fillable I-589 from uscis.gov, scanned clean (the
 * guide's Step 1, second preference). rawUrl is the I-589 page (the
 * default) or another uscis.gov page that links the form, whose HTML gives
 * the PDF's address, or the PDF itself. The run reuses a download
 * (downloadBlankForm), so listing and filling read the same file.
 */
async function fetchBlankI589(rawUrl: string, ctx: ToolExecutionContext): Promise<BlankForm | string> {
  const notUsed = (why: string) =>
    `${why} Use the blank fillable I-589 the attorney uploaded to the matter (document) if there is one; otherwise deliver the full answer table, set the PDF fill as pending the current blank form in your report, and say the attorney must provide it.`;

  const download = await downloadBlankForm({ rawUrl, form: "I-589", maxBytes: MAX_FORM_PDF_BYTES, logTag: "packet-build" }, ctx);
  if (download.ok) return { ...download.blank, downloaded: true };
  const failure = download.failure;
  switch (failure.kind) {
    case "fetch_failed":
      return notUsed(failure.message);
    case "no_single_form_link":
      return notUsed(
        `${failure.page.toString()} is a web page, and ` +
          (failure.formPdfCount > 1
            ? `it links ${failure.formPdfCount} files named i-589.pdf: ${failure.listed.join(", ")}. If one is the current fillable Form I-589, call again with blank_form_url set to it.`
            : `it links no file named i-589.pdf on uscis.gov` +
              (failure.listed.length > 0
                ? `; the PDFs it links are ${failure.listed.join(", ")}. If one of them is the fillable Form I-589, call again with blank_form_url set to it.`
                : ".")) +
          (rawUrl === I589_PAGE_URL ? "" : ` Leave blank_form_url out to use ${I589_PAGE_URL}.`)
      );
    case "linked_file_not_pdf":
      return notUsed(`${failure.pdf.toString()}, the Form I-589 PDF link on ${failure.page.toString()}, did not return a PDF.`);
    case "scan_failed":
      return notUsed(
        `The blank Form I-589 downloaded from ${failure.blank.source} (sha256 ${failure.blank.sha256.slice(0, 16)}) is not used: it did not pass the malware scan (${failure.problem}).`
      );
  }
}

/**
 * The blank form a call names: the attorney's upload when document is
 * given, otherwise the current one from uscis.gov (the I-589 page, or
 * blank_form_url).
 */
async function loadBlankForm(
  source: { document?: string; blank_form_url?: string },
  ctx: ToolExecutionContext
): Promise<BlankForm | string> {
  const documentRef = source.document?.trim() ?? "";
  const url = source.blank_form_url?.trim() ?? "";
  if (documentRef && url) {
    return "Give document or blank_form_url, not both. Use document for a blank form uploaded to the matter; leave both out to take the current form from the USCIS I-589 page.";
  }
  return documentRef ? loadFormDocument(documentRef, ctx) : fetchBlankI589(url || I589_PAGE_URL, ctx);
}

/** What the result says about where the blank form came from. */
function blankFormNote(blank: BlankForm): string {
  return blank.downloaded
    ? "No blank form from the attorney was used: this is the current blank I-589 downloaded from uscis.gov in this run (references/i589-guide.md Step 1, second preference). " +
        "Say so in your report: give this address in formI589.filledPdf.blankFormUsed, note that the current official form must be confirmed, and compare the edition printed on it with the one the USCIS I-589 page states (fetch_uscis_page)."
    : "";
}

/** Runs pdf_form.py sandboxed in workDir and returns the JSON object it printed. */
async function runPdfFormScript(args: string[], workDir: string, timeoutMs: number): Promise<unknown> {
  const { stdout } = await execUntrusted("python3", [SCRIPT_PATH, ...args], { workDir, timeoutMs });
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error(`pdf_form.py ${args[0]} printed no report: ${stdout.slice(0, 500)}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

// Where the blank form comes from, in the guide's Step 1 order. Both tools
// take the same source, so a fill reads the form its listing read.
const blankFormSourceFields = {
  document: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe(
      "The blank fillable I-589 the attorney uploaded to this matter (the first choice whenever there is one): its document id, or its file name exactly as its document label shows it. Only a PDF that passed the malware scan can be used. Leave it out when none was uploaded, and the app takes the current form from the USCIS I-589 page."
    ),
  blank_form_url: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      `Only without document, and only to name another uscis.gov page that links the fillable I-589, or a PDF link a failed call listed. Leave it out to use ${I589_PAGE_URL}.`
    ),
};

// ---------------------------------------------------------------- list_pdf_form_fields

// What `pdf_form.py list` prints.
const listedFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  page: z.number().nullable(),
  tooltip: z.string(),
  value: z.string(),
  max_len: z.number().optional(),
  flags: z.array(z.string()).optional(),
  states: z.array(z.string()).optional(),
  options: z.array(z.object({ export: z.string(), label: z.string() })).optional(),
  rect: z.array(z.number()).optional(),
});
type ListedField = z.infer<typeof listedFieldSchema>;
const listReportSchema = z.object({
  page_count: z.number(),
  field_count: z.number(),
  fields: z.array(listedFieldSchema),
  form: z.string().nullable(),
  edition: z.string().nullable(),
  has_xfa: z.boolean(),
});

const listPdfFormFieldsInputSchema = z.object({
  ...blankFormSourceFields,
  first_page: z.number().int().min(1).optional().describe("Only fields on this page and after (default 1)."),
  last_page: z.number().int().min(1).optional().describe("Only fields up to this page (default: the last page)."),
});

// Choice options shown per field; a state list is longer than any form needs.
const MAX_OPTIONS_SHOWN = 80;

function fieldLine(field: ListedField): string {
  const details: string[] = [field.type];
  if (field.max_len !== undefined) details.push(`max ${field.max_len}`);
  for (const flag of field.flags ?? []) details.push(flag);
  if (field.states) details.push(`states: ${field.states.join(", ") || "none"} (or Off)`);
  if (field.options) {
    const shown = field.options.slice(0, MAX_OPTIONS_SHOWN).map((o) => (o.export === o.label ? o.export : `${o.export}=${o.label}`));
    details.push(`options: ${shown.join(", ")}${field.options.length > MAX_OPTIONS_SHOWN ? ", ..." : ""}`);
  }
  const value = field.value && field.value !== "Off" ? ` [current: ${field.value}]` : "";
  return `p${field.page ?? "?"} | ${field.name} | ${details.join("; ")} | ${field.tooltip || "(no tooltip)"}${value}`;
}

async function executeListPdfFormFields(input: unknown, ctx: ToolExecutionContext) {
  const parsed = listPdfFormFieldsInputSchema.safeParse(input);
  if (!parsed.success) {
    return { content: `Input validation failed: ${parsed.error.message}. Call list_pdf_form_fields again with corrected input.`, isError: true };
  }
  const { first_page: firstPage, last_page: lastPage } = parsed.data;
  if (firstPage !== undefined && lastPage !== undefined && lastPage < firstPage) {
    return { content: "last_page is before first_page.", isError: true };
  }

  const form = await loadBlankForm(parsed.data, ctx);
  if (typeof form === "string") return { content: form, isError: true };

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdfform-"));
  try {
    await fs.writeFile(path.join(workDir, FORM_FILE), form.bytes);
    let report: z.infer<typeof listReportSchema>;
    try {
      const raw = listReportSchema.safeParse(await runPdfFormScript(["list", FORM_FILE], workDir, LIST_TIMEOUT_MS));
      if (!raw.success) return { content: `pdf_form.py list printed an unexpected report: ${raw.error.message}`, isError: true };
      report = raw.data;
    } catch (err) {
      return { content: `Could not read the form fields of ${form.source}: ${describeFormToolError(err)}`, isError: true };
    }

    const from = firstPage ?? 1;
    const to = lastPage ?? report.page_count;
    const shown = report.fields.filter((f) => f.page === null || (f.page >= from && f.page <= to));
    const header = [
      `Form fields of ${form.source} (sha256 ${form.sha256.slice(0, 16)}): ` +
        `${report.form ? `Form ${report.form}` : "form number not found in the page text"}, ` +
        `${report.edition ? `edition ${report.edition} as printed on the form` : "no edition date found in the page text: read it from the form's footer"}. ` +
        `${report.page_count} page(s), ${report.field_count} field(s); showing pages ${from}-${to} (${shown.length} field(s)).`,
      blankFormNote(form),
      report.has_xfa
        ? "The form also carries an XFA layer; fill_pdf_form removes it so the filled values show in every viewer."
        : "",
      "One line per field, in page order, top to bottom: page | qualified name (pass it to fill_pdf_form exactly) | type; limits; states or options | tooltip (what the field is).",
      "",
    ].filter((line, i) => line || i === 4);
    const content = [...header, ...shown.map(fieldLine)].join("\n");

    if (!chargeRequestBytes(ctx, content)) {
      return {
        content: `The field list of pages ${from}-${to} does not fit: the conversation is too close to the API's request size limit. Ask for fewer pages at a time (first_page / last_page).`,
        isError: true,
      };
    }
    return { content };
  } finally {
    await cleanupWorkDir(workDir);
  }
}

/**
 * Tool key list_pdf_form_fields_packet_build; the model sees it as
 * list_pdf_form_fields.
 */
export const listPacketBuildPdfFormFieldsTool: SkillTool = {
  definition: {
    name: "list_pdf_form_fields",
    description:
      "List the fillable fields of the blank fillable I-589, as the first half of references/i589-guide.md \"Step 3: Fill the PDF\", which the skill's own environment does with the pdf skill. " +
      "The blank form follows the guide's Step 1 order: give document for the blank I-589 the attorney uploaded to the matter whenever there is one; leave it out when none was uploaded, and the app takes the current form from the official USCIS I-589 page itself (it reads the link to the form's PDF from the page's HTML, which fetch_uscis_page does not show you, downloads it, and scans it for malware before opening it; a download that does not scan clean is not used). Every request it makes to uscis.gov goes to the run's verification log with the hash of what came back. " +
      "Returns where the blank form came from, the form number and the edition date printed on it (compare it with the current edition on the official USCIS I-589 page, Step 1), then one line per field in page order: page, the fully qualified field name, its type (text, checkbox, radio, choice), maximum length, check box and radio states, choice options, and its tooltip, which says which form item the field is. " +
      "Map each answer-table entry to its field by the tooltip and page, then call fill_pdf_form with the same blank form source (the run reuses a download). Use first_page / last_page to list part of a long form.",
    input_schema: toJsonSchemaObject(listPdfFormFieldsInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeListPdfFormFields,
};

// ---------------------------------------------------------------- fill_pdf_form

// Part E preparer values the app supplies from the firm identity. The model
// names the form's field for each value it wants printed (the field names
// differ by edition); it never supplies the values.
const PREPARER_VALUES = [
  "full_name",
  "firm_name",
  "street",
  "unit",
  "city",
  "state",
  "zip",
  "phone",
  "phone_area_code",
  "phone_number",
  "email",
] as const;
type PreparerValue = (typeof PREPARER_VALUES)[number];

const PREPARER_VALUE_DESCRIPTIONS: Record<PreparerValue, string> = {
  full_name: "the preparer's full name",
  firm_name: "the firm's legal name",
  street: "street number and name",
  unit: "suite, floor or apartment",
  city: "city",
  state: "state (two-letter code)",
  zip: "ZIP code",
  phone: "the firm's phone number, whole",
  phone_area_code: "the phone's area code alone",
  phone_number: "the phone number without its area code",
  email: "the preparer's email, or the firm's",
};

const fillPdfFormInputSchema = z.object({
  ...blankFormSourceFields,
  file_name: z
    .string()
    .min(1)
    .max(120)
    .describe("File name for the matter's documents list, e.g. \"I-589 - DRAFT - filled.pdf\". Letters, digits, spaces, and . _ - ( ) only."),
  fields: z
    .array(
      z.object({
        name: z.string().min(1).max(500).describe("The field's qualified name, exactly as list_pdf_form_fields gives it"),
        value: z
          .string()
          .max(4000)
          .describe("Text for a text or choice field; for a check box or radio button, one of its states (or Off). An empty string clears the field."),
      })
    )
    .max(2000)
    .describe(
      "Every field the answer table answers. Leave out a field whose answer is a flagged gap (it stays blank), every signature field, and Part E's preparer fields (named in preparer.fields instead). A value carrying the firm's or a roster member's name, email, phone, street address, bar number or EOIR ID is refused."
    ),
  preparer: z
    .object({
      attorney_id: z
        .string()
        .optional()
        .describe("id of the roster entry (FIRM IDENTITY section) who prepared the form, when the attorney's note names someone other than the default signer (never on the strength of the matter's documents alone); omit for the default signer"),
      fields: z
        .object(
          Object.fromEntries(
            PREPARER_VALUES.map((key) => [
              key,
              z.string().min(1).max(500).optional().describe(`Qualified name of the field for ${PREPARER_VALUE_DESCRIPTIONS[key]}`),
            ])
          ) as Record<PreparerValue, z.ZodOptional<z.ZodString>>
        )
        .describe("Which Part E field holds each preparer value; give only the ones the form has"),
    })
    .optional()
    .describe("Part E, when someone at the firm prepared the form. The app prints the preparer's name and the firm's details from the firm identity into the fields named here; never put them in fields. Omit when the applicant prepared the form alone."),
});
type FillPdfFormInput = z.infer<typeof fillPdfFormInputSchema>;

// What `pdf_form.py fill` prints.
const fillReportSchema = z.union([
  z.object({ ok: z.literal(false), problem_count: z.number(), problems: z.array(z.string()) }),
  z.object({
    ok: z.literal(true),
    page_count: z.number(),
    set: z.number(),
    cleared: z.number(),
    skipped: z.array(z.string()),
    empty_or_unchecked_by_page: z.record(z.string(), z.number()),
    warnings: z.array(z.string()),
    form: z.string().nullable(),
    edition: z.string().nullable(),
  }),
]);

type ScriptField = { name: string; value: string; fit?: boolean };

const US_STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "puerto rico": "PR", guam: "GU", "virgin islands": "VI", "american samoa": "AS", "northern mariana islands": "MP",
};

function stateCode(raw: string): string | null {
  const value = raw.trim().replace(/\.$/, "");
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  return US_STATE_CODES[value.toLowerCase().replace(/\s+/g, " ")] ?? null;
}

const UNIT_PATTERN = /^(?:suite|ste\.?|unit|apt\.?|apartment|floor|fl\.?|room|rm\.?|#)\s*\S.*$/i;

/**
 * Street, unit, city, state and ZIP from the firm's free-form address lines
 * ("123 Main Street, Suite 400" / "City, ST 12345", or one line with
 * everything). Parts it cannot find are left out, and the field stays blank.
 */
function parseUsAddress(lines: string[]): Partial<Record<"street" | "unit" | "city" | "state" | "zip", string>> {
  const parts: Partial<Record<"street" | "unit" | "city" | "state" | "zip", string>> = {};
  if (lines.length === 0) return parts;
  let streetLines = lines;
  const last = lines[lines.length - 1].trim();
  const cityLine = /^(.+?),\s*([A-Za-z][A-Za-z .]*?)\s+(\d{5}(?:-\d{4})?)$/.exec(last);
  if (cityLine && lines.length > 1) {
    streetLines = lines.slice(0, -1);
    parts.city = cityLine[1].trim();
    const code = stateCode(cityLine[2]);
    if (code) parts.state = code;
    parts.zip = cityLine[3];
  } else {
    // Everything on one line: "street[, unit], city, ST 12345".
    const oneLine = /^(.+),\s*([^,]+),\s*([A-Za-z][A-Za-z .]*?)\s+(\d{5}(?:-\d{4})?)$/.exec(last);
    if (oneLine && lines.length === 1) {
      streetLines = [oneLine[1]];
      parts.city = oneLine[2].trim();
      const code = stateCode(oneLine[3]);
      if (code) parts.state = code;
      parts.zip = oneLine[4];
    }
  }
  const [first, second] = streetLines.map((l) => l.trim());
  if (first) {
    const pieces = first.split(/\s*,\s*/);
    const unitIndex = pieces.findIndex((p, i) => i > 0 && UNIT_PATTERN.test(p));
    if (unitIndex > 0) {
      parts.street = pieces.slice(0, unitIndex).join(", ");
      parts.unit = pieces.slice(unitIndex).join(", ");
    } else {
      parts.street = first;
    }
  }
  if (second && !parts.unit) parts.unit = second;
  return parts;
}

/** Area code and number of a US phone ("(713) 555-0100", "713.555.0100", "+1 713 555 0100"); null otherwise. */
function splitUsPhone(phone: string): { areaCode: string; number: string } | null {
  const national = nationalPhoneDigits(phone);
  if (national.length !== 10) return null;
  return { areaCode: national.slice(0, 3), number: `${national.slice(3, 6)}-${national.slice(6)}` };
}

const MAX_ENTRY_ERRORS = 50;

/** Whether normalized text holds phrase as whole words ("ann lee" is not in "joann leeds"). */
function containsPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text);
}

/**
 * Which firm or roster detail a typed value carries, or null. Those details
 * reach the form only through preparer.fields, filled by the app (2.8), so
 * the model cannot print another firm's or person's details as the
 * preparer. The checks of firmDetailIn in ./shared/firm-values.ts (the I-90
 * and VAWA form tools), with names matched as whole phrases, plus the two
 * other things Part E asks for: the firm's street, and its phone without the
 * area code.
 */
function firmDetailIn(value: string, identity: FirmIdentitySnapshot | null): string | null {
  const text = normalizeText(value);
  if (!text || !identity) return null;
  const firm = identity.firm;
  const firmName = normalizeText(firm?.legalName ?? "");
  if (firmName.length >= 5 && containsPhrase(text, firmName)) return "the firm's name";
  if (firm?.email && text === normalizeText(firm.email)) return "the firm's email";
  const street = normalizeText(parseUsAddress(firm?.addressLines ?? []).street ?? "");
  if (street.length >= 6 && containsPhrase(text, street)) return "the firm's street address";
  if (/^[\d\s().+-]+$/.test(value)) {
    const typed = nationalPhoneDigits(value);
    for (const number of [firm?.phone, firm?.fax]) {
      const firmDigits = nationalPhoneDigits(number ?? "");
      if (firmDigits.length < 7) continue;
      if (typed === firmDigits || (firmDigits.length === 10 && typed === firmDigits.slice(3))) {
        return "the firm's phone or fax number";
      }
    }
  }
  for (const attorney of identity.attorneys) {
    const name = normalizeText(attorney.fullName.replace(ESQUIRE, ""));
    if (name.length >= 5 && containsPhrase(text, name)) return `the name of ${attorney.fullName}, a roster member`;
    if (attorney.barNumber && attorney.barNumber.length >= 4 && text === normalizeText(attorney.barNumber)) {
      return "a roster member's bar number";
    }
    if (attorney.eoirId && attorney.eoirId.length >= 4 && text === normalizeText(attorney.eoirId)) {
      return "a roster member's EOIR ID";
    }
    if (attorney.email && text === normalizeText(attorney.email)) return "a roster member's email";
  }
  return null;
}

type CompletedPreparer = { fields: ScriptField[]; notes: string[] } | { error: string };

/**
 * The Part E values, from the run's firm identity (ctx.firmIdentity, the
 * snapshot its prompt shows): the preparer is the default signer, or the
 * roster entry the model names by id when the case note names that person too
 * (resolveSigner, tools/shared/signer.ts); the address and phone are the firm's.
 * A value the identity does not have leaves its field blank, and the notes
 * say so, so the report flags it. Values are marked "fit": the script may
 * drop punctuation to fit a field's boxes, and skips a field it still
 * overflows, rather than refusing the whole fill over a server value.
 */
function completePreparer(preparer: NonNullable<FillPdfFormInput["preparer"]>, ctx: ToolExecutionContext): CompletedPreparer {
  const identity = ctx.firmIdentity;
  const chosen = resolveSigner(ctx, preparer.attorney_id, "preparer.attorney_id");
  if ("error" in chosen) return chosen;
  const signer: FirmIdentitySnapshotAttorney | null = chosen.signer;
  const firm = identity?.firm ?? null;
  const address = parseUsAddress(firm?.addressLines ?? []);
  const phone = firm?.phone ? splitUsPhone(firm.phone) : null;
  const values: Record<PreparerValue, string | null> = {
    full_name: signer?.fullName ?? null,
    firm_name: firm?.legalName ?? null,
    street: address.street ?? null,
    unit: address.unit ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    zip: address.zip ?? null,
    phone: firm?.phone ?? null,
    phone_area_code: phone?.areaCode ?? null,
    phone_number: phone?.number ?? null,
    email: signer?.email ?? firm?.email ?? null,
  };

  const fields: ScriptField[] = [];
  const missing: string[] = [];
  for (const key of PREPARER_VALUES) {
    const fieldName = preparer.fields[key];
    if (!fieldName) continue;
    const value = values[key];
    if (value) {
      fields.push({ name: fieldName, value, fit: true });
    } else if (key !== "unit") {
      // A firm address without a suite is complete; anything else is a gap.
      missing.push(PREPARER_VALUE_DESCRIPTIONS[key]);
    }
  }

  const notes = [
    `The app filled Part E from the firm identity: preparer ${signer ? signer.fullName : "(none: no default signer on the roster)"}, ${firm?.legalName ?? "no firm details on file"}.`,
  ];
  if (missing.length > 0) {
    notes.push(
      `These Part E fields were left blank because the firm identity does not have them (or the address or phone could not be read as a US address): ${missing.join(", ")}. ` +
        "Flag in your report that the firm identity setup is incomplete and that Part E must be completed before filing."
    );
  }
  notes.push("The preparer signs Part E by hand on the printed form; the signature field is left empty.");
  return { fields, notes };
}

async function executeFillPdfForm(input: unknown, ctx: ToolExecutionContext) {
  const parsed = fillPdfFormInputSchema.safeParse(input);
  if (!parsed.success) {
    return { content: `Input validation failed: ${parsed.error.message}. Call fill_pdf_form again with corrected input.`, isError: true };
  }
  const content = parsed.data;

  // The firm's and the preparer's details reach the form only from the firm
  // identity (2.8): a typed value that carries one is refused, wherever it is.
  const firmDetailErrors = content.fields.flatMap((f) => {
    const detail = firmDetailIn(f.value, ctx.firmIdentity);
    return detail ? [`${f.name}: the value carries ${detail}.`] : [];
  });
  if (firmDetailErrors.length > 0) {
    const more = firmDetailErrors.length - MAX_ENTRY_ERRORS;
    return {
      content:
        `Nothing was filled. ${firmDetailErrors.slice(0, MAX_ENTRY_ERRORS).join(" ")}${more > 0 ? ` ... and ${more} more.` : ""} ` +
        "The firm's and the preparer's details are printed by the app from the firm identity: for a Part E field, name it in preparer.fields instead and leave it out of fields. " +
        "If the record gives such a value for another field (for example a mailing address in care of the firm, or a relative who shares a roster member's name), leave that field out, list it in formI589.filledPdf.fieldsLeftBlankForFollowUp with the reason, and the attorney completes it. " +
        "Then call fill_pdf_form again with the whole field list.",
      isError: true,
    };
  }

  let preparerFields: ScriptField[] = [];
  let preparerNotes: string[] = [];
  if (content.preparer) {
    const modelNames = new Set(content.fields.map((f) => f.name));
    const overlap = Object.values(content.preparer.fields).filter((name): name is string => !!name && modelNames.has(name));
    if (overlap.length > 0) {
      return {
        content: `These fields are named both in fields and in preparer.fields: ${overlap.join(", ")}. The app fills the preparer fields itself; remove them from fields.`,
        isError: true,
      };
    }
    const preparerNames = Object.values(content.preparer.fields).filter((name): name is string => !!name);
    if (new Set(preparerNames).size !== preparerNames.length) {
      return { content: "preparer.fields names the same form field for two different values.", isError: true };
    }
    const completed = completePreparer(content.preparer, ctx);
    if ("error" in completed) return { content: completed.error, isError: true };
    preparerFields = completed.fields;
    preparerNotes = completed.notes;
  }

  const form = await loadBlankForm(content, ctx);
  if (typeof form === "string") return { content: form, isError: true };

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdfform-"));
  let keepWorkDir = false;
  try {
    await fs.writeFile(path.join(workDir, FORM_FILE), form.bytes);
    const spec = {
      input: FORM_FILE,
      output: FILLED_FILE,
      fields: [...content.fields.map((f): ScriptField => ({ name: f.name, value: f.value })), ...preparerFields],
    };
    await fs.writeFile(path.join(workDir, SPEC_FILE), JSON.stringify(spec, null, 2), "utf-8");

    let report: z.infer<typeof fillReportSchema>;
    try {
      const raw = fillReportSchema.safeParse(await runPdfFormScript(["fill", SPEC_FILE], workDir, FILL_TIMEOUT_MS));
      if (!raw.success) return { content: `pdf_form.py fill printed an unexpected report: ${raw.error.message}`, isError: true };
      report = raw.data;
    } catch (err) {
      return { content: `Could not fill ${form.source}: ${describeFormToolError(err)}`, isError: true };
    }
    if (!report.ok) {
      return {
        content:
          `Nothing was filled: ${report.problem_count} field(s) were refused.\n- ${report.problems.join("\n- ")}` +
          `${report.problem_count > report.problems.length ? `\n- ... and ${report.problem_count - report.problems.length} more` : ""}\n` +
          "Fix these entries (list_pdf_form_fields shows each field's type, length and states) and call fill_pdf_form again with the whole field list.",
        isError: true,
      };
    }

    const filledPath = path.join(workDir, FILLED_FILE);
    const pdfBytes = await readToolOutput(filledPath, { maxBytes: TOOL_OUTPUT_LIMITS.document });
    let pageImagePaths: string[];
    try {
      pageImagePaths = await rasterizePdfPages(workDir, filledPath);
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
    // The blank form, the spec and the filled copy are not kept here (the
    // filled PDF is stored on the matter below); the page images are, for
    // render_and_qa_docx.
    await removeAllButPageImages(workDir);

    const fileName = safePdfFileName(content.file_name, "Filled form");
    const row = await createGeneratedDocument({
      tenantId: ctx.tenantId,
      matterId: ctx.matterId,
      fileName,
      contentType: PDF_MIME,
      body: pdfBytes,
      uploadedBy: ctx.requestedBy,
      type: "generated_draft",
    });
    // From here on the work directory belongs to this entry, and
    // cleanupGeneratedDocuments removes it at the end of the run.
    ctx.generatedDocuments.set(row.id, { documentRowId: row.id, pageImagePaths, workDir, origin: "generated" });
    keepWorkDir = true;

    const emptyByPage = Object.entries(report.empty_or_unchecked_by_page)
      .map(([page, count]) => `page ${page}: ${count}`)
      .join(", ");
    return {
      content: [
        `Filled form saved: document_id ${row.id} ("${fileName}", ${pageImagePaths.length} page(s)), from ${form.source} (sha256 ${form.sha256.slice(0, 16)})` +
          `${report.form ? ` (Form ${report.form}${report.edition ? `, edition ${report.edition}` : ""})` : ""}. ` +
          "The form is not flattened: every field stays editable for the attorney.",
        blankFormNote(form),
        `${report.set} field(s) set, ${report.cleared} cleared.${report.skipped.length ? ` Skipped (did not fit): ${report.skipped.join(", ")}.` : ""}`,
        emptyByPage ? `Fields still empty or unchecked: ${emptyByPage}. Check each is a flagged gap or a truthful blank (an unchecked box), not an omission.` : "",
        ...report.warnings.map((w) => `Warning: ${w}`),
        ...preparerNotes,
        "Call render_and_qa_docx with this document_id to look at the filled pages against the answer table. Each fill_pdf_form call stores a new PDF: refill only to fix a problem, with the whole field list, and report only the final document_id.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  } finally {
    if (!keepWorkDir) await cleanupWorkDir(workDir);
  }
}

/**
 * Tool key fill_pdf_form_packet_build; the model sees it as fill_pdf_form.
 */
export const fillPacketBuildPdfFormTool: SkillTool = {
  definition: {
    name: "fill_pdf_form",
    description:
      "Fill the blank fillable I-589 from your answer table and save the filled copy to the matter's documents: references/i589-guide.md \"Step 3: Fill the PDF\", which the skill's own environment does with the pdf skill. Call list_pdf_form_fields first for the field names, and give this call the same blank form source: document for the blank I-589 the attorney uploaded, or neither document nor blank_form_url to use the current form from the official USCIS I-589 page (the run reuses the download the listing made). " +
      "Pass every answered field by its qualified name: text as it should read (dates mm/dd/yyyy, the A-number as digits, None or N/A for a truthful negative), a check box or radio button by one of its states. Leave out flagged gaps (they stay blank for the attorney to complete with the client) and every signature field (the applicant and the preparer sign by hand). " +
      "Part E: when someone at the firm prepared the form, name the Part E fields in preparer.fields and the app prints the preparer's name and the firm's address, phone and email there from the firm identity; never type them into fields. A typed value carrying the firm's or a roster member's name, email, phone, street address, bar number or EOIR ID is refused, in any field. " +
      "Every entry is checked against the form first (unknown names, read-only or signature fields, values longer than the field's boxes, states a box does not have, characters the form cannot show); if any fails, nothing is filled and each problem is listed. " +
      "The form stays fillable (not flattened). Returns a document_id: call render_and_qa_docx with it to look at the filled pages. Each call saves a new PDF; report only the final document_id.",
    input_schema: toJsonSchemaObject(fillPdfFormInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeFillPdfForm,
};

// ---------------------------------------------------------------- load_companion_skill

// The companion skills SKILL.md "Build order" names, with the step each one
// is and what its output feeds in the packet-build report.
const COMPANIONS = {
  "claim-evaluation": {
    step: "step 1 (triage and theory)",
    notes: [
      "Its element scorecard becomes caseTheory.elementScorecard (Element | Rating | Basis | What would strengthen it | Authority anchor), its bars and escalation flags caseTheory.barsAndEscalationFlags, and the protected ground and relief it settles on caseTheory.protectedGround and caseTheory.relief, with the gaps that need client input in caseTheory.gapsNeedingClientInput. Its options for the attorney stay options: the attorney chooses.",
    ],
  },
  "declaration-draft": {
    step: "step 2 (declaration)",
    notes: [
      "The declaration, its signature block and any interpreter or translation certification are one Word document built with generate_document; its document_id goes in respondentDeclaration, and every [CLARIFY] flag in respondentDeclaration.clarifyFlags. Its consistency issues and corroboration notes feed the I-589 consistency pass, the corroboration gap list and the master action checklist.",
    ],
  },
  "country-conditions-research": {
    step: "step 3 (country-conditions support)",
    notes: [
      "Retrieve every source in this run with web_search and web_fetch. Each one goes in countryConditionsMemo.sources: title and publisher, publication date, the link exactly as retrieved, the claim it supports, and when this run fetched it; the cutoff in countryConditionsMemo.recencyCutoff, counted back from today's date as this run shows it (a date given in the request, or a web_fetch result's retrieved_at), never from memory. A claim with no qualifying source goes in the corroboration gap list, with whether an expert declaration or more research is recommended.",
    ],
  },
  "evidence-organizer": {
    step: "step 5 (evidence index and filing checklist)",
    notes: [
      "The exhibit index is a Word document in the firm's tabbing and house style, built with generate_document; its document_id and each exhibit, with the elements it supports, go in exhibitIndexAndChecklists.exhibitIndex. Its corroboration gaps, translation and certification to-do, and filing checklist go in the matching parts of exhibitIndexAndChecklists.",
      "Confirm the deadline, cover page, pagination and service rules on the live practice manual with fetch_uscis_page where you can; mark an authority verified only when you did.",
    ],
  },
  "brief-draft": {
    step: "step 6 (legal brief, only if requested)",
    notes: [
      "Only when the attorney asked for it or the practice profile calls for a pre-hearing brief or an Asylum Office statement. The brief is a Word document built with generate_document; its document_id, every authority and [CITE] placeholder, and its closing attorney checklist go in legalBrief.",
    ],
  },
  "packet-review": {
    step: "step 7 (the review pass, the final QA gate)",
    notes: [
      "You are now the reviewer of the packet this run assembled: the documents you generated (as built: the specs you passed and the pages render_and_qa_docx showed), the I-589 answer table and the filled I-589, and the exhibit index and checklists, read against the matter's documents. Review it in that skill's posture, not as the author of the draft.",
      "Its report goes in packetReviewReport, item for item (its Report format items 1 to 9). Its blocking issues, strongly recommended and optional edits also feed masterActionChecklist.",
      "If you correct a document after this review, generate it again, run the review's checks against the new version, and report only the final document ids, so the report describes what the attorney opens.",
    ],
  },
} as const;
type CompanionSkill = keyof typeof COMPANIONS;
const COMPANION_SKILLS = Object.keys(COMPANIONS) as [CompanionSkill, ...CompanionSkill[]];

const COMMON_COMPANION_NOTES = [
  "Answer whatever it says to establish first from the matter documents, the attorney's note, and what you settled under your own \"Before anything\" (venue, controlling circuit, the inventory of materials). A run cannot stop to ask: flag what cannot be established instead.",
  "Its output is not a separate deliverable here; it feeds the packet-build report as described above, and packet-build's two integrity rules govern it.",
  "Its text was written for the same firm as your own skill text, and the FIRM IDENTITY section in your instructions applies to it in the same way.",
];

const loadCompanionSkillInputSchema = z.object({
  skill: z.enum(COMPANION_SKILLS).describe("The companion skill to load"),
});

// Companions already loaded in a run (keyed by the run's tool context), so a
// second call does not resend the same instructions with every request.
const loadedCompanions = new WeakMap<ToolExecutionContext, Set<CompanionSkill>>();

async function executeLoadCompanionSkill(input: unknown, ctx: ToolExecutionContext) {
  const parsed = loadCompanionSkillInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      content: `Input validation failed: ${parsed.error.message}. Call load_companion_skill again with one of: ${COMPANION_SKILLS.join(", ")}.`,
      isError: true,
    };
  }
  const { skill } = parsed.data;
  const { step, notes } = COMPANIONS[skill];
  const failure = (reason: string) => ({
    content:
      `${reason} Perform packet-build ${step} inline from your own SKILL.md's description of it, ` +
      `and add to masterActionChecklist (strongly recommended) that the ${skill} skill could not be loaded in this run, so that step ran from packet-build's summary alone and ${skill} should be run separately on this matter.`,
    isError: true,
  });

  const loaded = loadedCompanions.get(ctx) ?? new Set<CompanionSkill>();
  if (loaded.has(skill)) {
    return { content: `${skill} was already loaded earlier in this run; its instructions are in that tool result above.` };
  }

  const result = await loadCompanionSkillText(ctx, {
    companionSkill: skill,
    heading: `How to run it as packet-build ${step} in this run`,
    notes: [...notes, ...COMMON_COMPANION_NOTES],
  });
  if ("error" in result) return failure(result.error);
  const { content } = result;

  loaded.add(skill);
  loadedCompanions.set(ctx, loaded);
  return { content };
}

/**
 * Tool key load_companion_skill_packet_build; the model sees it as
 * load_companion_skill.
 */
export const loadPacketBuildCompanionSkillTool: SkillTool = {
  definition: {
    name: "load_companion_skill",
    description:
      "Load one of the firm's companion asylum skills that your Build order says to invoke when available: claim-evaluation (step 1), declaration-draft (step 2), country-conditions-research (step 3), evidence-organizer (step 5), brief-draft (step 6, only if a brief is requested) and packet-review (step 7, the final QA gate). " +
      "Returns that skill's instructions as the firm seeded them, with notes on where its output goes in your report. Perform the step under them, here in this run. " +
      "Load each one when you reach its step (several may be loaded in one turn); one call per skill is enough, since its text stays in the conversation. If one cannot be loaded, perform that step inline as your SKILL.md describes it.",
    input_schema: toJsonSchemaObject(loadCompanionSkillInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeLoadCompanionSkill,
};
