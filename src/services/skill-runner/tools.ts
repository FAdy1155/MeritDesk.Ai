import "server-only";
import path from "node:path";
import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { db } from "@/db/client";
import { createGeneratedDocument, getMatterDocument } from "@/lib/documents/service";
import { getSignerSignature, recordFirmSignatureApplied } from "@/lib/firm-identity/service";
import type { FirmIdentitySnapshot } from "@/lib/firm-identity/schema";
import type { MembershipRole } from "@/lib/roles";
import { getObjectBytes } from "@/lib/s3";
import { detectFileKind } from "@/lib/documents/file-kind";
import { isWordprocessingDocument } from "@/lib/documents/ooxml";
import {
  generateDocxWithPreview,
  renderDocxToImages,
  readGeneratedFile,
  cleanupWorkDir,
  DOCX_TEMPLATES_DIR,
  GENERIC_DOCUMENT_SCRIPT,
  type GeneratorInputFile,
} from "@/services/docx-generator/generate";
import { getSkillModule } from "./skills";
import {
  i130ExpediteLetterContentSchema,
  i130ExpediteLetterSpecSchema,
  type I130ExpediteLetterContent,
  type I130ExpediteLetterSpec,
} from "./skills/i130-expedite-build";
import { generateDocumentInputSchema } from "./document-spec";
import { SKILLS_CONTENT_DIR } from "./skill-content";
import { toJsonSchemaObject } from "./json-schema";
import type { ToolKey } from "./tool-keys";
import type { VerificationLogEntry } from "./verification-log";
// Per-skill tools (./tools/). Each imports only types from this module,
// except tools/eoir-written-pleadings.ts, which builds its tool with
// createDocxGeneratorTool on first use (never while the modules load).
import { buildFeePacketTool } from "./tools/asylum-fee-proof-packet";
import { loadAsylumInterviewPrepReviewTool } from "./tools/asylum-interview-prep-build";
import { fetchEcfrSectionTool } from "./tools/eoir-filing-compliance";
import { generateEoirWrittenPleadingsDocxTool } from "./tools/eoir-written-pleadings";
import { fillUscisFormPdfTool, loadI90PacketReviewTool } from "./tools/i90-packet-build";
import { loadMotionReferencesTool } from "./tools/legal-argument-research";
import { lookupLibraryCitationTool, readLibraryDocumentTool, searchLibraryTool } from "./tools/library";
// The EOIR statistics tools live with their data, beside the library collector that tracks EOIR's case data release.
import { eoirJudgeProfileTool, queryEoirStatsTool, searchEoirJudgesTool } from "@/services/library/adapters/eoir-statistics/tools";
import { makeCorrectedCopyTool } from "./tools/orthography-check";
import {
  fillPacketBuildPdfFormTool,
  listPacketBuildPdfFormFieldsTool,
  loadPacketBuildCompanionSkillTool,
} from "./tools/packet-build";
import { readPriorSkillReportsTool } from "./tools/prior-skill-reports";
import { resolveSigner, signatureImagesAllowed, SIGNATURE_IMAGE_WITHHELD_NOTE } from "./tools/shared/signer";
import {
  fillVawaPdfFormTool,
  listVawaPdfFormFieldsTool,
  loadOrthographyCheckTool,
  loadVawaPacketReviewTool,
} from "./tools/vawa-packet-build";

export type { VerificationLogEntry } from "./verification-log";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type GeneratedDocumentEntry = {
  documentRowId: string;
  pageImagePaths: string[];
  workDir: string;
  /**
   * "generated": written by a generator tool in this run (the only ids a
   * report may name as its generated documents). "matter": an existing
   * matter document render_and_qa_docx rendered on request.
   */
  origin: "generated" | "matter";
};

export type ToolExecutionContext = {
  tenantId: string;
  matterId: string;
  requestedBy: string;
  /** The skill_runs row (null when the loop runs outside a stored run, as in tests). */
  skillRunId: string | null;
  /**
   * The firm identity the run was queued with (input_snapshot.firmIdentity),
   * the same one its system prompt shows. Generators fill letterhead and
   * signer fields from it server-side, never from the model's input.
   */
  firmIdentity: FirmIdentitySnapshot | null;
  /**
   * The run's case note (input_snapshot.attorneyNote), typed by the user who
   * queued it: trusted input, unlike the matter's documents. Generators check
   * a non-default signer against it (tools/shared/signer.ts).
   */
  attorneyNote: string | null;
  /**
   * The role of the user who queued the run, recorded at enqueue
   * (input_snapshot.requesterRole); null for a run queued before it was.
   * Only owner/admin and attorney runs embed signature images.
   */
  requesterRole: MembershipRole | null;
  verificationLog: VerificationLogEntry[];
  generatedDocuments: Map<string, GeneratedDocumentEntry>;
  /**
   * Images tool results may still add to the conversation. Every request
   * resends them, and the API's image rules count them with the matter's
   * attached images (see toolImageBudget in run.ts).
   */
  toolImages: { budget: number; used: number };
  /**
   * The API's 32 MB request limit, in serialized request bytes. Every
   * request resends the whole conversation, so whatever a tool result adds
   * stays in every later request. `used` is the size of the request the
   * runner would send next (measured before the tools of a turn run, see
   * run.ts); a tool that returns bulky content (page images) adds what it
   * returns and stops before `used` would pass `limit`.
   */
  requestBytes: { limit: number; used: number };
};

