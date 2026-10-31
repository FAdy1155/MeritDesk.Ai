import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { withTenantContext, type db } from "@/db/client";
import { documents } from "@/db/schema";
import { createGeneratedDocument, getMatterDocument } from "@/lib/documents/service";
import { detectFileKind } from "@/lib/documents/file-kind";
import { getSignerSignature, recordFirmSignatureApplied } from "@/lib/firm-identity/service";
import type { FirmIdentitySnapshotAttorney } from "@/lib/firm-identity/schema";
import { getObjectBytes } from "@/lib/s3";
import { execUntrusted, readToolOutput, TOOL_OUTPUT_LIMITS, writeWorkFile } from "@/services/sandbox/untrusted-exec";
import { libreOfficeSlots } from "@/services/queue/concurrency";
import { cleanupWorkDir, DOCX_TEMPLATES_DIR, rasterizePdfPages } from "@/services/docx-generator/generate";
import { toJsonSchemaObject } from "../json-schema";
import {
  asylumFeeProofPacketContentSchema,
  asylumFeeProofPacketSpecSchema,
  type AsylumFeeProofPacketContent,
  type AsylumFeeProofPacketSpec,
} from "../skills/asylum-fee-proof-packet";
// Types only: tools.ts imports this module for its registry.
import type { SkillTool, ToolExecutionContext } from "../tools";
import { resolveSigner, signatureImagesAllowed, SIGNATURE_IMAGE_WITHHELD_NOTE } from "./shared/signer";

/**
 * asylum-fee-proof-packet's packet builder, exposed to the model as
 * build_fee_packet. It stands in for the skill's shell steps (Step 1's
 * working copy, Step 2's `fee_packet.py read`, Step 4's config and
 * `fee_packet.py build`) around the multi-tenant copy of the firm's script,
 * src/services/docx-generator/templates/asylum-fee-proof-packet/fee_packet.py,
 * whose counsel block and signer come from the config instead of the script.
 *
 * Not createDocxGeneratorTool: the script has its own command line (read /
 * build), takes the receipt and order PDFs as inputs, and writes two
 * deliverables, the filing-ready PDF (with the original exhibit pages and
 * stamped page numbers) and the editable Word file. Both are stored on the
 * matter; render_and_qa_docx shows the PDF's pages for either id.
 *
 * What the model cannot control: the firm and signer fields (filled from
 * ctx.firmIdentity, the run's snapshot), the signature image (the signer's
 * stored image, checked by getSignerSignature, or a /s/ line), and the
 * exhibits (matter documents that passed the malware scan, read at their
 * scanned version). The receipt is read the way `fee_packet.py read` reads it
 * before anything is built, and a config that disagrees with it is refused.
 */

const SCRIPT_PATH = path.join(DOCX_TEMPLATES_DIR, "asylum-fee-proof-packet", "fee_packet.py");
const CONFIG_FILE = "config.json";
const RECEIPT_FILE = "receipt.pdf";
const ORDER_FILE = "order.pdf";
// The script's own output name; the stored documents take the model's file_stem.
const OUTPUT_STEM = "packet";
const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// A portal receipt is one page and an order a few; anything near this is not one.
const MAX_EXHIBIT_PDF_BYTES = 25 * 1024 * 1024;
const READ_TIMEOUT_MS = 60_000;
// Up to three LibreOffice conversions (the BIA format re-renders until the
// submission's page count settles), each of which the script allows 300 s.
const BUILD_TIMEOUT_MS = 600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// SKILL.md Step 3 dates the packet today. The model has no clock, so the app
// supplies the date, in US Central time as tools/eoir-written-pleadings.ts
// does (the firm identity stores no time zone).
const COURT_TIME_ZONE = "America/Chicago";
// The script's service blocks when dhs_lines is left out (DHS_IC / DHS_BIA in
// fee_packet.py): the original firm's Houston offices, named in the notes.
const DEFAULT_DHS_OFFICE: Record<AsylumFeeProofPacketContent["forum"], string> = {
  IC: "Office of the Principal Legal Advisor - HOU, Houston, TX",
  BIA: "DHS/ICE Office of Chief Counsel - HOU, Houston, TX",
};
// SKILL.md: never print the original firm's retired fax numbers.
const RETIRED_FAX_NUMBERS: { label: string; pattern: RegExp }[] = [
  { label: "(346) 553-8491", pattern: /\(?346\)?[\s.-]*553[\s.-]*8491/ },
  { label: "(281) 997-6207", pattern: /\(?281\)?[\s.-]*997[\s.-]*6207/ },
  { label: "(832) 530-4090", pattern: /\(?832\)?[\s.-]*530[\s.-]*4090/ },
];

