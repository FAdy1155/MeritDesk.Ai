import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { withTenantContext } from "@/db/client";
import { documents } from "@/db/schema";
import { getObjectVersionBytes, S3ObjectTooLargeError } from "@/lib/s3";
import { detectFileKind, type FileKind } from "@/lib/documents/file-kind";
import {
  describeUntrustedToolSandbox,
  execUntrusted,
  readToolOutputHead,
  UntrustedToolSandboxError,
} from "@/services/sandbox/untrusted-exec";
import { runClamScan } from "./clamav";

/**
 * The document-ingest job (queue "document-ingest", run by src/worker.ts):
 * download an uploaded document from S3, scan it with ClamAV, and extract
 * its text into documents.extracted_text so skill runs can read file types
 * the model can't take natively (Word, plain text) and fall back to text
 * for PDFs that don't fit a run's attachment budget.
 *
 * Runs on the worker image (Dockerfile.worker: clamav, poppler-utils,
 * python3 + python-docx). Each missing binary fails its own step with a
 * plain message in documents.ingestion_note; a missing scanner always means
 * status "error", never "clean". Not available on a Windows dev machine.
 * Every tool runs through execUntrusted (src/services/sandbox/untrusted-exec.ts):
 * no secrets in its environment, and on the worker image as an unprivileged
 * user of its own with no network. What an extractor writes is read only up
 * to MAX_EXTRACTED_TEXT_BYTES, however much it wrote, so a small file that
 * expands to gigabytes of text cannot run the worker out of memory.
 *
 * The scan result is tied to the bytes scanned: the job records the S3
 * object version it read (documents.s3_version_id) together with "clean",
 * and downloads and skill runs read only that version, so a second PUT
 * through a still-valid upload URL is never served. Status changes are
 * conditional on the status the job started from, so a slower duplicate job
 * can never overwrite another job's result (an "infected" never becomes
 * "clean").
 */

// Largest upload the job will download and scan. Bigger files are marked
// "error" (not scanned) rather than read into the worker's memory.
const MAX_INGEST_BYTES = 150 * 1024 * 1024;
// Cap on stored extracted text (about 125K tokens of English). Longer text
// is cut with a visible marker; the skill runner reads PDFs natively anyway.
const MAX_EXTRACTED_TEXT_CHARS = 500_000;
// What is read of an extractor's output file: at most 4 bytes per stored
// character (UTF-8), so the cap above is reached without reading the rest.
const MAX_EXTRACTED_TEXT_BYTES = MAX_EXTRACTED_TEXT_CHARS * 4;
// clamscan loads the whole signature database on every run (tens of
// seconds on a small VM), so its timeout is generous.
const SCAN_TIMEOUT_MS = 8 * 60_000;
const EXTRACT_TIMEOUT_MS = 2 * 60_000;

const DOCX_TO_TEXT_SCRIPT = path.join(process.cwd(), "src", "services", "ingest", "docx_to_text.py");

type DocumentRow = typeof documents.$inferSelect;
type DocumentUpdate = Partial<typeof documents.$inferInsert>;

type ScanResult =
  | { status: "clean" }
  | { status: "infected"; signature: string }
  | { status: "error"; message: string };

type Extraction = { text: string | null; pageCount: number | null; note: string | null };

