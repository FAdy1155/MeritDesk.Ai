import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { withTenantContext } from "@/db/client";
import { documents } from "@/db/schema";
import { getMatterDocument } from "@/lib/documents/service";
import { looksLikePdf } from "@/lib/documents/file-kind";
import { runClamScan } from "@/services/ingest/clamav";
import { cleanupWorkDir } from "@/services/docx-generator/generate";
// Types only: tools.ts imports the modules that import this one.
import type { ToolExecutionContext } from "../../tools";
import type { VerificationLogEntry } from "../../verification-log";

// What the three form tools share (tools/i90-packet-build.ts for the I-90
// and G-28, tools/packet-build.ts for the I-589, tools/vawa-packet-build.ts
// for the I-360, I-485 and I-765): finding the blank form a matter document
// names, downloading the current blank form from its uscis.gov page, the
// malware scan of that download, and the file housekeeping around a fill.
//
// The download: fetch_uscis_page returns a page's text without its links, so
// the model cannot see a form PDF's address. downloadBlankForm fetches the
// form's page (or another uscis.gov page the model names), takes the link to
// the form's own PDF from its HTML and downloads that, https only and with
// every redirect checked against uscis.gov, as fetch_uscis_page does; each
// request goes to the run's verification log with the hash of what came
// back. A downloaded PDF is a file from the internet, and
// createGeneratedDocument stores a filled copy as "clean" (the ingest job
// does not scan it again), so it is scanned with ClamAV, as an upload is,
// before any parser reads it: only a scan that ran and found nothing lets it
// be used (fail closed). Each tool words its own messages from the failure
// this returns, since each tells the model a different way forward.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Combining diacritical marks (U+0300 to U+036F), left after NFKD splits an
// accented letter; built from char codes so this source file stays ASCII.
export const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");

const FORM_FETCH_TIMEOUT_MS = 30_000;
const MAX_FORM_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Blank USCIS forms are published on uscis.gov only.
const FORM_PDF_HOSTS = new Set(["www.uscis.gov", "uscis.gov"]);
const HREF = /\bhref\s*=\s*["']([^"']+)["']/gi;
// How many of a page's other PDF links a failure lists for the model.
const MAX_LISTED_PDF_LINKS = 15;
// clamscan loads the whole signature database on every run (tens of seconds
// on a small VM), as in the document-ingest job, so its timeout is generous.
const SCAN_TIMEOUT_MS = 8 * 60_000;
const SCANNED_FORM_FILE = "download.pdf";

export function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------- matter documents

export type MatterDocument = {
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
 * (the run's document labels show file names; the inventory also lists each
 * document_id), read through the tenant context with the tenant and matter
 * filters. Of several documents with that name, the one that scanned clean;
 * one that has not scanned clean is returned for the caller to refuse with
 * its status. Returns an error the model can act on instead of throwing.
 */
export async function findMatterDocument(reference: string, ctx: ToolExecutionContext): Promise<MatterDocument | string> {
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
      .where(and(eq(documents.tenantId, ctx.tenantId), eq(documents.matterId, ctx.matterId), eq(documents.fileName, ref)))
      .orderBy(desc(documents.createdAt))
  );
  if (rows.length === 0) {
    return `No document named "${ref}" is on this matter. Give the file name exactly as the document's label shows it, or the document's id.`;
  }
  const clean = rows.filter((r) => r.malwareScanStatus === "clean");
  if (clean.length === 1) return clean[0];
  if (clean.length === 0) return rows[0]; // refused by the caller, with its scan status
  return (
    `Several documents on this matter are named "${ref}": ` +
    clean.map((r) => `id ${r.id} (version ${r.version}, uploaded ${r.createdAt.toISOString().slice(0, 10)})`).join("; ") +
    ". Call again with the id of the one to use."
  );
}

// ---------------------------------------------------------------- the download

/** A blank form downloaded from uscis.gov and scanned clean. */
export type DownloadedBlankForm = { bytes: Buffer; source: string; sha256: string };