// What `fee_packet.py read` prints (its "source" path is left out on purpose).
const receiptReadSchema = z.object({
  a_number: z.string().optional(),
  tracking_id: z.string().optional(),
  processed_on: z.string().optional(),
  pay_date: z.string().optional(),
  payment_type: z.string().optional(),
  amount: z.string().optional(),
  filing_type: z.string().optional(),
  fee_kind: z.string().optional(),
  pages: z.number().optional(),
  page_size: z.array(z.number()).optional(),
  warning: z.string().optional(),
});
type ReceiptRead = z.infer<typeof receiptReadSchema>;

// What `fee_packet.py build` prints (its "pdf" / "docx" paths are not used:
// the outputs are read from the work directory by their fixed names).
const buildReportSchema = z.object({
  pages: z.array(z.object({ page: z.number(), part: z.string(), number: z.string().nullable() })),
  index: z.record(z.string(), z.string()),
  page_number_problems: z.array(z.string()),
  a_number_mentions: z.number(),
  tracking_id_in_letter: z.boolean(),
  special_characters: z.array(z.string()),
  warnings: z.array(z.string()),
  firm_fax_mentions: z.number().nullable(),
  retired_fax_mentions: z.number(),
});
type BuildReport = z.infer<typeof buildReportSchema>;

type MatterDocument = {
  id: string;
  fileName: string;
  mimeType: string | null;
  malwareScanStatus: string;
  s3Bucket: string;
  s3Key: string;
  s3VersionId: string | null;
  version: number;
  createdAt: Date;
};

/**
 * One of this matter's documents, named by the model by id or by file name
 * (the document labels show file names; the inventory also lists each document_id). Returns an error the
 * model can act on instead of throwing.
 */
