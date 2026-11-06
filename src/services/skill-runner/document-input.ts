import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { documents } from "@/db/schema";
import { getObjectBytes, S3ObjectTooLargeError } from "@/lib/s3";
import { describeErrorForLog, safeErrorMessage } from "@/lib/errors/safe-error";
import { detectFileKind, readImageDimensions, type ImageMediaType } from "@/lib/documents/file-kind";

/**
 * Builds the matter-documents part of a skill run's first user message.
 * PDFs (scanned ones included) go to the model as base64 `document` blocks
 * and JPEG/PNG/GIF/WebP files as base64 `image` blocks, each preceded by a
 * text label naming the file, its type and version, so the skill can cite
 * documents by name. Word, plain-text and other files go in as their
 * extracted text (documents.extracted_text, written by the ingest job).
 *
 * Everything is admitted in a stable order within the API's request limits
 * (below). What doesn't fit is not an error: it falls back to its extracted
 * text when there is room, and otherwise is listed in the inventory as not
 * reviewed, so the model reports it instead of the run failing.
 *
 * Fails closed on the malware scan: only documents whose scan came back
 * "clean" are given to the model, read at the S3 object version the scan
 * read. Infected documents are listed as excluded; documents not scanned
 * yet ("pending") or that could not be scanned ("error") are listed as not
 * reviewed, with the reason.
 */

type DocumentRow = typeof documents.$inferSelect;

// --- Limits -----------------------------------------------------------------
// From the Claude API docs (PDF support, Vision). Every loop iteration resends
// the first message, so these bound every request of the run, not just the first.

// The whole request may be 32 MB. By default attachments get 24 MB of
// base64, leaving room for the system prompt (SKILL.md, references, practice
// profile), the extracted text and the loop's growing history. Skills whose
// tools add bytes to every later request (render_and_qa_docx page images,
// web_fetch PDFs) get less (maxNativeBase64Bytes, set by run.ts), and the
// runner tracks the whole request's size as the run goes (see run.ts).
export const DEFAULT_MAX_NATIVE_BASE64_BYTES = 24 * 1024 * 1024;
// 600 PDF pages per request on 1M-context models; stay a little under.
const MAX_NATIVE_PDF_PAGES = 550;
// Per-image limits: 10 MB base64 on the Claude API (decimal MB, to be safe),
// 8000 px per side.
const MAX_IMAGE_BASE64_BYTES = 10_000_000;
const MAX_IMAGE_SIDE_PX = 8000;
// With more than 20 images in one request, every image in it must be at most
// 2000 px per side, including images that arrive later in tool results.
const MANY_IMAGE_THRESHOLD = 20;
const MANY_IMAGE_MAX_SIDE_PX = 2000;
// The API allows 600 images per request; the token budget binds far sooner.
const MAX_NATIVE_IMAGES = 100;
// Share of the model's 1M-token context window for matter documents. The rest
// is for the system prompt and up to MAX_ITERATIONS turns of history.
const DOCUMENT_TOKEN_BUDGET = 550_000;

// Token estimates, used until messages.countTokens gives exact numbers (and
// instead of them if counting fails). PDF pages cost their text (about
// 1,500-3,000 tokens) plus a page image; images cost one token per 28x28 px
// patch after downscaling to 2576 px on the long edge, at most 4784.
const EST_TOKENS_PER_PDF_PAGE = 3_500;
const MAX_TOKENS_PER_IMAGE = 4_784;
const IMAGE_MAX_LONG_EDGE_PX = 2576;
const EST_CHARS_PER_TEXT_TOKEN = 3;
// For a PDF the ingest job hasn't measured and whose page tree can't be read
// from the raw bytes (compressed object streams), assume a page per this many
// bytes. Only the page limit depends on it; tokens are counted exactly.
const UNKNOWN_PDF_BYTES_PER_PAGE = 25_000;