export type ToolResultContent = string | Anthropic.ToolResultBlockParam["content"];

export type SkillTool = {
  definition: Anthropic.Tool;
  execute: (input: unknown, ctx: ToolExecutionContext) => Promise<{ content: ToolResultContent; isError?: boolean }>;
};

// Only these hosts are reachable via fetch_uscis_page: the point of the
// tool is verifying against the government's own current pages, not
// general-purpose browsing. https only, on every hop: redirects are followed
// by hand (at most MAX_VERIFICATION_REDIRECTS), and each Location must be
// https on this list too, or the fetch stops there.
// travel.state.gov is here for the Visa Bulletin (vawa-packet-review's
// LPR-abuser posture check); egov.uscis.gov for USCIS's posted processing
// times (i130-expedite-build's live check, i90-packet-review's), which are
// published there rather than on www.uscis.gov.
const ALLOWED_VERIFICATION_HOSTS = new Set([
  "www.uscis.gov",
  "uscis.gov",
  "egov.uscis.gov",
  "www.justice.gov",
  "justice.gov",
  "travel.state.gov",
]);
const MAX_VERIFICATION_REDIRECTS = 5;
// Most of a page is markup. Reading stops here, so an endless or huge body
// cannot exhaust the worker's memory.
const MAX_VERIFICATION_BODY_BYTES = 2 * 1024 * 1024;
// Text one call returns; the model reads the rest of a longer page (a
// practice manual chapter) in further calls with `offset`, never silently cut.
const VERIFICATION_TEXT_CHARS = 20_000;
// What the tool can read as text. Anything else (a PDF on justice.gov) would
// come back as decoded binary, so it is refused and logged as failed.
const READABLE_CONTENT_TYPES = new Set(["text/html", "text/plain", "application/xhtml+xml"]);
const VERIFICATION_FETCH_TIMEOUT_MS = 15_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Why a URL may not be fetched, or null when it may. */
function verificationUrlProblem(url: URL): string | null {
  if (url.protocol !== "https:") return `only https:// URLs are reachable (got ${url.protocol}//${url.hostname})`;
  if (url.username || url.password) return "URLs with credentials are not fetched";
  if (url.port && url.port !== "443") return `only the standard https port is reachable (got port ${url.port})`;
  if (!ALLOWED_VERIFICATION_HOSTS.has(url.hostname)) {
    return `only uscis.gov (with egov.uscis.gov), justice.gov and travel.state.gov are reachable (got ${url.hostname})`;
  }
  return null;
}

/** A response body as text, reading no more than maxBytes (decompressed). */
async function readCappedBody(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf-8"), truncated };
}

type VerificationFetch = {
  content: string;
  isError: boolean;
  /** What the verification log records; null when nothing was requested (bad input). */
  log: VerificationLogEntry | null;
};

/**
 * Fetches one allow-listed government page, following redirects only
 * within the allow list. The log entry names the page the content actually
 * came from (`url`), the URL the model asked for when that differs
 * (`requestedUrl`) and every hop in between (`redirects`).
 */