async function findMatterDocument(reference: string, ctx: ToolExecutionContext): Promise<MatterDocument | string> {
  // The label quotes the file name; take it with or without the quotes.
  const ref = reference.trim().replace(/^"(.*)"$/, "$1").trim();
  if (UUID.test(ref)) {
    const doc = await getMatterDocument(ctx.tenantId, ctx.matterId, ref);
    return doc ?? `No document with id ${ref} is on this matter.`;
  }
  const rows: MatterDocument[] = await withTenantContext(ctx.tenantId, (tx) =>
    tx
      .select({
        id: documents.id,
        fileName: documents.fileName,
        mimeType: documents.mimeType,
        malwareScanStatus: documents.malwareScanStatus,
        s3Bucket: documents.s3Bucket,
        s3Key: documents.s3Key,
        s3VersionId: documents.s3VersionId,
        version: documents.version,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(
        and(eq(documents.tenantId, ctx.tenantId), eq(documents.matterId, ctx.matterId), eq(documents.fileName, ref))
      )
      .orderBy(desc(documents.createdAt))
  );
  if (rows.length === 0) {
    return `No document named "${ref}" is on this matter. Give the file name exactly as the document's label shows it, or the document's id.`;
  }
  const clean = rows.filter((r) => r.malwareScanStatus === "clean");
  if (clean.length === 1) return clean[0];
  if (clean.length === 0) return rows[0]; // refused below, with its scan status
  return (
    `Several documents on this matter are named "${ref}": ` +
    clean.map((r) => `id ${r.id} (version ${r.version}, uploaded ${r.createdAt.toISOString().slice(0, 10)})`).join("; ") +
    ". Call build_fee_packet again with the id of the one to use."
  );
}

/** A matter PDF for an exhibit (the receipt, the order): clean, a PDF by content, read at its scanned version. */
async function loadExhibitPdf(
  reference: string,
  what: string,
  ctx: ToolExecutionContext
): Promise<{ doc: MatterDocument; bytes: Buffer } | string> {
  const doc = await findMatterDocument(reference, ctx);
  if (typeof doc === "string") return `${what}: ${doc}`;
  if (doc.malwareScanStatus !== "clean") {
    return `${what}: "${doc.fileName}" has not passed the malware scan (status: ${doc.malwareScanStatus}), so it cannot be attached. Only documents that scanned clean are used.`;
  }
  const byName = detectFileKind({ mimeType: doc.mimeType, fileName: doc.fileName });
  if (byName.kind !== "pdf" && byName.kind !== "other") {
    return `${what}: "${doc.fileName}" is not a PDF. The packet attaches PDFs only; the attorney must upload the ${what.toLowerCase()} as a PDF.`;
  }
  let bytes: Buffer;
  try {
    // The version the malware scan read, never bytes written to the key since.
    bytes = await getObjectBytes({
      bucket: doc.s3Bucket,
      key: doc.s3Key,
      versionId: doc.s3VersionId,
      maxBytes: MAX_EXHIBIT_PDF_BYTES,
    });
  } catch (err) {
    return `${what}: could not read "${doc.fileName}": ${err instanceof Error ? err.message : String(err)}`;
  }
  if (detectFileKind({ bytes, mimeType: doc.mimeType, fileName: doc.fileName }).kind !== "pdf") {
    return `${what}: "${doc.fileName}" is not a PDF by its content. The packet attaches PDFs only.`;
  }
  return { doc, bytes };
}

function describeExecError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
    return "required binary not found on PATH (python3, soffice, pdftoppm and qpdf must be installed on the worker image)";
  }
  if (err instanceof Error) {
    const withOutput = err as Error & { stderr?: string; stdout?: string };
    const output = withOutput.stderr?.trim() || withOutput.stdout?.trim() || err.message;
    // Windows ships a "python3" that only opens the Microsoft Store.
    if (/Python was not found/i.test(output)) {
      return "python3 is not installed on this machine (only the Windows Store alias is); the packet is built on the worker image";
    }
    // A worker image built without the packet's dependencies (requirements.txt,
    // qpdf in Dockerfile.worker): name the setup problem, so the run reports it
    // instead of retrying the build with other inputs.
    const missingModule = /ModuleNotFoundError: No module named '([^']+)'/.exec(output);
    if (missingModule) {
      return `the worker image is missing the Python package "${missingModule[1]}" (the fee packet needs pdfplumber, Pillow, numpy and reportlab from requirements.txt). This is a server setup problem; a retry or other inputs will not fix it.`;
    }
    const missingBinary = /FileNotFoundError: \[Errno 2\] No such file or directory: '(qpdf|pdftoppm|soffice)'/.exec(output);
    if (missingBinary) {
      return `the worker image is missing the "${missingBinary[1]}" command (Dockerfile.worker must install qpdf, poppler-utils and libreoffice). This is a server setup problem; a retry or other inputs will not fix it.`;
    }
    // The script's own errors end its output; keep the end.
    return output.length > 2000 ? `...${output.slice(-2000)}` : output;
  }
  return String(err);
}