/** Why a download is not used; each tool words the message itself. */
export type BlankFormDownloadFailure =
  /** A request failed or was blocked; message says how (it names the URL). */
  | { kind: "fetch_failed"; message: string }
  /**
   * The page is HTML, but it links no file named after the form, or more
   * than one (formPdfCount). listed: those files when there are several,
   * otherwise the page's other PDF links, at most MAX_LISTED_PDF_LINKS.
   */
  | { kind: "no_single_form_link"; page: URL; formPdfCount: number; listed: string[] }
  /** The form's PDF link on page did not return a PDF. */
  | { kind: "linked_file_not_pdf"; page: URL; pdf: URL }
  /** Downloaded, but the malware scan did not pass it (problem says why). */
  | { kind: "scan_failed"; blank: DownloadedBlankForm; problem: string };

export type BlankFormDownload = { ok: true; blank: DownloadedBlankForm } | { ok: false; failure: BlankFormDownloadFailure };

/** Why a URL may not be fetched as a blank form or its page, or null when it may. */
export function formUrlProblem(url: URL): string | null {
  if (url.protocol !== "https:") return `only https:// URLs are reachable (got ${url.protocol}//${url.hostname})`;
  if (url.username || url.password) return "URLs with credentials are not fetched";
  if (url.port && url.port !== "443") return `only the standard https port is reachable (got port ${url.port})`;
  if (!FORM_PDF_HOSTS.has(url.hostname)) return `blank forms are fetched from uscis.gov only (got ${url.hostname})`;
  return null;
}

/** A response body, or null when it is larger than maxBytes (reading stops there). */
async function readBodyUpTo(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * One GET on uscis.gov, following redirects only within uscis.gov. Every
 * request that reached the site is written to the run's verification log (as
 * fetch_uscis_page entries: the same allow-listed, app-recorded retrieval),
 * with the hash of what came back, so the attorney can see which page and
 * which file the form was filled from.
 */