async function fetchVerificationPage(input: unknown): Promise<VerificationFetch> {
  const { url, offset: rawOffset } = (input ?? {}) as { url?: unknown; offset?: unknown };
  if (typeof url !== "string" || !url) return { content: "Missing required field: url", isError: true, log: null };
  if (rawOffset !== undefined && (typeof rawOffset !== "number" || !Number.isInteger(rawOffset) || rawOffset < 0)) {
    return { content: "offset must be a whole number of characters, 0 or more.", isError: true, log: null };
  }
  const offset = typeof rawOffset === "number" ? rawOffset : 0;

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { content: `Invalid URL: ${url}`, isError: true, log: null };
  }
  const firstProblem = verificationUrlProblem(current);
  if (firstProblem) return { content: `Fetch blocked: ${firstProblem}.`, isError: true, log: null };

  const requestedUrl = current.toString();
  const redirects: string[] = [];
  const logEntry = (status: number | string, extra: Partial<VerificationLogEntry> = {}): VerificationLogEntry => ({
    source: "fetch_uscis_page",
    url: current.toString(),
    ...(current.toString() !== requestedUrl ? { requestedUrl } : {}),
    ...(redirects.length ? { redirects: [...redirects] } : {}),
    fetchedAt: new Date().toISOString(),
    status,
    ...extra,
  });
  const signal = AbortSignal.timeout(VERIFICATION_FETCH_TIMEOUT_MS);

  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(current.toString(), { signal, redirect: "manual" });
      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location) {
          return { content: `Fetch failed: HTTP ${res.status} redirect with no Location.`, isError: true, log: logEntry(res.status) };
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return { content: `Fetch blocked: the page redirected to an invalid URL.`, isError: true, log: logEntry("redirect_blocked") };
        }
        const problem = verificationUrlProblem(next);
        if (problem) {
          return {
            content: `Fetch blocked: ${current.toString()} redirected to ${next.toString()}, and ${problem}. Nothing from it was read.`,
            isError: true,
            log: logEntry("redirect_blocked"),
          };
        }
        if (hop >= MAX_VERIFICATION_REDIRECTS) {
          return {
            content: `Fetch failed: more than ${MAX_VERIFICATION_REDIRECTS} redirects.`,
            isError: true,
            log: logEntry("too_many_redirects"),
          };
        }
        redirects.push(current.toString());
        current = next;
        continue;
      }

      const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (contentType && !READABLE_CONTENT_TYPES.has(contentType)) {
        await res.body?.cancel().catch(() => {});
        return {
          content:
            `Fetch failed: ${current.toString()} is ${contentType}, not a web page, so nothing from it was read. ` +
            "If you have web_fetch, use it for this URL (it reads PDFs); otherwise treat what it would have confirmed as unverified.",
          isError: true,
          log: logEntry("unsupported_content_type"),
        };
      }

      const { text: body, truncated } = await readCappedBody(res, MAX_VERIFICATION_BODY_BYTES);
      const fullText = stripHtmlToText(body);
      if (offset > 0 && offset >= fullText.length) {
        return {
          content: `offset ${offset} is past the end of ${current.toString()}, whose text has ${fullText.length} characters.`,
          isError: true,
          log: logEntry(res.status),
        };
      }
      const text = fullText.slice(offset, offset + VERIFICATION_TEXT_CHARS);
      const end = offset + text.length;
      const range =
        offset > 0 || end < fullText.length
          ? ` - characters ${offset}-${end} of ${fullText.length} shown` +
            (end < fullText.length ? `; call again with offset ${end} for the rest` : "")
          : "";
      const via = redirects.length ? ` (redirected from ${requestedUrl})` : "";
      const content =
        `[Fetched ${current.toString()}${via} - HTTP ${res.status} - ${new Date().toISOString()}${range}` +
        `${truncated ? ` - only the first ${MAX_VERIFICATION_BODY_BYTES / (1024 * 1024)} MB were read` : ""}]\n\n${text}`;
      return {
        content,
        isError: !res.ok,
        log: logEntry(res.status, {
          contentHash: crypto.createHash("sha256").update(content).digest("hex").slice(0, 16),
        }),
      };
    }
  } catch (err) {
    return {
      content: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
      log: logEntry(0),
    };
  }
}

/**
 * The live-verification pattern i130-expedite-build's SKILL.md already
 * describes ("verify against uscis.gov this session, log the URL and date")
 * made real: the app, not the model, writes the verification_log entry, as
 * a side effect of this tool actually executing (executeFetchWithLogging
 * below). A model narrating that it verified something without calling this
 * tool leaves no log entry.
 */
export const fetchUscisPageTool: SkillTool = {
  definition: {
    name: "fetch_uscis_page",
    description:
      "Fetch a live page from uscis.gov (including egov.uscis.gov, where USCIS posts processing times), justice.gov (EOIR), or travel.state.gov (Visa Bulletin) to confirm current criteria, mailing addresses, processing times, form editions, or visa cutoff dates before relying on them. Only these domains are reachable, and redirects are followed only within them. " +
      "Returns the page's visible text, at most 20,000 characters per call: when the result header says more remains, call again with the offset it gives. Only web pages (HTML or plain text) are read; a PDF is refused. " +
      "Every call is logged with its URL and timestamp as this run's verification log.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full https:// URL on uscis.gov, egov.uscis.gov, justice.gov or travel.state.gov" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Character offset in the page's text to start from, to read the rest of a long page (default 0).",
        },
      },
      required: ["url"],
    },
  },
  execute: async (input) => {
    const { content, isError } = await fetchVerificationPage(input);
    return { content, isError };
  },
};

/** fetch_uscis_page as the runner calls it: also pushes the verification_log entry onto ctx. */
async function executeFetchWithLogging(input: unknown, ctx: ToolExecutionContext) {
  const { content, isError, log } = await fetchVerificationPage(input);
  if (log) ctx.verificationLog.push(log);
  return { content, isError };
}

/**
 * Stores a .docx a generator tool wrote as a generated_draft Document on the
 * matter (S3 + documents row, queued for text extraction) and keeps its
 * rendered pages on ctx for render_and_qa_docx. Returns the new document id.
 */