/** Runs the packet script sandboxed in workDir and returns the JSON object it printed. */
async function runFeePacketScript(args: string[], workDir: string, timeoutMs: number): Promise<unknown> {
  // "build" starts LibreOffice itself (fee_packet.py to_pdf), so it holds a
  // LibreOffice slot (src/services/queue/concurrency.ts) for the whole script.
  const run = () => execUntrusted("python3", [SCRIPT_PATH, ...args], { workDir, timeoutMs });
  const { stdout } = args[0] === "build" ? await libreOfficeSlots().run(run) : await run();
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error(`fee_packet.py ${args[0]} printed no report: ${stdout.slice(0, 500)}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

/** Today in the form the script prints ("October 12, 2026"). */
function todayAtCourt(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: COURT_TIME_ZONE,
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

// ---------------------------------------------------------------- receipt check

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** The date forms the script's parse_date accepts, as YYYY-MM-DD; null when unrecognized. */
function normalizeDate(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, " ");
  const pad = (n: number) => String(n).padStart(2, "0");
  let m = /^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/.exec(s);
  if (m) {
    const word = m[1].toLowerCase();
    const month = MONTHS.findIndex((name) => name === word || (word.length >= 3 && name.startsWith(word)));
    return month === -1 ? null : `${m[3]}-${pad(month + 1)}-${pad(Number(m[2]))}`;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  return null;
}

function normalizeAmount(raw: string): number | null {
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return raw.trim() && Number.isFinite(n) ? n : null;
}

/**
 * SKILL.md Step 2 and Step 5: the A-number, tracking ID, payment date, amount
 * and fee kind must be the receipt's. Fields the reader could not read are
 * skipped (it says so in its warning, and the model reads the receipt itself).
 * Returns the refusal message, or null when the config agrees with the receipt.
 */
function receiptDisagreement(content: AsylumFeeProofPacketContent, receipt: ReceiptRead): string | null {
  const readANumber = (receipt.a_number ?? "").replace(/\D/g, "");
  const configANumber = content.a_number.replace(/\D/g, "");
  if (readANumber && readANumber !== configANumber) {
    return (
      `Not built: the receipt's A-number is ${receipt.a_number}, but a_number is ${content.a_number}. ` +
      "SKILL.md Step 2: a mismatch means the wrong receipt or the wrong client, so stop. Do not change a_number to make the build pass; " +
      "report the mismatch to the attorney as a question, with no packet."
    );
  }
  const mismatches: string[] = [];
  const readTracking = (receipt.tracking_id ?? "").replace(/\s+/g, "");
  if (readTracking && readTracking.toUpperCase() !== content.tracking_id.replace(/\s+/g, "").toUpperCase()) {
    mismatches.push(`tracking_id: the receipt shows ${receipt.tracking_id}, the config has ${content.tracking_id}`);
  }
  const readDate = receipt.pay_date ? normalizeDate(receipt.pay_date) : null;
  const configDate = normalizeDate(content.pay_date);
  if (readDate && configDate && readDate !== configDate) {
    mismatches.push(`pay_date: the receipt shows ${receipt.pay_date}, the config has ${content.pay_date}`);
  }
  const readAmount = receipt.amount ? normalizeAmount(receipt.amount) : null;
  const configAmount = normalizeAmount(content.amount);
  if (readAmount !== null && configAmount !== null && readAmount !== configAmount) {
    mismatches.push(`amount: the receipt shows ${receipt.amount}, the config has ${content.amount}`);
  }
  if ((receipt.fee_kind === "annual" || receipt.fee_kind === "initial") && receipt.fee_kind !== content.fee_kind) {
    mismatches.push(`fee_kind: the receipt's filing type (${receipt.filing_type ?? ""}) is "${receipt.fee_kind}", the config has "${content.fee_kind}"`);
  }
  if (mismatches.length === 0) return null;
  return (
    `Not built: the config disagrees with the receipt (${mismatches.join("; ")}). ` +
    "These come from the receipt (SKILL.md Step 4 table); check the receipt and call build_fee_packet again with its values."
  );
}

// ---------------------------------------------------------------- firm and signer

type FirmFields = AsylumFeeProofPacketSpec["firm"];
type SignerFields = AsylumFeeProofPacketSpec["signer"];

const SIGNATURE_DESCRIPTIONS: Record<SignerFields["signature"], string> = {
  image: "their signature image on the signature lines",
  conformed: "a /s/ line (no signature image is on file)",
  blank: "blank signature lines for an ink signature",
};

/** The signer's printed lines: "Esq." and a bar line for an attorney; title and EOIR ID for an accredited representative. */
function signerLines(
  signer: FirmIdentitySnapshotAttorney,
  orPlaceholder: (value: string | null | undefined, placeholder: string) => string
): Omit<SignerFields, "signature" | "signature_image"> {
  if (signer.role === "accredited_representative") {
    return {
      name: signer.fullName,
      name_line: signer.fullName,
      credential_lines: [
        ...(signer.title ? [signer.title] : []),
        signer.eoirId ? `EOIR ID: ${signer.eoirId}` : orPlaceholder(null, "[ATTORNEY EOIR ID]"),
      ],
      capacity_line: "Representative for Respondent",
    };
  }
  const barLine = signer.barNumber
    ? `${signer.barState ? `${signer.barState} ` : ""}Bar No. ${signer.barNumber}`
    : orPlaceholder(null, "[ATTORNEY BAR NUMBER]");
  return {
    name: signer.fullName,
    name_line: /,?\s*Esq\.?$/i.test(signer.fullName) ? signer.fullName : `${signer.fullName}, Esq.`,
    credential_lines: [barLine],
    capacity_line: "Counsel for Respondent",
  };
}

type CompletedPacketSpec = {
  spec: AsylumFeeProofPacketSpec;
  signature: { fileName: string; bytes: Buffer; attorneyId: string; sha256: string } | null;
  notes: string[];
  firmFax: string | null;
};