export type DocumentDisposition =
  /** Attached natively as a PDF document block. */
  | "pdf"
  /** Attached natively as an image block. */
  | "image"
  /** Its extracted text is attached (layout, images and handwriting not visible). */
  | "text"
  /**
   * Not given to the model at all; `reason` says why. Includes documents not
   * scanned yet or that could not be scanned (the gate fails closed).
   */
  | "not_reviewed"
  /** Flagged infected by the malware scan; never given to the model. */
  | "excluded_infected";

/** One matter document and how this run gave it to the model. JSON-safe (stored on skill_runs.input_snapshot). */
export type DocumentInventoryEntry = {
  documentId: string;
  version: number;
  /** 1-based position in upload order; the "Document N" in labels. */
  index: number;
  fileName: string;
  type: string;
  mimeType: string | null;
  disposition: DocumentDisposition;
  /** PDF page count, when known. */
  pages: number | null;
  /**
   * For "text": why a PDF or image went in as extracted text instead of
   * natively (null for Word and text files, which only have text). For
   * "not_reviewed" and "excluded_infected": why it was not provided at all.
   */
  reason: string | null;
};

export type PreparedDocumentInput = {
  /** Label + content blocks for the first user message, in upload order. */
  blocks: Anthropic.ContentBlockParam[];
  inventory: DocumentInventoryEntry[];
  /**
   * The images attached natively, for sizing what tool results may add: above
   * ${MANY_IMAGE_THRESHOLD} images per request every image must be at most ${MANY_IMAGE_MAX_SIDE_PX} px per side.
   */
  attachedImages: { count: number; allAtMost2000Px: boolean };
};

export type PrepareDocumentInputOptions = {
  /**
   * Image slots to leave free under the 20-image threshold for images the
   * skill's own tools return later in the run (render_and_qa_docx pages).
   */
  reservedToolImageSlots: number;
  /** Exact input-token count of some user-content blocks (messages.countTokens); null if it fails. */
  countTokens?: (blocks: Anthropic.ContentBlockParam[]) => Promise<number | null>;
  /** Attach nothing natively, for this reason; every document falls back to its extracted text. */
  nativeDisabledReason?: string;
  /** Base64 bytes all native attachments together may take (default DEFAULT_MAX_NATIVE_BASE64_BYTES). */
  maxNativeBase64Bytes?: number;
};

type NativeAttachment =
  | { kind: "pdf"; base64: string; pages: number; pagesKnown: boolean }
  | { kind: "image"; base64: string; mediaType: ImageMediaType; width: number | null; height: number | null };

type Candidate = {
  doc: DocumentRow;
  index: number;
  native: NativeAttachment | null;
  /** Why a PDF or image could not be attached natively at all (decided before budgeting). */
  nativeUnavailableReason: string | null;
  text: string | null;
  nativeTokens: number;
  textTokens: number;
};

type Selection = { disposition: DocumentDisposition; reason: string | null };