async function storeGeneratedDocx(
  ctx: ToolExecutionContext,
  generated: { docxPath: string; pageImagePaths: string[]; workDir: string },
  fileName: string,
  inTransaction?: (tx: typeof db, documentId: string) => Promise<void>
): Promise<string> {
  const docxBuffer = await readGeneratedFile(generated.docxPath, "document");
  const documentRow = await createGeneratedDocument({
    tenantId: ctx.tenantId,
    matterId: ctx.matterId,
    fileName,
    contentType: DOCX_MIME,
    body: docxBuffer,
    uploadedBy: ctx.requestedBy,
    type: "generated_draft",
    inTransaction,
  });
  ctx.generatedDocuments.set(documentRow.id, {
    documentRowId: documentRow.id,
    pageImagePaths: generated.pageImagePaths,
    workDir: generated.workDir,
    origin: "generated",
  });
  return documentRow.id;
}

/**
 * A generator spec after the server completed it (createDocxGeneratorTool's
 * completeSpec): the spec the script reads, files written next to it, notes
 * for the model about what the server filled in, and a hook that runs in the
 * transaction that stores the generated document (for audit entries).
 */
export type CompletedGeneratorSpec = {
  spec: Record<string, unknown>;
  inputFiles?: GeneratorInputFile[];
  notes?: string[];
  inTransaction?: (tx: typeof db, documentId: string) => Promise<void>;
  /**
   * The stored document's file name for this call, when it depends on the
   * content (e.g. the client's surname); made safe with safeDocxFileName.
   * Defaults to the tool's outputFileName.
   */
  fileName?: string;
};

/**
 * Builds a skill's "write the .docx from a JSON spec" tool around a Python
 * generator script: one bundled with the skill and used as is
 * (`scriptPath`, relative to skills-content/), or an adapted copy under
 * src/services/docx-generator/templates/ (`templatePath`), for a firm
 * script that had to change for multi-tenancy. The script is run on the
 * worker image via generateDocxWithPreview (python3 + soffice + pdftoppm; see
 * src/services/docx-generator/generate.ts), the result is stored as a
 * generated_draft Document on the matter, and its rendered pages are kept
 * on ctx for render_and_qa_docx. Without those binaries on PATH the tool
 * returns a clear "binary not found" tool error instead of a document.
 *
 * `completeSpec` turns the model's validated input into the script's spec
 * server-side: it is how fields the model must not control (letterhead,
 * signer, signature image) are filled from the firm identity on ctx. Leave
 * those fields out of `specSchema`, so the model never sends them.
 */
export function createDocxGeneratorTool<TSpec extends Record<string, unknown>>(
  params: {
    /** The name the model sees and calls. */
    toolName: string;
    description: string;
    /** Validates the model's input before anything runs; also the tool's input_schema. */
    specSchema: z.ZodType<TSpec>;
    outputFileName: string;
    completeSpec?: (spec: TSpec, ctx: ToolExecutionContext) => Promise<CompletedGeneratorSpec | { error: string }>;
  } & (
    | { /** Path to a skill's bundled script, relative to skills-content/. */ scriptPath: string; templatePath?: undefined }
    | { /** Path to an adapted script, relative to src/services/docx-generator/templates/. */ templatePath: string; scriptPath?: undefined }
  )
): SkillTool {
  const scriptPath =
    params.templatePath !== undefined
      ? path.join(DOCX_TEMPLATES_DIR, params.templatePath)
      : path.join(SKILLS_CONTENT_DIR, params.scriptPath);
  return {
    definition: {
      name: params.toolName,
      description: params.description,
      input_schema: toJsonSchemaObject(params.specSchema) as Anthropic.Tool.InputSchema,
    },
    execute: async (input, ctx) => {
      const parsed = params.specSchema.safeParse(input);
      if (!parsed.success) {
        return {
          content: `Spec validation failed: ${parsed.error.message}. Call ${params.toolName} again with corrected input.`,
          isError: true,
        };
      }

      let completed: CompletedGeneratorSpec = { spec: parsed.data };
      if (params.completeSpec) {
        const completion = await params.completeSpec(parsed.data, ctx);
        if ("error" in completion) return { content: completion.error, isError: true };
        completed = completion;
      }

      const outputFileName = completed.fileName ? safeDocxFileName(completed.fileName) : params.outputFileName;
      let result;
      try {
        result = await generateDocxWithPreview({
          scriptPath,
          spec: completed.spec,
          outputFileName,
          inputFiles: completed.inputFiles,
        });
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }

      const documentId = await storeGeneratedDocx(ctx, result, outputFileName, completed.inTransaction);
      return {
        content: [
          `Generated document_id: ${documentId} (${result.pageImagePaths.length} page(s)). Call render_and_qa_docx with this ID before finalizing your report.`,
          ...(completed.notes ?? []),
        ].join(" "),
      };
    },
  };
}

/**
 * The firm's letterhead as the generator scripts take it (the i130 letter's
 * `firm` object, make_document.py's `letterhead`): the run's firm identity,
 * with a bracketed placeholder, pushed onto `placeholders`, for each detail
 * a letterhead needs and the tenant has not provided. Optional details
 * (fax, licensure line, website) are left out when absent.
 */
export type FirmLetterheadFields = {
  name: string;
  address_lines: string[];
  phone: string;
  email: string;
  fax?: string;
  licensure_line?: string;
  website?: string;
};