/**
 * The full config from the model's content and the run's firm identity
 * (ctx.firmIdentity, the snapshot its prompt shows): the counsel block and the
 * signer are always the server's. The signer is the default signer, or the
 * roster entry the model names by id when the case note names that person too
 * (resolveSigner, tools/shared/signer.ts); their stored signature image goes
 * on the signature lines when the run was queued by an owner/admin or
 * attorney, otherwise a /s/ line (as when none is on file), or blank lines
 * when the model asks for an ink signature. Missing identity details print as
 * bracketed placeholders and are named in the notes so the report flags them.
 */
async function completePacketSpec(
  content: AsylumFeeProofPacketContent,
  orderAttached: boolean,
  ctx: ToolExecutionContext
): Promise<CompletedPacketSpec | { error: string }> {
  const identity = ctx.firmIdentity;
  const { order, signer_attorney_id: requestedSignerId, wet_signature: wetSignature } = content;

  // The default signer, or another roster member only when the case note names them (tools/shared/signer.ts).
  const chosen = resolveSigner(ctx, requestedSignerId, "signer_attorney_id");
  if ("error" in chosen) return chosen;
  const signer = chosen.signer;
  const imageAllowed = signatureImagesAllowed(ctx);

  const placeholders: string[] = [];
  const orPlaceholder = (value: string | null | undefined, placeholder: string): string => {
    if (value) return value;
    placeholders.push(placeholder);
    return placeholder;
  };
  const firm = identity?.firm ?? null;
  const firmFields: FirmFields = {
    name: orPlaceholder(firm?.legalName, "[FIRM NAME]"),
    address_lines: firm?.addressLines.length ? firm.addressLines : [orPlaceholder(null, "[FIRM ADDRESS]")],
    phone: orPlaceholder(firm?.phone, "[FIRM PHONE]"),
    email: orPlaceholder(firm?.email, "[FIRM EMAIL]"),
    ...(firm?.fax ? { fax: firm.fax } : {}),
  };

  let signerFields: SignerFields;
  let signature: CompletedPacketSpec["signature"] = null;
  if (!signer) {
    const name = orPlaceholder(null, "[ATTORNEY NAME]");
    signerFields = {
      name,
      name_line: name,
      credential_lines: [orPlaceholder(null, "[ATTORNEY BAR NUMBER]")],
      capacity_line: "Counsel for Respondent",
      signature: "blank",
    };
  } else {
    signerFields = { ...signerLines(signer, orPlaceholder), signature: wetSignature ? "blank" : "conformed" };
    if (!wetSignature && signer.hasSignature && imageAllowed) {
      let stored;
      try {
        stored = await getSignerSignature(ctx.tenantId, signer.id);
      } catch (err) {
        return {
          error:
            `${err instanceof Error ? err.message : String(err)} To build the packet without it, call build_fee_packet again with wet_signature true, ` +
            "and flag in your report that the signature image must be re-uploaded.",
        };
      }
      // Null: removed from the roster or its image removed since the run was queued.
      if (stored) {
        const fileName = stored.mediaType === "image/png" ? "signature.png" : "signature.jpg";
        signerFields = { ...signerFields, signature: "image", signature_image: fileName };
        signature = { fileName, bytes: stored.bytes, attorneyId: signer.id, sha256: stored.sha256 };
      }
    }
  }

  const today = todayAtCourt();
  const datedToday = !content.sign_date;

  // receipt_document, signer_attorney_id and wet_signature are not config
  // keys, so the parse strips them; file_stem names the stored documents only.
  const spec = asylumFeeProofPacketSpecSchema.safeParse({
    ...content,
    sign_date: content.sign_date ?? today,
    file_stem: OUTPUT_STEM,
    receipt_pdf: RECEIPT_FILE,
    order: order
      ? {
          date: order.date,
          ...(order.deadline ? { deadline: order.deadline } : {}),
          ...(orderAttached ? { pdf: ORDER_FILE } : {}),
        }
      : null,
    firm: firmFields,
    signer: signerFields,
  });
  if (!spec.success) return { error: `Could not complete the packet config: ${spec.error.message}` };

  const notes = [
    `The app printed the counsel block of ${firmFields.name} and signed for ${signerFields.name} with ${SIGNATURE_DESCRIPTIONS[signerFields.signature]}.`,
    `Today's date (US Central time) is ${today}; judge the deadlines (Step 5) from it.`,
  ];
  if (signer?.hasSignature && !wetSignature && !imageAllowed) notes.push(SIGNATURE_IMAGE_WITHHELD_NOTE);
  if (datedToday) {
    notes.push(
      `sign_date was left out, so the packet is dated ${today}; report that as signDate and list it under defaultsUsed.`
    );
  }
  // SKILL.md Step 3's court default is the original firm's: Houston. Say what
  // printed so the model checks it against the matter's court.
  if (content.forum === "IC" && !content.court_city?.trim()) {
    notes.push(
      "court_city was left out, so the heading reads HOUSTON, TEXAS, the skill's default. If the matter's court or the note names another Immigration Court, rebuild with court_city and dhs_lines; otherwise list the Houston heading under defaultsUsed."
    );
  }
  if (!content.dhs_lines?.length) {
    const before = content.forum === "IC" ? "a case before" : "a case that came to the Board from";
    notes.push(
      `dhs_lines was left out, so the certificate of service serves the skill's default office, ${DEFAULT_DHS_OFFICE[content.forum]}. ` +
        `That is right only for ${before} the Houston Immigration Court. If the matter's court or the note names another court, or the court is unknown, ` +
        "put the service block under needsAction and ask the attorney for the DHS office to serve (never fill dhs_lines from memory); otherwise list it under defaultsUsed."
    );
  }
  if (content.filing === "paper" && signerFields.signature === "conformed") {
    notes.push(
      "Paper filing with a /s/ line: the practice manuals expect an ink signature on paper (a conformed signature suits ECAS filings), so the signer must sign the printed copy."
    );
  }
  if (signer?.role === "accredited_representative") {
    notes.push(
      `${signer.fullName} is an accredited representative: the blocks print no "Esq." and no bar number, and the BIA signature block reads "Representative for Respondent".`
    );
  }
  if (!firm?.fax) {
    notes.push("No fax is on file for the firm, so no fax line is printed; the fax check expects 0 mentions.");
  } else if (RETIRED_FAX_NUMBERS.some((n) => n.pattern.test(firm.fax ?? ""))) {
    notes.push(
      `The firm identity's fax (${firm.fax}) is a retired number the skill says never to print; flag that the Firm page must be updated before filing.`
    );
  }
  if (placeholders.length > 0) {
    notes.push(
      `The firm identity is incomplete, so the packet carries ${[...new Set(placeholders)].join(", ")}. ` +
        "Flag in your report that the firm identity setup is incomplete and that these must be filled before the packet is filed."
    );
  }
  return { spec: spec.data, signature, notes, firmFax: firm?.fax ?? null };
}