export async function prepareDocumentInput(
  matterDocuments: DocumentRow[],
  options: PrepareDocumentInputOptions
): Promise<PreparedDocumentInput> {
  const ordered = [...matterDocuments].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  const maxNativeBase64 = options.maxNativeBase64Bytes ?? DEFAULT_MAX_NATIVE_BASE64_BYTES;
  const candidates: Candidate[] = [];
  const excluded: DocumentRow[] = [];
  const unscanned: DocumentRow[] = [];
  let downloadedBase64Bytes = 0;

  for (const doc of ordered) {
    if (doc.malwareScanStatus === "infected") {
      excluded.push(doc);
      continue;
    }
    if (doc.malwareScanStatus !== "clean") {
      unscanned.push(doc);
      continue;
    }
    const text = doc.extractedText?.trim() ? doc.extractedText.trim() : null;
    let native: NativeAttachment | null = null;
    let nativeUnavailableReason: string | null = null;

    const guess = detectFileKind({ mimeType: doc.mimeType, fileName: doc.fileName });
    if (guess.kind === "pdf" || guess.kind === "image") {
      if (options.nativeDisabledReason) {
        nativeUnavailableReason = options.nativeDisabledReason;
      } else {
        const loaded = await loadNative(doc, guess.kind, maxNativeBase64 - downloadedBase64Bytes, maxNativeBase64);
        native = loaded.native;
        nativeUnavailableReason = loaded.reason;
        if (native) downloadedBase64Bytes += native.base64.length;
      }
    }

    candidates.push({
      doc,
      index: 0, // assigned below, once the documents left out are known
      native,
      nativeUnavailableReason,
      text,
      nativeTokens: native ? estimateNativeTokens(native) : 0,
      textTokens: text ? Math.ceil(text.length / EST_CHARS_PER_TEXT_TOKEN) : 0,
    });
  }

  // Number every document, the ones left out included, in upload order.
  const indexById = new Map(ordered.map((d, i) => [d.id, i + 1]));
  for (const c of candidates) c.index = indexById.get(c.doc.id)!;
  const total = ordered.length;

  const firstPass = select(candidates, options.reservedToolImageSlots, maxNativeBase64);
  let selection = firstPass.selection;

  // Estimates can be off in either direction (dense scans, non-Latin text).
  // When they turned nothing away, one exact count of the whole selection
  // confirms it fits. When they did turn something away, or the exact total
  // is over budget, count each document exactly and select again.
  if (options.countTokens) {
    let recount = firstPass.tokenLimited;
    if (!recount) {
      const blocks = buildBlocks(candidates, selection, total);
      const exactTotal = blocks.length ? await options.countTokens(blocks) : 0;
      recount = exactTotal !== null && exactTotal > DOCUMENT_TOKEN_BUDGET;
    }
    if (recount) {
      await countEachExactly(candidates, total, options.countTokens);
      selection = select(candidates, options.reservedToolImageSlots, maxNativeBase64).selection;
    }
  }

  const inventory: DocumentInventoryEntry[] = [
    ...candidates.map((c) => {
      const s = selection.get(c)!;
      return inventoryEntry(c.doc, c.index, s.disposition, s.reason, c.native?.kind === "pdf" ? c.native : null);
    }),
    ...excluded.map((doc) =>
      inventoryEntry(doc, indexById.get(doc.id)!, "excluded_infected", "the malware scan flagged it as infected", null)
    ),
    ...unscanned.map((doc) => inventoryEntry(doc, indexById.get(doc.id)!, "not_reviewed", unscannedReason(doc), null)),
  ].sort((a, b) => a.index - b.index);

  const attached = candidates.filter((c) => selection.get(c)!.disposition === "image");
  return {
    blocks: buildBlocks(candidates, selection, total),
    inventory,
    attachedImages: { count: attached.length, allAtMost2000Px: attached.every((c) => isSmallImage(c.native!)) },
  };
}

// ---------------------------------------------------------------------------
// Loading a PDF or image from S3
// ---------------------------------------------------------------------------