export function firmLetterheadFields(
  identity: FirmIdentitySnapshot | null,
  placeholders: string[]
): FirmLetterheadFields {
  const orPlaceholder = (value: string | null | undefined, placeholder: string): string => {
    if (value) return value;
    placeholders.push(placeholder);
    return placeholder;
  };
  const firm = identity?.firm ?? null;
  return {
    name: orPlaceholder(firm?.legalName, "[FIRM NAME]"),
    address_lines: firm?.addressLines.length ? firm.addressLines : [orPlaceholder(null, "[FIRM ADDRESS]")],
    phone: orPlaceholder(firm?.phone, "[FIRM PHONE]"),
    email: orPlaceholder(firm?.email, "[FIRM EMAIL]"),
    ...(firm?.fax ? { fax: firm.fax } : {}),
    ...(firm?.licensureLine ? { licensure_line: firm.licensureLine } : {}),
    ...(firm?.website ? { website: firm.website } : {}),
  };
}

const SIGNATURE_DESCRIPTIONS: Record<I130ExpediteLetterSpec["signer"]["signature"], string> = {
  image: "their signature image above the typed name",
  conformed: "a /s/ line above the typed name (no signature image is on file)",
  blank: "blank space for a handwritten signature",
};

/**
 * Completes the expedite letter spec from the run's firm identity
 * (ctx.firmIdentity, the snapshot its prompt shows). The letterhead and the
 * signature block are always the server's: the model's input schema has no
 * such fields, and unknown keys are stripped by the parse. The signer is the
 * default signer, or the roster entry the model names by id when the case
 * note names that person too (resolveSigner, tools/shared/signer.ts); their
 * stored signature image (getSignerSignature, which checks it is the image
 * the firm uploaded) goes above the typed name when the run was queued by an
 * owner/admin or attorney, otherwise a /s/ line (as when none is on file),
 * or blank space when the model asks for a wet signature. Missing
 * identity details are printed as bracketed placeholders and named in the
 * tool result so the report flags them.
 */
export async function completeI130LetterSpec(
  content: I130ExpediteLetterContent,
  ctx: ToolExecutionContext
): Promise<CompletedGeneratorSpec | { error: string }> {
  const identity = ctx.firmIdentity;
  const { signer_attorney_id: requestedSignerId, wet_signature: wetSignature, ...letter } = content;

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
  const firmFields: I130ExpediteLetterSpec["firm"] = firmLetterheadFields(identity, placeholders);

  let signerFields: I130ExpediteLetterSpec["signer"];
  const inputFiles: GeneratorInputFile[] = [];
  let applied: { attorneyId: string; sha256: string } | null = null;
  if (!signer) {
    signerFields = { name: orPlaceholder(null, "[ATTORNEY NAME]"), signature: "blank" };
  } else {
    signerFields = {
      name: signer.fullName,
      ...(signer.title ? { title: signer.title } : {}),
      signature: wetSignature ? "blank" : "conformed",
    };
    if (!wetSignature && signer.hasSignature && imageAllowed) {
      let signature;
      try {
        signature = await getSignerSignature(ctx.tenantId, signer.id);
      } catch (err) {
        return {
          error:
            `${err instanceof Error ? err.message : String(err)} To generate the letter without it, call generate_docx again with wet_signature true, ` +
            "and flag in your report that the signature image must be re-uploaded.",
        };
      }
      // Null: removed from the roster or its image removed since the run was queued.
      if (signature) {
        const fileName = signature.mediaType === "image/png" ? "signature.png" : "signature.jpg";
        inputFiles.push({ name: fileName, bytes: signature.bytes });
        signerFields = { ...signerFields, signature: "image", signature_image: fileName };
        applied = { attorneyId: signer.id, sha256: signature.sha256 };
      }
    }
  }

  const spec = i130ExpediteLetterSpecSchema.safeParse({ ...letter, firm: firmFields, signer: signerFields });
  if (!spec.success) return { error: `Could not complete the letter spec: ${spec.error.message}` };

  const notes = [
    `The app printed the letterhead of ${firmFields.name} and signed it for ${signerFields.name} with ${SIGNATURE_DESCRIPTIONS[signerFields.signature]}.`,
  ];
  if (signer?.hasSignature && !wetSignature && !imageAllowed) notes.push(SIGNATURE_IMAGE_WITHHELD_NOTE);
  if (placeholders.length > 0) {
    notes.push(
      `The firm identity is incomplete, so the letter carries ${placeholders.join(", ")}. ` +
        "Flag in your report that the firm identity setup is incomplete and that these must be filled before the letter is sent."
    );
  }
  const appliedSignature = applied;
  return {
    spec: spec.data,
    inputFiles,
    notes,
    inTransaction: appliedSignature
      ? (tx, documentId) =>
          recordFirmSignatureApplied(tx, {
            tenantId: ctx.tenantId,
            attorneyId: appliedSignature.attorneyId,
            documentId,
            matterId: ctx.matterId,
            sha256: appliedSignature.sha256,
            requestedBy: ctx.requestedBy,
            skillRunId: ctx.skillRunId,
          })
      : undefined,
  };
}