/**
 * The model's file_stem made safe for the documents list and the S3 key it
 * becomes part of: printable ASCII letters, digits, spaces and . _ - ( ) only.
 */
function safeFileStem(raw: string): string {
  const base = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.(pdf|docx)$/i, "")
    .replace(/[^A-Za-z0-9 ._()-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 100)
    .trim();
  return base || "Asylum Fee Proof Packet";
}

/** Removes everything in workDir except the page images render_and_qa_docx reads later. */
async function removeAllButPageImages(workDir: string): Promise<void> {
  for (const entry of await fs.readdir(workDir)) {
    if (!/^page.*\.jpg$/.test(entry)) await fs.rm(path.join(workDir, entry), { recursive: true, force: true });
  }
}

function formatReceipt(receipt: ReceiptRead): string {
  const fields: [string, string | number | undefined][] = [
    ["a_number", receipt.a_number],
    ["tracking_id", receipt.tracking_id],
    ["processed_on", receipt.processed_on],
    ["pay_date", receipt.pay_date],
    ["payment_type", receipt.payment_type],
    ["amount", receipt.amount],
    ["filing_type", receipt.filing_type],
    ["fee_kind", receipt.fee_kind],
    ["pages", receipt.pages],
    ["page_size", receipt.page_size?.join(" by ")],
    ["warning", receipt.warning],
  ];
  return fields
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

function formatReport(report: BuildReport, firmFax: string | null): string {
  return JSON.stringify(
    {
      ...report,
      fax_check: firmFax
        ? `firm_fax_mentions should be 2 for the fax on file (${firmFax})`
        : "no fax on file: firm_fax_mentions is null and no fax line is printed",
    },
    null,
    1
  );
}

async function executeBuildFeePacket(input: unknown, ctx: ToolExecutionContext) {
  const parsed = asylumFeeProofPacketContentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      content: `Config validation failed: ${parsed.error.message}. Call build_fee_packet again with corrected input.`,
      isError: true,
    };
  }
  const content = parsed.data;

  const written = JSON.stringify(content);
  const retired = RETIRED_FAX_NUMBERS.filter((n) => n.pattern.test(written)).map((n) => n.label);
  if (retired.length > 0) {
    return {
      content: `Not built: the config contains ${retired.join(", ")}, a fax number the skill says never to print. Remove it and call build_fee_packet again.`,
      isError: true,
    };
  }

  const receipt = await loadExhibitPdf(content.receipt_document, "Receipt", ctx);
  if (typeof receipt === "string") return { content: receipt, isError: true };
  let order: { doc: MatterDocument; bytes: Buffer } | null = null;
  if (content.order?.document?.trim()) {
    const loaded = await loadExhibitPdf(content.order.document, "Order", ctx);
    if (typeof loaded === "string") return { content: loaded, isError: true };
    if (loaded.doc.id === receipt.doc.id) {
      return { content: `The order and the receipt are the same document ("${receipt.doc.fileName}").`, isError: true };
    }
    order = loaded;
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "feepkt-"));
  let keepWorkDir = false;
  try {
    await fs.writeFile(path.join(workDir, RECEIPT_FILE), receipt.bytes);

    // Step 2: read the receipt before building anything.
    let receiptRead: ReceiptRead;
    try {
      const raw = receiptReadSchema.safeParse(await runFeePacketScript(["read", RECEIPT_FILE], workDir, READ_TIMEOUT_MS));
      if (!raw.success) return { content: `fee_packet.py read printed an unexpected report: ${raw.error.message}`, isError: true };
      receiptRead = raw.data;
    } catch (err) {
      return { content: `Could not read the receipt "${receipt.doc.fileName}": ${describeExecError(err)}`, isError: true };
    }
    const disagreement = receiptDisagreement(content, receiptRead);
    if (disagreement) {
      return { content: `${disagreement} Receipt as read: ${formatReceipt(receiptRead)}.`, isError: true };
    }

    const completed = await completePacketSpec(content, order !== null, ctx);
    if ("error" in completed) return { content: completed.error, isError: true };
    // The read step ran sandboxed in this directory: never write through what it may have left.
    if (order) await writeWorkFile(workDir, ORDER_FILE, order.bytes);
    if (completed.signature) await writeWorkFile(workDir, completed.signature.fileName, completed.signature.bytes);
    await writeWorkFile(workDir, CONFIG_FILE, JSON.stringify(completed.spec, null, 2));

    // Step 4: build.
    let report: BuildReport;
    try {
      const raw = buildReportSchema.safeParse(await runFeePacketScript(["build", CONFIG_FILE], workDir, BUILD_TIMEOUT_MS));
      if (!raw.success) return { content: `fee_packet.py build printed an unexpected report: ${raw.error.message}`, isError: true };
      report = raw.data;
    } catch (err) {
      return { content: `Python packet build failed: ${describeExecError(err)}`, isError: true };
    }

    const pdfPath = path.join(workDir, `${OUTPUT_STEM}.pdf`);
    const pdfBytes = await readToolOutput(pdfPath, { maxBytes: TOOL_OUTPUT_LIMITS.document });
    const docxBytes = await readToolOutput(path.join(workDir, `${OUTPUT_STEM}.docx`), {
      maxBytes: TOOL_OUTPUT_LIMITS.document,
    });
    let pageImagePaths: string[];
    try {
      pageImagePaths = await rasterizePdfPages(workDir, pdfPath);
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
    // The receipt, the order, the signature image and the script's
    // intermediate files are not kept; the page images are, for render_and_qa_docx.
    await removeAllButPageImages(workDir);

    const signature = completed.signature;
    const recordSignature = signature
      ? (tx: typeof db, documentId: string) =>
          recordFirmSignatureApplied(tx, {
            tenantId: ctx.tenantId,
            attorneyId: signature.attorneyId,
            documentId,
            matterId: ctx.matterId,
            sha256: signature.sha256,
            requestedBy: ctx.requestedBy,
            skillRunId: ctx.skillRunId,
          })
      : undefined;
    const stem = safeFileStem(content.file_stem);

    // From here on the work directory belongs to the stored documents'
    // entries, and cleanupGeneratedDocuments removes it at the end of the run.
    const pdfRow = await createGeneratedDocument({
      tenantId: ctx.tenantId,
      matterId: ctx.matterId,
      fileName: `${stem}.pdf`,
      contentType: PDF_MIME,
      body: pdfBytes,
      uploadedBy: ctx.requestedBy,
      type: "generated_draft",
      inTransaction: recordSignature,
    });
    ctx.generatedDocuments.set(pdfRow.id, { documentRowId: pdfRow.id, pageImagePaths, workDir, origin: "generated" });
    keepWorkDir = true;
    let docxRow;
    try {
      docxRow = await createGeneratedDocument({
        tenantId: ctx.tenantId,
        matterId: ctx.matterId,
        fileName: `${stem}.docx`,
        contentType: DOCX_MIME,
        body: docxBytes,
        uploadedBy: ctx.requestedBy,
        type: "generated_draft",
        inTransaction: recordSignature,
      });
    } catch (err) {
      return {
        content:
          `The PDF was stored (document_id ${pdfRow.id}), but the Word file could not be stored: ${err instanceof Error ? err.message : String(err)}. ` +
          "Call build_fee_packet again to store both, and report only the pair from the successful call.",
        isError: true,
      };
    }
    // The Word file is the document the PDF was converted from (SKILL.md
    // Step 5), so it shares the PDF's page images.
    ctx.generatedDocuments.set(docxRow.id, { documentRowId: docxRow.id, pageImagePaths, workDir, origin: "generated" });

    return {
      content: [
        `Built the packet: PDF document_id ${pdfRow.id} ("${stem}.pdf", ${pageImagePaths.length} page(s)), Word document_id ${docxRow.id} ("${stem}.docx", the whole packet, editable).`,
        `Call render_and_qa_docx with the PDF's document_id to look at every page; the Word file shows the same pages, since the PDF was converted from it.`,
        `Receipt as read (fee_packet.py read): ${formatReceipt(receiptRead)}.`,
        ...completed.notes,
        `Build report (fee_packet.py build):\n${formatReport(report, completed.firmFax)}`,
        "Each build_fee_packet call stores a new pair of documents; rebuild only to fix a problem, and report only the final pair.",
      ].join("\n"),
    };
  } finally {
    if (!keepWorkDir) await cleanupWorkDir(workDir);
  }
}