async function loadNative(
  doc: DocumentRow,
  guessedKind: "pdf" | "image",
  remainingBase64Bytes: number,
  maxNativeBase64: number
): Promise<{ native: NativeAttachment | null; reason: string | null }> {
  const perFileBase64Limit = guessedKind === "image" ? Math.min(MAX_IMAGE_BASE64_BYTES, maxNativeBase64) : maxNativeBase64;
  const limitBase64 = Math.min(perFileBase64Limit, remainingBase64Bytes);
  const limitRawBytes = Math.floor((limitBase64 * 3) / 4);

  // Skip the download when the budget or the recorded size already rules it out.
  if (limitRawBytes <= 0) {
    return { native: null, reason: "it did not fit in what was left of the run's attachment size limit after earlier documents" };
  }
  if (doc.sizeBytes !== null && doc.sizeBytes > limitRawBytes) {
    return { native: null, reason: sizeReason(doc.sizeBytes, guessedKind, limitBase64 < perFileBase64Limit) };
  }

  let bytes: Buffer;
  try {
    // The object version the malware scan read: bytes written to the key
    // after the scan never reach the model.
    bytes = await getObjectBytes({
      bucket: doc.s3Bucket,
      key: doc.s3Key,
      versionId: doc.s3VersionId,
      maxBytes: limitRawBytes,
    });
  } catch (err) {
    if (err instanceof S3ObjectTooLargeError) {
      return { native: null, reason: sizeReason(err.sizeBytes, guessedKind, limitBase64 < perFileBase64Limit) };
    }
    if (err instanceof Error && (err.name === "NoSuchKey" || err.name === "NotFound")) {
      return { native: null, reason: "the file was not found in storage (the upload may not have finished)" };
    }
    // S3 error messages can name the object's key, which carries the file name.
    console.warn(`[document-input] could not load document ${doc.id} from S3: ${describeErrorForLog(err)}`);
    return {
      native: null,
      reason: `the file could not be loaded from storage (${safeErrorMessage(err)})`,
    };
  }

  const kind = detectFileKind({ bytes, mimeType: doc.mimeType, fileName: doc.fileName });
  if (kind.kind === "pdf") {
    if (bytes.includes("/Encrypt")) {
      return { native: null, reason: "the PDF is encrypted or password-protected, and the API accepts only unencrypted PDFs" };
    }
    const measured = doc.pageCount ?? estimatePdfPageCount(bytes);
    return {
      native: {
        kind: "pdf",
        base64: bytes.toString("base64"),
        pages: measured ?? Math.max(1, Math.ceil(bytes.length / UNKNOWN_PDF_BYTES_PER_PAGE)),
        pagesKnown: measured !== null,
      },
      reason: null,
    };
  }
  if (kind.kind === "image") {
    const dims = readImageDimensions(bytes, kind.mediaType);
    if (dims && Math.max(dims.width, dims.height) > MAX_IMAGE_SIDE_PX) {
      return {
        native: null,
        reason: `the image is ${dims.width}x${dims.height} px, over the API's ${MAX_IMAGE_SIDE_PX} px limit per side`,
      };
    }
    const base64 = bytes.toString("base64");
    if (base64.length > MAX_IMAGE_BASE64_BYTES) {
      return { native: null, reason: sizeReason(bytes.length, "image", false) };
    }
    return {
      native: {
        kind: "image",
        base64,
        mediaType: kind.mediaType,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      },
      reason: null,
    };
  }
  return {
    native: null,
    reason: `its content is not a PDF or a JPEG, PNG, GIF or WebP image, although its name or type says ${guessedKind === "pdf" ? "PDF" : "image"}`,
  };
}

function sizeReason(sizeBytes: number, kind: "pdf" | "image", budgetUsedByEarlierDocs: boolean): string {
  const mb = `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  if (budgetUsedByEarlierDocs) {
    return `the file (${mb}) did not fit in what was left of the run's attachment size limit after earlier documents`;
  }
  return kind === "image"
    ? `the image (${mb}) is larger than the API accepts for one image`
    : `the PDF (${mb}) is larger than the API accepts in one request`;
}

/**
 * Page count read from the raw PDF without a parser: the page tree root's
 * /Count, or failing that the number of /Type /Page objects. Both are hidden
 * when the PDF keeps its objects in compressed object streams; then null.
 */
function estimatePdfPageCount(bytes: Buffer): number | null {
  const raw = bytes.toString("latin1");
  let maxCount = 0;
  for (const m of raw.matchAll(/\/Count\s+(\d+)/g)) maxCount = Math.max(maxCount, Number(m[1]));
  if (maxCount > 0) return maxCount;
  const pageObjects = raw.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  return pageObjects > 0 ? pageObjects : null;
}