export async function processDocumentIngest(documentId: string, tenantId: string): Promise<void> {
  const doc = await withTenantContext(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
  });
  if (!doc) {
    console.warn(`[ingest] document ${documentId} not found; skipping.`);
    return;
  }

  // pending: a fresh upload (or a re-scan request) - scan, then extract.
  // clean without ingested_at: an app-generated document - extract only.
  // Anything else is already finished; infected files are never reopened,
  // and an errored one is only retried via requestDocumentIngest, which
  // resets it to pending.
  const needsScan = doc.malwareScanStatus === "pending";
  const extractOnly = doc.malwareScanStatus === "clean" && doc.ingestedAt === null;
  if (!needsScan && !extractOnly) {
    console.log(`[ingest] document ${documentId} is already "${doc.malwareScanStatus}"; skipping duplicate job.`);
    return;
  }
  const fromStatus = needsScan ? "pending" : "clean";

  // The scan reads the key's current object and pins the version it read;
  // extract-only reads the version already pinned (if there is one).
  let bytes: Buffer;
  let versionId: string | null;
  try {
    ({ bytes, versionId } = await getObjectVersionBytes({
      bucket: doc.s3Bucket,
      key: doc.s3Key,
      versionId: needsScan ? null : doc.s3VersionId,
      maxBytes: MAX_INGEST_BYTES,
    }));
  } catch (err) {
    const note =
      err instanceof S3ObjectTooLargeError
        ? `The file is ${formatMb(err.sizeBytes)}, over the ${formatMb(MAX_INGEST_BYTES)} limit for scanning and text extraction, so it was not scanned. Split or compress it and upload it again.`
        : err instanceof Error && (err.name === "NoSuchKey" || err.name === "NotFound" || err.name === "NoSuchVersion")
          ? "The file was not found in storage. The upload may not have finished; upload it again."
          : null;
    if (note === null) throw err; // transient (network, credentials): let pg-boss retry the job
    await finish(doc, fromStatus, {
      malwareScanStatus: needsScan ? "error" : doc.malwareScanStatus,
      ingestionNote: note,
    });
    return;
  }

  if (needsScan && versionId === null) {
    // Without a version there is nothing to pin the result to: a later PUT
    // to the same key would be served as if it had been scanned.
    await finish(doc, "pending", {
      malwareScanStatus: "error",
      ingestionNote:
        "Not scanned: the documents bucket does not have versioning enabled, so a scan result could not be tied to these exact bytes. Turn on versioning for the bucket, then use Scan again.",
    });
    console.warn(`[ingest] document ${documentId}: bucket versioning is off; marked "error" without scanning.`);
    return;
  }
  if (!needsScan) versionId = doc.s3VersionId;

  const kind = detectFileKind({ bytes, mimeType: doc.mimeType, fileName: doc.fileName });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-"));
  try {
    const filePath = path.join(workDir, `document${extensionFor(kind)}`);
    await fs.writeFile(filePath, bytes);

    if (needsScan) {
      const scan = await scanWithClamAv(filePath, workDir);
      if (scan.status !== "clean") {
        const recorded = await finish(doc, "pending", {
          malwareScanStatus: scan.status,
          ingestionNote:
            scan.status === "infected"
              ? `ClamAV detected ${scan.signature}. The file is blocked from download and skill runs, and its text was not extracted.`
              : `${scan.message} Until it scans clean it cannot be downloaded and skill runs do not read it.`,
        });
        console.log(
          `[ingest] document ${documentId}: scan ${scan.status}` +
            (recorded ? "" : " (not recorded: another job already finished this document)")
        );
        return;
      }
      // Record the clean result, pinned to the version scanned, on its own,
      // so it stands even if extraction fails.
      const recorded = await transition(doc, eq(documents.malwareScanStatus, "pending"), {
        malwareScanStatus: "clean",
        s3VersionId: versionId,
      });
      if (!recorded) {
        console.log(`[ingest] document ${documentId}: scanned clean, but another job already finished it; leaving its result.`);
        return;
      }
    }

    const extraction = await extractText(kind, filePath, bytes, workDir);
    // Only onto the clean result for the version extracted, and only once.
    const recorded = await transition(
      doc,
      and(
        eq(documents.malwareScanStatus, "clean"),
        isNull(documents.ingestedAt),
        versionId === null ? isNull(documents.s3VersionId) : eq(documents.s3VersionId, versionId)
      )!,
      {
        extractedText: extraction.text,
        pageCount: extraction.pageCount,
        ingestionNote: extraction.note,
        ingestedAt: new Date(),
      }
    );
    console.log(
      `[ingest] document ${documentId}: clean, ${extraction.text ? `${extraction.text.length} chars extracted` : "no text extracted"}` +
        (recorded ? "" : " (not recorded: another job already finished this document)")
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Updates the document only while `condition` (on its current row) holds,
 * so two jobs for the same document cannot overwrite each other's outcome.
 * Returns whether the row was updated.
 */
async function transition(doc: DocumentRow, condition: SQL, values: DocumentUpdate): Promise<boolean> {
  const updated = await withTenantContext(doc.tenantId, (tx) =>
    tx
      .update(documents)
      .set(values)
      .where(and(eq(documents.id, doc.id), eq(documents.tenantId, doc.tenantId), condition))
      .returning({ id: documents.id })
  );
  return updated.length > 0;
}

/**
 * The job's last write for a document: its outcome plus ingested_at, and
 * only while the document is still in the state the job started from.
 */
async function finish(doc: DocumentRow, fromStatus: "pending" | "clean", values: DocumentUpdate): Promise<boolean> {
  const condition =
    fromStatus === "clean"
      ? and(eq(documents.malwareScanStatus, "clean"), isNull(documents.ingestedAt))!
      : eq(documents.malwareScanStatus, "pending");
  return transition(doc, condition, { ...values, ingestedAt: new Date() });
}

// ---------------------------------------------------------------------------
// Malware scan
// ---------------------------------------------------------------------------

/**
 * Scans one file with clamscan (runClamScan in ./clamav.ts, which the form
 * tools' scan of downloaded blank forms shares) and turns the outcome into
 * the document's scan status. Only a scan that ran and found nothing is
 * "clean"; a missing scanner, a refused sandbox or a failed run is "error".
 */
async function scanWithClamAv(filePath: string, workDir: string): Promise<ScanResult> {
  const scan = await runClamScan(filePath, { workDir, maxFileBytes: MAX_INGEST_BYTES, timeoutMs: SCAN_TIMEOUT_MS });
  switch (scan.kind) {
    case "clean":
      return { status: "clean" };
    case "not_installed":
      return {
        status: "error",
        message: "Not scanned: ClamAV (clamscan) is not installed on this worker, so the file could not be checked for malware.",
      };
    case "found":
      if (scan.limitsExceeded) {
        return {
          status: "error",
          message: `Not scanned completely: the file exceeds ClamAV's scanning limits (${scan.signature}), so it cannot be marked clean.`,
        };
      }
      return { status: "infected", signature: scan.signature };
    case "sandbox_refused":
      return { status: "error", message: `Not scanned: the worker ${scan.message}.` };
    case "failed": {
      // Summarized as runTool would have reported the same process error.
      const result: ToolResult = {
        missing: false,
        exitCode: scan.exitCode,
        stdout: scan.stdout ?? "",
        stderr: scan.stderr ?? scan.message,
        timedOut: scan.timedOut,
        sandboxRefused: false,
      };
      return {
        status: "error",
        message: `Not scanned: ClamAV failed (${summarizeToolError(result)}). Check that the worker's signature database is present (freshclam).`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

async function extractText(kind: FileKind, filePath: string, bytes: Buffer, workDir: string): Promise<Extraction> {
  switch (kind.kind) {
    case "pdf":
      return extractPdf(filePath, workDir);
    case "docx":
      return extractDocx(filePath, workDir);
    case "text":
      return finishText(decodeText(bytes), null, null);
    case "image":
      return {
        text: null,
        pageCount: null,
        note: "Image file: no text extraction (no OCR). Skill runs view the image directly.",
      };
    case "other":
      return {
        text: null,
        pageCount: null,
        note: "No text extraction for this file type. Convert it to PDF or Word if skill runs need to read it.",
      };
  }
}

async function extractPdf(filePath: string, workDir: string): Promise<Extraction> {
  // Page count is a nice-to-have (the skill runner's page budget); without
  // pdfinfo it falls back to counting pdftotext's page breaks below.
  let pageCount: number | null = null;
  const info = await runTool("pdfinfo", [filePath], EXTRACT_TIMEOUT_MS, workDir);
  if (info.exitCode === 0) {
    const pages = /^Pages:\s+(\d+)/m.exec(info.stdout);
    pageCount = pages ? Number(pages[1]) : null;
  }

  const outPath = path.join(workDir, "extracted.txt");
  const result = await runTool("pdftotext", ["-layout", "-enc", "UTF-8", filePath, outPath], EXTRACT_TIMEOUT_MS, workDir);
  if (result.missing) {
    return {
      text: null,
      pageCount,
      note: "No text extracted: pdftotext (poppler-utils) is not installed on this worker. Skill runs still read the PDF directly.",
    };
  }
  if (result.exitCode !== 0) {
    const passwordProtected = /password/i.test(result.stderr);
    return {
      text: null,
      pageCount,
      note: passwordProtected
        ? "No text extracted: the PDF is password-protected. Upload an unlocked copy so skill runs can read it."
        : `No text extracted: pdftotext failed (${summarizeToolError(result)}).`,
    };
  }

  let extracted: ExtractedText;
  try {
    extracted = await readExtractedText(outPath);
  } catch (err) {
    return { text: null, pageCount, note: `No text extracted: ${err instanceof Error ? err.message : String(err)}.` };
  }
  // pdftotext ends every page with a form feed; label pages so skill runs can cite them.
  const pages = extracted.text.split("\f");
  if (pages.length > 1 && pages[pages.length - 1].trim() === "") pages.pop();
  pageCount ??= pages.length;
  const hasText = pages.some((p) => p.trim() !== "");
  if (!hasText) {
    return {
      text: null,
      pageCount,
      note: "No text layer found (most likely a scanned PDF). Skill runs read the page images directly; OCR is not run.",
    };
  }
  const labeled = pages.map((p, i) => `[Page ${i + 1}]\n${p.replace(/\s+$/, "")}`).join("\n\n");
  return finishText(labeled, pageCount, null, extracted.totalBytes);
}

async function extractDocx(filePath: string, workDir: string): Promise<Extraction> {
  const outPath = path.join(workDir, "extracted.txt");
  const result = await runTool("python3", [DOCX_TO_TEXT_SCRIPT, filePath, outPath], EXTRACT_TIMEOUT_MS, workDir);
  if (result.missing) {
    return {
      text: null,
      pageCount: null,
      note: "No text extracted: python3 is not installed on this worker (Word extraction needs python3 and python-docx).",
    };
  }
  if (result.exitCode !== 0) {
    return { text: null, pageCount: null, note: `No text extracted from the Word file (${summarizeToolError(result)}).` };
  }
  try {
    const extracted = await readExtractedText(outPath);
    return finishText(extracted.text, null, null, extracted.totalBytes);
  } catch (err) {
    return { text: null, pageCount: null, note: `No text extracted: ${err instanceof Error ? err.message : String(err)}.` };
  }
}

type ExtractedText = { text: string; totalBytes: number };

/**
 * The text file an extractor wrote, read safely (readToolOutputHead refuses
 * a symlink or a file the sandboxed tool did not create) and only its first
 * MAX_EXTRACTED_TEXT_BYTES; totalBytes is the file's full size.
 */
async function readExtractedText(outPath: string): Promise<ExtractedText> {
  const { bytes, totalBytes } = await readToolOutputHead(outPath, MAX_EXTRACTED_TEXT_BYTES);
  // A character cut at the end of the slice decodes as U+FFFD.
  return { text: new TextDecoder("utf-8").decode(bytes), totalBytes };
}

/**
 * Normalizes, caps and stores extracted text; empty text becomes null with a
 * note. sourceBytes is the size of the extractor's output when only its
 * first MAX_EXTRACTED_TEXT_BYTES were read.
 */
function finishText(raw: string, pageCount: number | null, note: string | null, sourceBytes?: number): Extraction {
  // Postgres text columns reject NUL characters.
  let text = raw.replaceAll("\u0000", "").replace(/\r\n?/g, "\n").trim();
  if (!text) {
    return { text: null, pageCount, note: note ?? "The file contains no extractable text." };
  }
  if (sourceBytes !== undefined && sourceBytes > MAX_EXTRACTED_TEXT_BYTES) {
    // Only a prefix was read: the character count of the whole is unknown.
    text = text.slice(0, MAX_EXTRACTED_TEXT_CHARS);
    text += `\n\n[Text truncated: only the first ${text.length} characters of ${formatMb(sourceBytes)} of extracted text were stored.]`;
    note = `Extracted text was cut to its first part (the extractor wrote ${formatMb(sourceBytes)}).`;
    return { text, pageCount, note };
  }
  if (text.length > MAX_EXTRACTED_TEXT_CHARS) {
    const total = text.length;
    text =
      text.slice(0, MAX_EXTRACTED_TEXT_CHARS) +
      `\n\n[Text truncated: only the first ${MAX_EXTRACTED_TEXT_CHARS} of ${total} characters were stored.]`;
    note = `Extracted text was cut to the first ${MAX_EXTRACTED_TEXT_CHARS} of ${total} characters.`;
  }
  return { text, pageCount, note };
}

function decodeText(bytes: Buffer): string {
  // Decode at most ~4 bytes per stored character; finishText caps the rest.
  const slice = bytes.subarray(0, MAX_EXTRACTED_TEXT_CHARS * 4 + 4);
  if (slice[0] === 0xff && slice[1] === 0xfe) return new TextDecoder("utf-16le").decode(slice.subarray(2));
  if (slice[0] === 0xfe && slice[1] === 0xff) return new TextDecoder("utf-16be").decode(slice.subarray(2));
  // Invalid UTF-8 sequences become U+FFFD instead of failing; the BOM is dropped.
  return new TextDecoder("utf-8").decode(slice);
}

function extensionFor(kind: FileKind): string {
  switch (kind.kind) {
    case "pdf":
      return ".pdf";
    case "docx":
      return ".docx";
    case "text":
      return ".txt";
    case "image":
      return `.${kind.mediaType.split("/")[1]}`;
    case "other":
      return ".bin";
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Logs which ingest and rendering tools this worker has, and how they are
 * sandboxed, once at startup, so a missing scanner or extractor shows in the
 * worker log before the first upload does. clamscan --version also prints
 * the signature database's date, and soffice --version the LibreOffice
 * build (check it includes current security fixes).
 */
export async function logIngestToolAvailability(): Promise<void> {
  console.log(`[ingest] untrusted-tool sandbox: ${await describeUntrustedToolSandbox()}`);
  const checks: [string, string, string[]][] = [
    ["malware scan", "clamscan", ["--version"]],
    ["PDF text", "pdftotext", ["-v"]],
    ["Word text", "python3", ["-c", "import docx; print('python-docx available')"]],
    ["Word rendering", "soffice", ["--headless", "--version"]],
  ];
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolcheck-"));
  try {
    for (const [purpose, command, args] of checks) {
      const result = await runTool(command, args, 60_000, workDir);
      if (result.missing) {
        console.warn(`[ingest] ${purpose}: ${command} NOT FOUND on PATH`);
        continue;
      }
      const firstLine = (result.stdout.trim() || result.stderr.trim()).split("\n")[0] ?? "";
      // pdftotext -v exits non-zero on some poppler versions; only a missing binary matters here.
      console.log(`[ingest] ${purpose}: ${command} ${result.exitCode === 0 ? "ok" : `exit ${result.exitCode}`} (${firstLine})`);
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Running external tools
// ---------------------------------------------------------------------------

type ToolResult = {
  /** The binary is not on PATH. */
  missing: boolean;
  /** Process exit code; null when it could not start or was killed (timeout). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Not run at all: the sandbox it requires is not available on this worker (stderr says why). */
  sandboxRefused: boolean;
};

/** Runs one tool on untrusted bytes in workDir (sandboxed, see execUntrusted). Never throws. */
async function runTool(command: string, args: string[], timeoutMs: number, workDir: string): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execUntrusted(command, args, { workDir, timeoutMs });
    return { missing: false, exitCode: 0, stdout, stderr, timedOut: false, sandboxRefused: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string; killed?: boolean };
    return {
      missing: e.code === "ENOENT",
      exitCode: typeof e.code === "number" ? e.code : null,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? (e.code === "ENOENT" ? "" : e.message),
      timedOut: Boolean(e.killed),
      sandboxRefused: err instanceof UntrustedToolSandboxError,
    };
  }
}

function summarizeToolError(result: ToolResult): string {
  if (result.timedOut) return "timed out";
  const detail = (result.stderr || result.stdout).trim().split("\n").filter(Boolean).slice(-2).join(" ");
  const code = result.exitCode === null ? "" : `exit ${result.exitCode}`;
  return [code, detail.slice(0, 300)].filter(Boolean).join(": ") || "unknown error";
}