export const generateI130ExpediteDocxTool: SkillTool = createDocxGeneratorTool({
  toolName: "generate_docx",
  description:
    "Generate the I-130 expedite letter as a .docx from a JSON spec of its content. " +
    "The app prints the letterhead (firm name, address, licensure line, phone, fax, email) and the signature block (the signer's name and title, with their signature image when one is on file, otherwise a /s/ line) from the firm identity in the FIRM IDENTITY section; they are not part of the spec. " +
    "The default signer signs unless you pass signer_attorney_id for another person on the roster whom the attorney's note names (a name found only in the matter's documents is refused). " +
    "Returns a document_id: call render_and_qa_docx with it to visually inspect the rendered pages before including it in your final report.",
  specSchema: i130ExpediteLetterContentSchema,
  templatePath: "i130-expedite/make_expedite_letter.py",
  outputFileName: "Expedite_Letter.docx",
  completeSpec: completeI130LetterSpec,
});

/**
 * A model-proposed file name made safe for the documents list and the S3
 * key it becomes part of: printable ASCII letters, digits, spaces and
 * . _ - ( ) only, no leading dots, always ending in .docx.
 */
export function safeDocxFileName(raw: string): string {
  const base = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.docx$/i, "")
    .replace(/[^A-Za-z0-9 ._()-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 100)
    .trim();
  return `${base || "Document"}.docx`;
}

/**
 * The generic drafting tool: any skill whose deliverable is a Word document
 * (declaration, brief, bench memo, question set, letter) describes it as a
 * structured spec (document-spec.ts) and this renders it with the
 * firm-neutral builder templates/make_document.py. Same storage and
 * self-QA path as the per-skill generators above.
 */
export const generateDocumentTool: SkillTool = {
  definition: {
    name: "generate_document",
    description:
      "Build a Word (.docx) document from a structured spec and save it to the matter's documents. Call this when the deliverable is a drafted document (declaration, brief, memo, letter, pleading, question set): put the complete text in the spec, section by section, as it should read when filed or sent. " +
      "Defaults: US Letter, 1 inch margins, Times New Roman 12 pt, justified body text with a 0.5 inch first-line indent, centered page numbers; set line_spacing 2 for double-spaced court filings. Inline **bold**, *italic*, __underline__. " +
      "Never invent a fact, date, exhibit, quotation, or citation to fill the document; where something is missing, write a bracketed placeholder such as [CONFIRM: date of entry]. " +
      "Returns a document_id. Then call render_and_qa_docx with it to look at the pages; if anything is wrong, call generate_document again with a corrected spec (each call saves a new document) and report only the final document_id.",
    input_schema: toJsonSchemaObject(generateDocumentInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: async (input, ctx) => {
    const parsed = generateDocumentInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        content: `Spec validation failed: ${parsed.error.message}. Call generate_document again with corrected input.`,
        isError: true,
      };
    }
    const fileName = safeDocxFileName(parsed.data.file_name);

    // The letterhead is the server's, never the model's (2.8): the spec
    // schema has no letterhead field, so the parse dropped any the model sent.
    let spec: Record<string, unknown> = parsed.data.spec;
    const notes: string[] = [];
    if (parsed.data.spec.firm_letterhead) {
      const placeholders: string[] = [];
      const letterhead = firmLetterheadFields(ctx.firmIdentity, placeholders);
      spec = { ...spec, letterhead };
      notes.push(`The app printed the letterhead of ${letterhead.name} from the firm identity.`);
      if (placeholders.length > 0) {
        notes.push(
          `The firm identity is incomplete, so the letterhead carries ${placeholders.join(", ")}. ` +
            "Flag in your report that the firm identity setup is incomplete and that these must be filled before the document is sent or filed."
        );
      }
    }

    let result;
    try {
      result = await generateDocxWithPreview({
        scriptPath: GENERIC_DOCUMENT_SCRIPT,
        spec,
        outputFileName: fileName,
      });
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }

    const documentId = await storeGeneratedDocx(ctx, result, fileName);
    return {
      content: [
        `Generated document_id: ${documentId}, saved as "${fileName}" (${result.pageImagePaths.length} page(s)).`,
        ...notes,
        "Call render_and_qa_docx with this document_id to check the pages before you finalize your report.",
      ].join(" "),
    };
  },
};

// Page images one render_and_qa_docx call returns at most; the model asks
// for further ranges with first_page / last_page.
const MAX_PAGES_PER_RENDER = 20;
// Largest stored Word file render_and_qa_docx will download and convert.
const MAX_RENDER_DOCX_BYTES = 50 * 1024 * 1024;
// JSON around one page in a request (its "Page N of M" text block and the
// image block's fields), on top of the base64 data itself.
const RENDERED_PAGE_JSON_OVERHEAD_BYTES = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Finds a document's rendered pages: one generated earlier in this run, or
 * any clean Word document on the matter (rendered now, and kept on ctx for
 * cleanup and later calls). Returns an error string the model can act on
 * instead of throwing.
 */