function estimateNativeTokens(native: NativeAttachment): number {
  if (native.kind === "pdf") return native.pages * EST_TOKENS_PER_PDF_PAGE;
  if (native.width === null || native.height === null) return MAX_TOKENS_PER_IMAGE;
  const scale = Math.min(1, IMAGE_MAX_LONG_EDGE_PX / Math.max(native.width, native.height));
  const patches = Math.ceil((native.width * scale) / 28) * Math.ceil((native.height * scale) / 28);
  return Math.min(MAX_TOKENS_PER_IMAGE, patches);
}

function isSmallImage(native: NativeAttachment): boolean {
  return (
    native.kind === "image" &&
    native.width !== null &&
    native.height !== null &&
    Math.max(native.width, native.height) <= MANY_IMAGE_MAX_SIDE_PX
  );
}

// ---------------------------------------------------------------------------
// Selection within the budgets
// ---------------------------------------------------------------------------

/**
 * Decides each candidate's disposition, deterministically, in three passes:
 * text-only documents first (they are small and often central, like a
 * declaration in Word), then PDFs and images natively in upload order while
 * every limit holds, then the PDFs that didn't fit fall back to their
 * extracted text while the token budget allows.
 */
function select(
  candidates: Candidate[],
  reservedToolImageSlots: number,
  maxNativeBase64: number
): { selection: Map<Candidate, Selection>; tokenLimited: boolean } {
  const result = new Map<Candidate, Selection>();
  let tokens = 0;
  let base64Bytes = 0;
  let pdfPages = 0;
  let images = 0;
  // Whether the token budget (rather than a hard API limit) turned anything away.
  let tokenLimited = false;

  const fitsText = (c: Candidate) => {
    if (c.text === null) return false;
    if (tokens + c.textTokens <= DOCUMENT_TOKEN_BUDGET) return true;
    tokenLimited = true;
    return false;
  };

  // Pass 1: documents with no native form.
  for (const c of candidates) {
    if (c.native) continue;
    if (fitsText(c)) {
      tokens += c.textTokens;
      result.set(c, { disposition: "text", reason: c.nativeUnavailableReason });
    } else {
      result.set(c, { disposition: "not_reviewed", reason: notReviewedReason(c, c.nativeUnavailableReason) });
    }
  }

  // Images: above 20 in one request, every image must be at most 2000 px per
  // side. Either keep to the first (20 - reserved) images of any size, or
  // take only images known to be small; whichever admits more.
  const nativeImages = candidates.filter((c) => c.native?.kind === "image");
  const fewLimit = Math.max(0, MANY_IMAGE_THRESHOLD - reservedToolImageSlots);
  const smallImages = nativeImages.filter((c) => isSmallImage(c.native!)).length;
  const manyMode = nativeImages.length > fewLimit && smallImages > fewLimit;

  // Pass 2: PDFs and images natively.
  const fallbacks: { c: Candidate; reason: string }[] = [];
  for (const c of candidates) {
    const native = c.native;
    if (!native) continue;
    let reason: string | null = null;
    if (base64Bytes + native.base64.length > maxNativeBase64) {
      reason = "it did not fit in what was left of the run's attachment size limit after earlier documents";
    } else if (native.kind === "pdf" && pdfPages + native.pages > MAX_NATIVE_PDF_PAGES) {
      reason = `it would take the run past the API's limit of ${MAX_NATIVE_PDF_PAGES} PDF pages per request`;
    } else if (native.kind === "image" && images >= MAX_NATIVE_IMAGES) {
      reason = `the run already attaches ${MAX_NATIVE_IMAGES} images`;
    } else if (native.kind === "image" && manyMode && !isSmallImage(native)) {
      reason =
        `this matter has more than ${MANY_IMAGE_THRESHOLD} images, and in that case the API accepts only images of at most ` +
        `${MANY_IMAGE_MAX_SIDE_PX} px per side; this one is larger (or its size could not be read). Resize it and upload it again`;
    } else if (native.kind === "image" && !manyMode && images >= fewLimit) {
      reason = `the run already attaches ${fewLimit} images, the most it can take at full size`;
    } else if (tokens + c.nativeTokens > DOCUMENT_TOKEN_BUDGET) {
      reason = "it did not fit in what was left of the run's context budget for documents after earlier documents";
      tokenLimited = true;
    }

    if (reason) {
      fallbacks.push({ c, reason });
      continue;
    }
    tokens += c.nativeTokens;
    base64Bytes += native.base64.length;
    if (native.kind === "pdf") pdfPages += native.pages;
    else images += 1;
    result.set(c, { disposition: native.kind, reason: null });
  }

  // Pass 3: extracted text for what didn't fit natively.
  for (const { c, reason } of fallbacks) {
    if (fitsText(c)) {
      tokens += c.textTokens;
      result.set(c, { disposition: "text", reason });
    } else {
      result.set(c, { disposition: "not_reviewed", reason: notReviewedReason(c, reason) });
    }
  }
  return { selection: result, tokenLimited };
}