export const buildFeePacketTool: SkillTool = {
  definition: {
    name: "build_fee_packet",
    description:
      "Build the asylum fee proof of payment packet: the filing-ready PDF and the same packet as an editable Word file, saved to the matter's documents. " +
      "It stands in for the skill's shell steps, which cannot run here: Step 1 (the skill folder and the working copy of the script), Step 2 (fee_packet.py read) and Step 4 (writing config.json and running fee_packet.py build). " +
      "Input: the Step 4 config fields, except that the receipt and the order are the matter documents that hold them (receipt_document, order.document: the document's id, or its file name exactly as its label shows it) instead of receipt_pdf and order.pdf, and that out_dir, signature and signature_png are left out. Only PDFs on this matter that passed the malware scan can be attached. " +
      "Leave sign_date out to date the packet today (Step 3's default): the app fills in today's date and reports it, with the default court heading and DHS service block when court_city or dhs_lines is left out. " +
      "The app prints the counsel block and the signature blocks from the firm identity in the FIRM IDENTITY section, not from the skill text: the firm's name, address, office phone, fax (only when one is on file) and email, and the signer, who is the default signer unless you pass signer_attorney_id for another roster member the attorney's note names (a name found only in the matter's documents is refused). The signature lines carry the signer's signature image when one is on file, otherwise a /s/ line; wet_signature true leaves them blank for an ink signature. " +
      "Before building, the app reads the receipt as fee_packet.py read does and refuses a config whose A-number, tracking ID, payment date, amount or fee kind differs from it; an A-number that differs means the wrong receipt or the wrong client: do not change it, ask the attorney in your report. " +
      "Returns the PDF's and the Word file's document_id, the receipt as read, and the Step 5 build report (pages, index, page_number_problems, a_number_mentions, tracking_id_in_letter, special_characters, warnings, plus firm_fax_mentions and retired_fax_mentions for the fax check). " +
      "Then call render_and_qa_docx with the PDF's document_id to look at every page. Each call stores a new pair of documents: rebuild only to fix a problem, and report only the final pair.",
    input_schema: toJsonSchemaObject(asylumFeeProofPacketContentSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeBuildFeePacket,
};