async function pagesForDocument(
  documentId: string,
  ctx: ToolExecutionContext
): Promise<GeneratedDocumentEntry | string> {
  const known = ctx.generatedDocuments.get(documentId);
  if (known) return known;
  if (!UUID.test(documentId)) return `Unknown document_id: ${documentId}`;

  const doc = await getMatterDocument(ctx.tenantId, ctx.matterId, documentId);
  if (!doc) return `Unknown document_id: ${documentId} (no document with that id on this matter)`;
  if (detectFileKind({ mimeType: doc.mimeType, fileName: doc.fileName }).kind !== "docx") {
    return `Document ${documentId} ("${doc.fileName}") is not a Word document; only .docx files can be rendered.`;
  }
  if (doc.malwareScanStatus !== "clean") {
    return `Document ${documentId} ("${doc.fileName}") has not passed the malware scan (status: ${doc.malwareScanStatus}), so it is not rendered.`;
  }

  let bytes: Buffer;
  try {
    // The version the malware scan read, never bytes written to the key since.
    bytes = await getObjectBytes({
      bucket: doc.s3Bucket,
      key: doc.s3Key,
      versionId: doc.s3VersionId,
      maxBytes: MAX_RENDER_DOCX_BYTES,
    });
  } catch (err) {
    return `Could not read ${doc.fileName}: ${err instanceof Error ? err.message : String(err)}`;
  }
  // LibreOffice picks its import filter from the content, not the name, so
  // only a package that declares itself a Word document is rendered.
  if (
    detectFileKind({ bytes, mimeType: doc.mimeType, fileName: doc.fileName }).kind !== "docx" ||
    !isWordprocessingDocument(bytes)
  ) {
    return `Document ${documentId} ("${doc.fileName}") is named as a Word document but its content is not a .docx (WordprocessingML) package, so it is not rendered.`;
  }
  let rendered;
  try {
    rendered = await renderDocxToImages({ docxBytes: bytes, fileName: doc.fileName });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const entry: GeneratedDocumentEntry = {
    documentRowId: doc.id,
    pageImagePaths: rendered.pageImagePaths,
    workDir: rendered.workDir,
    origin: "matter",
  };
  ctx.generatedDocuments.set(doc.id, entry);
  return entry;
}

export const renderAndQaDocxTool: SkillTool = {
  definition: {
    name: "render_and_qa_docx",
    description:
      "Render a document's pages as images so you can check layout before finalizing: caption and headings, pagination, spacing, tables, and that the signature block is not stranded on its own page. " +
      "Takes a document_id returned earlier in this run by a generator, form or packet tool (a Word file, or a PDF such as a filled form), or the id of a Word document already on the matter. " +
      `Returns at most ${MAX_PAGES_PER_RENDER} pages per call; use first_page / last_page for the rest. Page images are limited per run, so render only the pages you need.`,
    input_schema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        first_page: { type: "integer", minimum: 1, description: "First page to render (default 1)." },
        last_page: { type: "integer", minimum: 1, description: "Last page to render (default: as many as fit)." },
      },
      required: ["document_id"],
    },
  },
  execute: async (input, ctx) => {
    const { document_id, first_page, last_page } = (input ?? {}) as {
      document_id?: unknown;
      first_page?: unknown;
      last_page?: unknown;
    };
    if (typeof document_id !== "string" || !document_id) {
      return { content: "Missing required field: document_id", isError: true };
    }

    const entry = await pagesForDocument(document_id.trim(), ctx);
    if (typeof entry === "string") return { content: entry, isError: true };

    const total = entry.pageImagePaths.length;
    if (total === 0) return { content: "The document rendered to zero pages.", isError: true };
    const first = Number.isInteger(first_page) ? Math.max(1, first_page as number) : 1;
    if (first > total) return { content: `The document has ${total} page(s); first_page ${first} is past the end.`, isError: true };
    const requestedLast = Number.isInteger(last_page) ? Math.min(total, last_page as number) : total;
    if (requestedLast < first) return { content: "last_page is before first_page.", isError: true };

    const remaining = ctx.toolImages.budget - ctx.toolImages.used;
    if (remaining <= 0) {
      return {
        content: `The document has ${total} page(s), but no more page images can be shown in this run (limit ${ctx.toolImages.budget}). Rely on the pages already rendered.`,
        isError: true,
      };
    }
    const lastByCount = Math.min(requestedLast, first + MAX_PAGES_PER_RENDER - 1, first + remaining - 1);

    // Each image stays in every later request of the run, so stop before
    // the request would pass the API's size limit.
    const blocks: Anthropic.ToolResultBlockParam["content"] = [];
    let last = first - 1;
    let stoppedBySize = false;
    for (let page = first; page <= lastByCount; page++) {
      const data = (await readGeneratedFile(entry.pageImagePaths[page - 1], "pageImage")).toString("base64");
      const cost = data.length + RENDERED_PAGE_JSON_OVERHEAD_BYTES;
      if (ctx.requestBytes.used + cost > ctx.requestBytes.limit) {
        stoppedBySize = true;
        break;
      }
      ctx.requestBytes.used += cost;
      blocks.push({ type: "text", text: `Page ${page} of ${total}:` });
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
      last = page;
    }
    if (last < first) {
      return {
        content:
          `The document has ${total} page(s), but the conversation is too close to the API's request size limit to show another page image. ` +
          "Rely on the pages already rendered, and finish without rendering more.",
        isError: true,
      };
    }
    ctx.toolImages.used += last - first + 1;

    const notes = [`The document has ${total} page(s); pages ${first}-${last} are shown below.`];
    if (stoppedBySize) {
      notes.push(
        `The render stopped at page ${last} because the conversation is close to the API's request size limit; do not render more pages in this run.`
      );
    } else if (last < requestedLast) {
      notes.push(
        last - first + 1 === MAX_PAGES_PER_RENDER && last < first + remaining - 1
          ? `Call again with first_page ${last + 1} for the rest.`
          : `The run's page-image limit stopped the render at page ${last}; ${Math.max(0, remaining - (last - first + 1))} image(s) remain for this run.`
      );
    }
    return { content: [{ type: "text", text: notes.join(" ") }, ...blocks] };
  },
};