function notReviewedReason(c: Candidate, nativeReason: string | null): string {
  if (c.text !== null) {
    const textReason = "its extracted text did not fit in what was left of the run's context budget for documents";
    return nativeReason ? `${nativeReason}, and ${textReason}` : textReason;
  }
  if (nativeReason) return `${nativeReason}, and it has no extracted text to fall back on`;
  const { doc } = c;
  // Only clean documents are candidates; an app-generated one is clean
  // before its text extraction has run.
  if (doc.ingestedAt === null) {
    return "its text extraction has not finished yet";
  }
  if (detectFileKind({ mimeType: doc.mimeType, fileName: doc.fileName }).kind === "other") {
    return `its file type (${doc.mimeType || "unknown"}) cannot be read directly and has no text extraction; convert it to PDF, an image (JPEG or PNG), or Word`;
  }
  return "no text could be extracted from it";
}

// ---------------------------------------------------------------------------
// Blocks, labels, exact counting
// ---------------------------------------------------------------------------

function blocksFor(c: Candidate, disposition: DocumentDisposition, total: number): Anthropic.ContentBlockParam[] {
  const label = labelFor(c, disposition, total);
  if (disposition === "pdf" && c.native?.kind === "pdf") {
    return [
      { type: "text", text: label },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: c.native.base64 },
        title: displayFileName(c.doc.fileName),
      },
    ];
  }
  if (disposition === "image" && c.native?.kind === "image") {
    return [
      { type: "text", text: label },
      { type: "image", source: { type: "base64", media_type: c.native.mediaType, data: c.native.base64 } },
    ];
  }
  if (disposition === "text" && c.text !== null) {
    return [
      {
        type: "text",
        text: `${label}\n\n----- BEGIN UNTRUSTED DOCUMENT CONTENT -----\n${neutralizeRunnerMarkers(c.text)}\n----- END UNTRUSTED DOCUMENT CONTENT -----\n\n[End of Document ${c.index}]`,
      },
    ];
  }
  return [];
}

/**
 * A document's file name as the model sees it, in its label and in the
 * inventory: the name arrives from the uploader's browser, so line breaks
 * and other control characters (which could start what looks like a new
 * section of the message) become spaces.
 */
function displayFileName(fileName: string): string {
  // Control characters, DEL, and the Unicode line and paragraph separators.
  const cleaned = Array.from(fileName, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 ? " " : ch;
  }).join("");
  return cleaned.replace(/ {2,}/g, " ").trim() || "(unnamed)";
}