async function fetchFromUscis(
  rawUrl: string,
  form: string,
  maxBytes: number,
  ctx: ToolExecutionContext
): Promise<{ bytes: Buffer; url: URL } | string> {
  let current: URL;
  try {
    current = new URL(rawUrl.trim());
  } catch {
    return `Invalid URL: ${rawUrl}`;
  }
  const firstProblem = formUrlProblem(current);
  if (firstProblem) return `Fetch blocked: ${firstProblem}.`;

  const requestedUrl = current.toString();
  const redirects: string[] = [];
  const log = (status: number | string, extra: Partial<VerificationLogEntry> = {}) => {
    ctx.verificationLog.push({
      source: "fetch_uscis_page",
      url: current.toString(),
      ...(current.toString() !== requestedUrl ? { requestedUrl } : {}),
      ...(redirects.length ? { redirects: [...redirects] } : {}),
      fetchedAt: new Date().toISOString(),
      status,
      ...extra,
    });
  };
  const signal = AbortSignal.timeout(FORM_FETCH_TIMEOUT_MS);

  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(current.toString(), { signal, redirect: "manual" });
      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location) {
          log(res.status);
          return `Fetch failed: HTTP ${res.status} redirect with no Location.`;
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          log("redirect_blocked");
          return "Fetch blocked: the page redirected to an invalid URL.";
        }
        const problem = formUrlProblem(next);
        if (problem) {
          log("redirect_blocked");
          return `Fetch blocked: ${current.toString()} redirected to ${next.toString()}, and ${problem}.`;
        }
        if (hop >= MAX_FORM_REDIRECTS) {
          log("too_many_redirects");
          return `Fetch failed: more than ${MAX_FORM_REDIRECTS} redirects.`;
        }
        redirects.push(current.toString());
        current = next;
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        log(res.status);
        return `Fetch failed: HTTP ${res.status} from ${current.toString()}.`;
      }
      const bytes = await readBodyUpTo(res, maxBytes);
      if (!bytes) {
        log("too_large");
        return `Fetch failed: ${current.toString()} is larger than ${maxBytes / (1024 * 1024)} MB, which no blank form or form page is.`;
      }
      log(res.status, {
        contentHash: sha256(bytes).slice(0, 16),
        title: looksLikePdf(bytes) ? `Blank Form ${form} (PDF)` : `Form ${form} page (searched for its PDF link)`,
      });
      return { bytes, url: current };
    }
  } catch (err) {
    log(0);
    return `Fetch failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * The links in a uscis.gov page's HTML to PDFs on uscis.gov, split into the
 * form's own fillable PDF (the file named after the form, "i-90.pdf", not its
 * instructions, "i-90instr.pdf") and the rest.
 */
function pdfLinksIn(html: string, page: URL, form: string): { formPdfs: URL[]; otherPdfs: URL[] } {
  const fileName = `/${form.toLowerCase()}.pdf`;
  const links = new Map<string, URL>();
  for (const match of html.matchAll(HREF)) {
    let link: URL;
    try {
      link = new URL(match[1].replace(/&amp;/g, "&").trim(), page);
    } catch {
      continue;
    }
    link.hash = "";
    if (formUrlProblem(link) || !link.pathname.toLowerCase().endsWith(".pdf")) continue;
    links.set(link.toString(), link);
  }
  const all = [...links.values()];
  const named = all.filter((link) => link.pathname.toLowerCase().endsWith(fileName));
  // Where a page links more than one file of that name, the forms library's
  // copy is the form.
  const inFormsLibrary = named.filter((link) => link.pathname.toLowerCase().includes("/document/forms/"));
  const formPdfs = inFormsLibrary.length > 0 ? inFormsLibrary : named;
  return { formPdfs, otherPdfs: all.filter((link) => !formPdfs.includes(link)) };
}

/**
 * Scans a downloaded blank form with ClamAV, sandboxed (runClamScan in
 * src/services/ingest/clamav.ts, the document-ingest job's scan). Fails
 * closed: null only when clamscan ran and found nothing; otherwise why the
 * file is not used (infected, too large to scan fully, scanner missing or
 * failed, sandbox unavailable).
 */
async function scanDownloadedForm(bytes: Buffer, maxBytes: number): Promise<string | null> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "formscan-"));
  try {
    const filePath = path.join(workDir, SCANNED_FORM_FILE);
    await fs.writeFile(filePath, bytes);
    const scan = await runClamScan(filePath, { workDir, maxFileBytes: maxBytes, timeoutMs: SCAN_TIMEOUT_MS });
    switch (scan.kind) {
      case "clean":
        return null;
      case "sandbox_refused":
        return `the worker ${scan.message}`;
      case "not_installed":
        return "ClamAV (clamscan) is not installed on this worker";
      case "found":
        return scan.limitsExceeded
          ? `the file exceeds ClamAV's scanning limits (${scan.signature}), so it cannot be marked clean`
          : `ClamAV detected ${scan.signature}`;
      case "failed": {
        if (scan.timedOut) return "the malware scan timed out";
        const detail = (scan.stderr || scan.stdout || scan.message).trim().split("\n").filter(Boolean).slice(-2).join(" ");
        return `ClamAV failed (${scan.exitCode !== null ? `exit ${scan.exitCode}: ` : ""}${detail.slice(0, 300)})`;
      }
    }
  } finally {
    await cleanupWorkDir(workDir);
  }
}

// The blank forms this run downloaded and scanned, by form and requested URL,
// so listing (or inspecting) and filling read the same file and uscis.gov is
// asked once per form; or the scan that refused a download, so it is not
// fetched and scanned again. Keyed by the run's tool context, which lives as
// long as the run. A request that failed before the scan is not kept, so a
// later call tries again.
const scannedDownloads = new WeakMap<ToolExecutionContext, Map<string, BlankFormDownload>>();

/**
 * The form's blank fillable PDF from uscis.gov, scanned clean. rawUrl is the
 * form's page or another uscis.gov page that links it, whose HTML gives the
 * PDF's address, or the PDF itself. maxBytes caps each response (a form page
 * or a blank form is never near it) and sets the scan's size limits; logTag
 * prefixes the worker log line written when the scan refuses a download.
 */