/**
 * Every extra tool a skill can ask for, by key (see ./tool-keys.ts). A skill
 * module lists the keys it needs in its `tools` array; getSkillTools
 * resolves them here. Typed Record<ToolKey, SkillTool> so every key in
 * TOOL_KEYS must have an implementation. One entry per line, alphabetical.
 */
const TOOL_REGISTRY: Record<ToolKey, SkillTool> = {
  build_fee_packet: buildFeePacketTool,
  eoir_judge_profile: eoirJudgeProfileTool,
  fetch_ecfr_section: fetchEcfrSectionTool,
  fetch_uscis_page: { definition: fetchUscisPageTool.definition, execute: executeFetchWithLogging },
  fill_pdf_form_packet_build: fillPacketBuildPdfFormTool,
  fill_pdf_form_vawa: fillVawaPdfFormTool,
  fill_uscis_form_pdf_i90: fillUscisFormPdfTool,
  generate_document: generateDocumentTool,
  generate_docx_eoir_pleadings: generateEoirWrittenPleadingsDocxTool,
  generate_docx_i130: generateI130ExpediteDocxTool,
  list_pdf_form_fields_packet_build: listPacketBuildPdfFormFieldsTool,
  list_pdf_form_fields_vawa: listVawaPdfFormFieldsTool,
  load_companion_skill_packet_build: loadPacketBuildCompanionSkillTool,
  load_motion_references_legal_argument_research: loadMotionReferencesTool,
  load_qa_gate_skill_asylum_interview_prep: loadAsylumInterviewPrepReviewTool,
  load_qa_gate_skill_i90_packet_review: loadI90PacketReviewTool,
  load_qa_gate_skill_orthography_check: loadOrthographyCheckTool,
  load_qa_gate_skill_vawa_packet_review: loadVawaPacketReviewTool,
  lookup_library_citation: lookupLibraryCitationTool,
  make_corrected_copy_orthography: makeCorrectedCopyTool,
  query_eoir_stats: queryEoirStatsTool,
  read_library_document: readLibraryDocumentTool,
  read_prior_skill_reports: readPriorSkillReportsTool,
  render_and_qa_docx: renderAndQaDocxTool,
  search_eoir_judges: searchEoirJudgesTool,
  search_library: searchLibraryTool,
};

/** Tool keys whose results contain images (they count toward the API's per-request image rules). */
export const IMAGE_RETURNING_TOOL_KEYS: readonly ToolKey[] = ["render_and_qa_docx"];

/**
 * Extra tools (beyond submit_report) a skill's agentic loop gets, keyed by
 * the model-facing tool name (what tool_use.name will be), in the order the
 * skill module lists them. Throws for an unregistered skill.
 */
export function getSkillTools(skillName: string): Record<string, SkillTool> {
  const skill = getSkillModule(skillName);
  const resolved: Record<string, SkillTool> = {};
  for (const key of skill.tools) {
    const tool = TOOL_REGISTRY[key];
    if (!tool) throw new Error(`Skill "${skillName}" asks for unknown tool key "${key}"`);
    const toolName = tool.definition.name;
    if (toolName === "submit_report" || resolved[toolName]) {
      throw new Error(
        `Skill "${skillName}" resolves two tools to the model-facing name "${toolName}"; each tool a skill uses needs a distinct name`
      );
    }
    resolved[toolName] = tool;
  }
  return resolved;
}

export async function cleanupGeneratedDocuments(ctx: ToolExecutionContext): Promise<void> {
  for (const entry of ctx.generatedDocuments.values()) {
    await cleanupWorkDir(entry.workDir);
  }
}