// Lines of the runner's own framing that a document's text could imitate to
// pass itself off as the end of the document, the next document, or a
// section of the message (the attorney's note above all). The rule the model
// is given is CASE_FILE_CONTENT_SECTION in prompt.ts.
const RUNNER_HEADING =
  /^([ \t]*)(#{1,6})(?=[ \t]*(?:attorney['\u2019]?s note|matter|documents|case file content|firm identity|practice_profile|recent legal updates|how this app runs the skill)\b)/gim;
const DOCUMENT_LABEL_LINE = /^([ \t]*)(?=document \d+ of \d+:)/gim;
const END_OF_DOCUMENT = /\[(?=[ \t]*end of document\b)/gi;
const UNTRUSTED_FENCE = /----- (?:BEGIN|END) UNTRUSTED DOCUMENT CONTENT -----/gi;

/**
 * A text-only document's text with its copies of the runner's markers
 * marked as quoted, so "[End of Document 3]" or "## Attorney's note" inside
 * a document cannot read as the runner's own. Everything else is unchanged.
 */
export function neutralizeRunnerMarkers(text: string): string {
  return text
    .replace(UNTRUSTED_FENCE, "[quoted from the document: untrusted fence]")
    .replace(END_OF_DOCUMENT, "[quoted from the document: ")
    .replace(RUNNER_HEADING, "$1[quoted from the document] $2")
    .replace(DOCUMENT_LABEL_LINE, "$1[quoted from the document] ");
}

function buildBlocks(candidates: Candidate[], selection: Map<Candidate, Selection>, total: number) {
  return candidates.flatMap((c) => blocksFor(c, selection.get(c)!.disposition, total));
}

function labelFor(c: Candidate, disposition: DocumentDisposition, total: number): string {
  const { doc } = c;
  let format = "";
  if (disposition === "pdf" && c.native?.kind === "pdf") {
    format = c.native.pagesKnown ? `PDF, ${c.native.pages} page${c.native.pages === 1 ? "" : "s"}` : "PDF";
  } else if (disposition === "image" && c.native?.kind === "image") {
    format = c.native.width ? `image, ${c.native.width}x${c.native.height} px` : "image";
  } else {
    format = "extracted text only";
  }
  return `Document ${c.index} of ${total}: "${displayFileName(doc.fileName)}" (${doc.type.replace(/_/g, " ")}, version ${doc.version}, ${format})`;
}

/** Replaces each candidate's token estimates with exact counts where counting works. */
async function countEachExactly(
  candidates: Candidate[],
  total: number,
  countTokens: NonNullable<PrepareDocumentInputOptions["countTokens"]>
) {
  const jobs: (() => Promise<void>)[] = [];
  for (const c of candidates) {
    if (c.native) {
      jobs.push(async () => {
        const n = await countTokens(blocksFor(c, c.native!.kind, total));
        if (n !== null) c.nativeTokens = n;
      });
    }
    if (c.text !== null) {
      jobs.push(async () => {
        const n = await countTokens(blocksFor(c, "text", total));
        if (n !== null) c.textTokens = n;
      });
    }
  }
  // A few at a time, to stay friendly to the token-counting rate limit.
  for (let i = 0; i < jobs.length; i += 4) {
    await Promise.all(jobs.slice(i, i + 4).map((job) => job()));
  }
}

/** Why a document that has not passed the malware scan is not given to the model. */
function unscannedReason(doc: DocumentRow): string {
  if (doc.malwareScanStatus === "pending") {
    return "its malware scan has not finished yet, and only files that scanned clean are given to skill runs";
  }
  if (doc.malwareScanStatus === "error") {
    return "it could not be scanned for malware (the note on the document in the matter's documents list says why), and only files that scanned clean are given to skill runs";
  }
  return `its malware scan status is "${doc.malwareScanStatus}", and only files that scanned clean are given to skill runs`;
}

function inventoryEntry(
  doc: DocumentRow,
  index: number,
  disposition: DocumentDisposition,
  reason: string | null,
  pdf: { pages: number; pagesKnown: boolean } | null
): DocumentInventoryEntry {
  return {
    documentId: doc.id,
    version: doc.version,
    index,
    fileName: displayFileName(doc.fileName),
    type: doc.type,
    mimeType: doc.mimeType,
    disposition,
    pages: pdf?.pagesKnown ? pdf.pages : (doc.pageCount ?? null),
    reason,
  };
}