export async function downloadBlankForm(
  params: { rawUrl: string; form: string; maxBytes: number; logTag: string },
  ctx: ToolExecutionContext
): Promise<BlankFormDownload> {
  const { rawUrl, form, maxBytes } = params;
  const cacheKey = `${form} ${rawUrl}`;
  const cached = scannedDownloads.get(ctx)?.get(cacheKey);
  if (cached !== undefined) return cached;

  const first = await fetchFromUscis(rawUrl, form, maxBytes, ctx);
  if (typeof first === "string") return { ok: false, failure: { kind: "fetch_failed", message: first } };
  let blank: DownloadedBlankForm;
  if (looksLikePdf(first.bytes)) {
    blank = { bytes: first.bytes, source: first.url.toString(), sha256: sha256(first.bytes) };
  } else {
    // A web page: the PDF is the one it links under the form's own file name.
    const { formPdfs, otherPdfs } = pdfLinksIn(first.bytes.toString("utf-8"), first.url, form);
    if (formPdfs.length !== 1) {
      const listed = (formPdfs.length > 1 ? formPdfs : otherPdfs).slice(0, MAX_LISTED_PDF_LINKS).map(String);
      return { ok: false, failure: { kind: "no_single_form_link", page: first.url, formPdfCount: formPdfs.length, listed } };
    }
    const pdf = await fetchFromUscis(formPdfs[0].toString(), form, maxBytes, ctx);
    if (typeof pdf === "string") return { ok: false, failure: { kind: "fetch_failed", message: pdf } };
    if (!looksLikePdf(pdf.bytes)) {
      return { ok: false, failure: { kind: "linked_file_not_pdf", page: first.url, pdf: pdf.url } };
    }
    blank = {
      bytes: pdf.bytes,
      source: `${pdf.url.toString()} (linked from ${first.url.toString()})`,
      sha256: sha256(pdf.bytes),
    };
  }

  // Before any parser reads it, and before a filled copy (stored "clean")
  // can reach the matter.
  const problem = await scanDownloadedForm(blank.bytes, maxBytes);
  const outcome: BlankFormDownload = problem
    ? { ok: false, failure: { kind: "scan_failed", blank, problem } }
    : { ok: true, blank };
  if (problem) console.warn(`[${params.logTag}] blank Form ${form} from ${blank.source} refused: ${problem}`);

  const downloads = scannedDownloads.get(ctx) ?? new Map<string, BlankFormDownload>();
  downloads.set(cacheKey, outcome);
  scannedDownloads.set(ctx, downloads);
  return outcome;
}

// ---------------------------------------------------------------- around a fill

/** A python3 / pypdf / pdftoppm failure as the model is told it. */
export function describeFormToolError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
    return "required binary not found on PATH (python3 with pypdf, and pdftoppm, must be installed on the worker image)";
  }
  if (err instanceof Error) {
    const withOutput = err as Error & { stderr?: string; stdout?: string };
    const output = withOutput.stderr?.trim() || withOutput.stdout?.trim() || err.message;
    // Windows ships a "python3" that only opens the Microsoft Store.
    if (/Python was not found/i.test(output)) {
      return "python3 is not installed on this machine (only the Windows Store alias is); forms are filled on the worker image";
    }
    // The script's own error ends its output; keep the end.
    return output.length > 2000 ? `...${output.slice(-2000)}` : output;
  }
  return String(err);
}

/**
 * A model-proposed file name made safe for the documents list and the S3
 * key it becomes part of: printable ASCII letters, digits, spaces and
 * . _ - ( ) only, no leading dots, always ending in .pdf; fallbackBase when
 * nothing usable is left.
 */
export function safePdfFileName(raw: string | undefined, fallbackBase: string): string {
  const base = (raw ?? "")
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9 ._()-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 100)
    .trim();
  return `${base || fallbackBase}.pdf`;
}

/** Removes everything in workDir except the page images render_and_qa_docx reads later. */
export async function removeAllButPageImages(workDir: string): Promise<void> {
  for (const entry of await fs.readdir(workDir)) {
    if (!/^page.*\.jpg$/.test(entry)) await fs.rm(path.join(workDir, entry), { recursive: true, force: true });
  }
}
