import { DEFAULT_MAX_BYTES } from "./http/client";
import { decodeBody, type FetchExpect, type PoliteFetchResult } from "./http/fetch";
import { describeError, type PipelineDeps } from "./pipeline";
import { prepareDocument, type PreparedDocument } from "./prepare";
import { getLibraryAdapter, isManualSource, isSourceDisabled, missingEnv } from "./registry";
import {
  emptyCounts,
  finishRun,
  insertImportLog,
  startRun,
  syncSources,
  updateSourceAfterImport,
  upsertDocument,
  type ImportLogEntry,
  type UpsertOutcome,
} from "./store";
import { sha256Hex } from "./text";
import type {
  LibraryAdapterContext,
  LibraryDocumentInput,
  LibraryGetOptions,
  LibraryHttp,
  LibrarySourceAdapter,
  ManualImportFile,
  ManualImportInput,
  ManualImportPath,
} from "./types";

// Import from the official site: the library sources whose sites refuse
// automated tools (docs/LIBRARY_SOURCES.md section 1) are kept up to date by
// a platform operator who opens the page in a browser, saves it, and gives
// the app the file with the page's official address (/library/import).
//
// The file goes through the same steps as a fetched one, so what is stored
// is what the automatic collector would have stored from that address:
//
// 1. The address must be https, on the adapter's hosts, with a path one of
//    its manualImportPaths names; the file must be what the collector reads
//    there (HTML or PDF), recognized by its first bytes, within the size cap.
//    A saved page that names another address as its own (a browser's "saved
//    from" mark, its canonical link) or is an Internet Archive copy is refused.
// 2. The adapter's parseImported builds the ref fetchDocument would get and
//    calls fetchDocument, with a ctx.http that serves only the given files at
//    their addresses, under the automatic fetch's byte caps (PDF text comes
//    from the same pdf.js worker thread, with its time, memory and page caps).
// 3. prepare.ts checks and normalizes the result, metadata.importedManually
//    records who imported which file when, and the store's versioned upsert
//    writes it. The import is a library_fetch_runs row of kind manual_import,
//    and every attempt, refused ones included, a library_import_log row.
//
// Nothing here fetches anything: the app never goes around a site's bot
// protection, it reads only what a person saved with their own browser.

/**
 * The largest file an import takes. The form posts it to a Server Action,
 * whose body limit (next.config.ts, serverActions.bodySizeLimit) is 10 MB,
 * under the 10 MB proxy (src/proxy.ts) buffers a request body to; the
 * automatic caps (15 MB of HTML, LIBRARY_MAX_PDF_MB of PDF) still apply when
 * the file is parsed.
 */
export const IMPORT_MAX_BYTES = 9 * 1024 * 1024;

/** How long one import may parse: the PDF extractor's own timeout is inside this. */
const IMPORT_TIME_BUDGET_MS = 10 * 60 * 1000;

/** An import refused for what was given (address, file); the message is safe to show to the person. */
export class ManualImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualImportError";
  }
}

type FileKind = ManualImportPath["file"];
const CONTENT_TYPE: Record<FileKind, ManualImportFile["contentType"]> = { html: "text/html", pdf: "application/pdf" };

// ---------------------------------------------------------------------------
// The address

/** Host, path without a trailing slash, and query: how two addresses of one page are compared. */
function addressKey(url: URL, lowerPath = false): string {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.hostname.toLowerCase()}${lowerPath ? path.toLowerCase() : path}${url.search}`;
}

/**
 * The address as the import will use it (https, no fragment) and the kind of
 * page or file it is for this adapter, or ManualImportError saying why not.
 */
export function checkImportAddress(adapter: LibrarySourceAdapter, raw: string, role: ManualImportPath["role"]): { url: string; path: ManualImportPath } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ManualImportError("The official address is not a web address. Copy it from the browser's address bar.");
  }
  if (url.protocol !== "https:") throw new ManualImportError("The official address must start with https://.");
  if (url.username || url.password || url.port) throw new ManualImportError("The official address must not carry a user name, password or port.");
  const host = url.hostname.toLowerCase();
  if (!adapter.hosts.includes(host)) {
    throw new ManualImportError(`${host} is not one of this source's official sites (${adapter.hosts.join(", ")}).`);
  }
  url.hash = "";
  const paths = (adapter.manualImportPaths ?? []).filter((p) => p.role === role && (p.hosts ?? adapter.hosts).includes(host));
  const path = paths.find((p) => p.path.test(url.pathname));
  if (!path) {
    const kinds = (adapter.manualImportPaths ?? []).filter((p) => p.role === role).map((p) => p.label.replace(/\.$/, ""));
    throw new ManualImportError(
      role === "document"
        ? `That address is not one of this source's documents. It takes: ${kinds.join("; ")}.`
        : kinds.length
          ? `The linked address is not a page or file this source's collector reads with a document. It takes: ${kinds.join("; ")}.`
          : "This source takes no linked page or file."
    );
  }
  return { url: url.toString(), path };
}

// ---------------------------------------------------------------------------
// The file

function startsWith(bytes: Buffer, text: string, at = 0): boolean {
  return bytes.subarray(at, at + text.length).toString("latin1") === text;
}

/**
 * What a file is by its own bytes, never by its name or the type the browser
 * claims: a PDF ("%PDF-" header and a "%%EOF" trailer, so a truncated
 * download is refused) or an HTML page (text, no NUL bytes, opening with
 * markup and closing with </html>). Anything else is refused with a reason.
 */
export function sniffFile(bytes: Buffer, maxBytes = IMPORT_MAX_BYTES): FileKind {
  if (bytes.length === 0) throw new ManualImportError("The file is empty.");
  if (bytes.length > maxBytes) {
    throw new ManualImportError(`The file is ${(bytes.length / 1048576).toFixed(1)} MB; an import takes at most ${maxBytes / 1048576} MB.`);
  }
  if (bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
    if (!bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1").includes("%%EOF")) {
      throw new ManualImportError("The PDF has no end-of-file marker: the download was cut short. Download it again.");
    }
    return "pdf";
  }
  if (startsWith(bytes, "\xff\xfe") || startsWith(bytes, "\xfe\xff")) {
    throw new ManualImportError("The page was saved as UTF-16 text. Save it again with the browser's \"Save page as\", \"Webpage, HTML only\".");
  }
  const head = bytes.subarray(startsWith(bytes, "\xef\xbb\xbf") ? 3 : 0, 64 * 1024).toString("latin1");
  if (/^\s*(?:From:|MIME-Version:)/i.test(head)) {
    throw new ManualImportError("This is a web archive (.mhtml, \"Webpage, Single File\"). Save the page as \"Webpage, HTML only\" (or \"Webpage, Complete\") instead.");
  }
  if (head.includes("\u0000")) throw new ManualImportError("The file is neither an HTML page nor a PDF.");
  if (!/^\s*</.test(head) || !/<(?:!doctype\s+html|html|head|body)\b/i.test(bytes.subarray(0, 512 * 1024).toString("latin1"))) {
    throw new ManualImportError("The file is neither an HTML page nor a PDF.");
  }
  if (!/<\/html\s*>/i.test(bytes.subarray(Math.max(0, bytes.length - 64 * 1024)).toString("latin1"))) {
    throw new ManualImportError("The page does not end with </html>: the saved file is incomplete. Save the page again once it has finished loading.");
  }
  return "html";
}

/** The charset a page declares in its <meta>, lowercased; null when it declares none. */
function declaredCharset(bytes: Buffer): string | null {
  return /<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString("latin1"))?.[1]?.toLowerCase() ?? null;
}

/** A saved page's text, decoded by the charset it declares (UTF-8 otherwise). */
export function decodeSavedPage(bytes: Buffer): string {
  const charset = declaredCharset(bytes);
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // an unknown charset: read as UTF-8
    }
  }
  return bytes.toString("utf-8").replace(/^﻿/, "");
}

const ARCHIVE_MARKS = /<!--\s*BEGIN WAYBACK TOOLBAR INSERT|\/\/web\.archive\.org\/web\/\d{4,}|__wm\.init\(|archive\.org\/static\/js\/wombat|<!--\s*FILE ARCHIVED ON /i;

/**
 * Refuses a saved page that is not the page at `url` from the official
 * site: an Internet Archive copy, a page whose browser "saved from" mark
 * names another address, or one whose canonical link names another page.
 */
export function checkSavedPage(html: string, url: string): void {
  if (ARCHIVE_MARKS.test(html)) {
    throw new ManualImportError("This is an Internet Archive copy, not the page from the official site. Open the official page itself and save it.");
  }
  const target = addressKey(new URL(url), true);
  const savedFrom = /<!--\s*saved from url=\(\d+\)(\S+?)\s*-->/i.exec(html.slice(0, 4096))?.[1];
  if (savedFrom) {
    let from: URL | null = null;
    try {
      from = new URL(savedFrom);
    } catch {
      from = null;
    }
    if (from && /^https?:$/.test(from.protocol) && addressKey(from, true) !== target) {
      throw new ManualImportError(`The browser recorded that this file was saved from ${from.toString()}, not from the address given.`);
    }
  }
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1];
    if (!/\brel\s*=\s*["']?canonical["'\s>]/i.test(`${attrs} `)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    let canonical: URL | null = null;
    try {
      canonical = href ? new URL(href.replace(/&amp;/g, "&"), url) : null;
    } catch {
      canonical = null;
    }
    if (canonical && addressKey(canonical, true) !== target) {
      throw new ManualImportError(`The page gives its own address as ${canonical.toString()}. Use that address (the one the browser shows once the page has loaded).`);
    }
    break;
  }
}

// ---------------------------------------------------------------------------
// The adapter's context

/**
 * The context parseImported runs in: ctx.http answers only for the files
 * given, at their addresses (compared without a trailing slash), as a 200
 * with no validators, under the byte cap the automatic fetch applies to the
 * same request. Any other address fails with a message that tells the
 * person which page or file the collector also needs.
 */
export function createImportContext(params: {
  adapter: LibrarySourceAdapter;
  files: ManualImportFile[];
  now: Date;
  signal: AbortSignal;
  note: (message: string) => void;
}): LibraryAdapterContext {
  const byKey = new Map(params.files.map((f) => [addressKey(new URL(f.url)), f]));
  const get = async (raw: string, options: LibraryGetOptions): Promise<PoliteFetchResult> => {
    params.signal.throwIfAborted();
    const url = new URL(raw);
    url.hash = "";
    const file = byKey.get(addressKey(url));
    if (!file) {
      throw new ManualImportError(
        `The collector also reads ${url.toString()} for this document. Save that page or file from the official site too and give it as the linked file, with that address.`
      );
    }
    const kind: FileKind = file.contentType === "application/pdf" ? "pdf" : "html";
    const expect: FetchExpect = options.expect;
    if (expect !== "any" && expect !== kind) {
      throw new ManualImportError(
        expect === "html" || expect === "pdf"
          ? `The collector reads ${url.toString()} as ${expect === "html" ? "an HTML page" : "a PDF"}, and the file given for it is ${kind === "html" ? "an HTML page" : "a PDF"}.`
          : `The collector reads ${url.toString()} as ${expect.toUpperCase()}, which cannot be imported by hand.`
      );
    }
    const cap = options.maxBytes ?? DEFAULT_MAX_BYTES[expect];
    if (file.bytes.length > cap) throw new ManualImportError(`${url.toString()} is larger than the ${Math.round(cap / 1048576)} MB the collector reads of it.`);
    return {
      url: url.toString(),
      requestedUrl: url.toString(),
      redirects: [],
      status: 200,
      notModified: false,
      contentType: file.contentType,
      charset: kind === "html" ? declaredCharset(file.bytes) : null,
      body: file.bytes,
      sha256: sha256Hex(file.bytes),
      etag: null,
      lastModified: null,
      retrievedAt: params.now,
    };
  };
  const http: LibraryHttp = {
    get,
    async getText(url, options) {
      const response = await get(url, { expect: "html", ...options });
      return { text: decodeBody(response), response };
    },
    async getJson(url) {
      throw new ManualImportError(`The collector reads ${url} as JSON, which cannot be imported by hand.`);
    },
    async getListing(url, options) {
      const response = await get(url, { expect: "html", ...options });
      return { unchanged: false, text: decodeBody(response), response };
    },
  };
  const allowedEnv = new Set([...(params.adapter.requiredEnv ?? []), ...(params.adapter.optionalEnv ?? [])]);
  return {
    sourceCode: params.adapter.code,
    mode: "import",
    http,
    now: params.now,
    signal: params.signal,
    note: params.note,
    env: (name) => (allowedEnv.has(name) ? process.env[name] : undefined),
  };
}

/** What one import records about itself in metadata.importedManually. */
export type ImportProvenance = { by: string; at: string; fileSha256: string; linkedUrl?: string; linkedFileSha256?: string };

/**
 * Runs the adapter's parser on the files and checks the result as the
 * pipeline does (prepare.ts), with metadata.importedManually added. Throws
 * ManualImportError when the file is not one of the source's documents, and
 * the parser's own errors (a layout it does not recognize) as they are.
 */
export async function parseImportedFiles(
  adapter: LibrarySourceAdapter,
  input: ManualImportInput,
  params: { importedBy: string; at: Date; signal?: AbortSignal; note?: (message: string) => void }
): Promise<{ document: LibraryDocumentInput; prepared: PreparedDocument }> {
  if (!adapter.parseImported) throw new ManualImportError(`${adapter.name} cannot be imported by hand.`);
  const signal = params.signal ? AbortSignal.any([params.signal, AbortSignal.timeout(IMPORT_TIME_BUDGET_MS)]) : AbortSignal.timeout(IMPORT_TIME_BUDGET_MS);
  const ctx = createImportContext({
    adapter,
    files: input.linked ? [input, input.linked] : [input],
    now: params.at,
    signal,
    note: params.note ?? (() => {}),
  });
  const result = await adapter.parseImported(ctx, input);
  if (result.kind === "skip") throw new ManualImportError(result.reason);
  if (result.kind !== "document") throw new ManualImportError("The collector did not read a document from the file.");
  const provenance: ImportProvenance = {
    by: params.importedBy,
    at: params.at.toISOString(),
    fileSha256: sha256Hex(input.bytes),
    ...(input.linked ? { linkedUrl: input.linked.url, linkedFileSha256: sha256Hex(input.linked.bytes) } : {}),
  };
  const document: LibraryDocumentInput = { ...result.document, metadata: { ...result.document.metadata, importedManually: provenance } };
  return { document, prepared: prepareDocument(adapter, document, null) };
}

// ---------------------------------------------------------------------------
// One import, stored

export type ManualImportRequest = {
  code: string;
  url: string;
  bytes: Buffer;
  linkedUrl?: string | null;
  linkedBytes?: Buffer | null;
  /** The platform operator's Clerk user id (checked against LIBRARY_IMPORT_ADMINS by the caller). */
  importedBy: string;
  /** The firm the operator was signed in to, recorded for context only. */
  tenantId?: string | null;
};

export type ManualImportResult =
  | {
      ok: true;
      outcome: UpsertOutcome["outcome"];
      documentId: string;
      version: number;
      externalId: string;
      title: string;
      runId: string;
      notes: string[];
    }
  | { ok: false; outcome: "rejected" | "failed"; error: string; runId: string | null };

/** The address and file, checked; ManualImportError when either is refused. */
function checkFile(adapter: LibrarySourceAdapter, rawUrl: string, bytes: Buffer, role: ManualImportPath["role"]): ManualImportFile {
  const { url, path } = checkImportAddress(adapter, rawUrl, role);
  const kind = sniffFile(bytes);
  if (kind !== path.file) {
    throw new ManualImportError(
      path.file === "html"
        ? `The collector reads this page's HTML, so a PDF of it (a printout or "Save as PDF") would not give the same document. Save the page with the browser's "Save page as", "Webpage, HTML only".`
        : "The collector reads this address as a PDF file. Download the PDF itself from the official site."
    );
  }
  if (kind === "html") checkSavedPage(decodeSavedPage(bytes), url);
  return { url, contentType: CONTENT_TYPE[kind], bytes };
}

/**
 * Imports one file (and its linked page or file) into the library: checks,
 * parses with the adapter's own parser, stores with the versioned upsert,
 * and records the run, the source's standing and the audit log row. Never
 * throws for what was given or for a parsing failure: the result says what
 * happened, and the log has the attempt. The caller has already checked
 * that the person may import (./import-service.ts).
 */
export async function runManualImport(req: ManualImportRequest, deps: PipelineDeps & { adapter?: LibrarySourceAdapter }): Promise<ManualImportResult> {
  const adapter = deps.adapter ?? getLibraryAdapter(req.code);
  if (!adapter?.parseImported) return { ok: false, outcome: "rejected", error: "That source cannot be imported by hand.", runId: null };
  const at = new Date();
  const manual = isManualSource(adapter.code);
  const logBase: Omit<ImportLogEntry, "outcome"> = {
    sourceCode: adapter.code,
    actorUserId: req.importedBy,
    actorTenantId: req.tenantId ?? null,
    officialUrl: req.url.slice(0, 2000),
    linkedUrl: req.linkedUrl?.slice(0, 2000) || null,
    fileSha256: sha256Hex(req.bytes),
    fileBytes: req.bytes.length,
    linkedFileSha256: req.linkedBytes?.length ? sha256Hex(req.linkedBytes) : null,
  };
  // The source's row may not exist yet on a deployment whose worker has not started since this source was added.
  await deps.tx.write((tx) =>
    syncSources(tx, [{ adapter, missingEnv: missingEnv(adapter), disabled: isSourceDisabled(adapter.code), manual }])
  );

  let input: ManualImportInput;
  try {
    const file = checkFile(adapter, req.url, req.bytes, "document");
    let linked: ManualImportFile | null = null;
    if (req.linkedUrl?.trim() || req.linkedBytes?.length) {
      if (!req.linkedUrl?.trim() || !req.linkedBytes?.length) throw new ManualImportError("A linked file needs both its official address and the saved file.");
      linked = checkFile(adapter, req.linkedUrl, req.linkedBytes, "linked");
    }
    input = { ...file, linked };
  } catch (err) {
    const error = err instanceof ManualImportError ? err.message : describeError(err);
    await deps.tx.write((tx) => insertImportLog(tx, { ...logBase, outcome: "rejected", errorMessage: error }));
    deps.log?.(`[library] ${adapter.code} manual import refused: ${error}`);
    return { ok: false, outcome: "rejected", error, runId: null };
  }

  const notes: string[] = [];
  const note = (message: string) => {
    const text = message.replace(/\s+/g, " ").trim().slice(0, 500);
    if (text && !notes.includes(text) && notes.length < 50) notes.push(text);
  };
  const run = await deps.tx.write((tx) => startRun(tx, { code: adapter.code, kind: "manual_import", pgBossJobId: null }));
  const counts = { ...emptyCounts(), listed: 1, fetched: 1 };
  note(`Imported by hand from the official site: ${input.url}${input.linked ? `, with ${input.linked.url}` : ""} (file sha256 ${logBase.fileSha256}).`);

  const fail = async (error: string, outcome: "rejected" | "failed"): Promise<ManualImportResult> => {
    counts.failed = 1;
    await deps.tx.write(async (tx) => {
      await finishRun(tx, run.id, { status: "failed", counts, notes, failures: [{ externalId: "", url: input.url, error }], errorMessage: error });
      await insertImportLog(tx, { ...logBase, fileContentType: input.contentType, outcome, errorMessage: error, runId: run.id });
    });
    deps.log?.(`[library] ${adapter.code} manual import ${outcome}: ${error}`);
    return { ok: false, outcome, error, runId: run.id };
  };

  let parsed: Awaited<ReturnType<typeof parseImportedFiles>>;
  try {
    parsed = await parseImportedFiles(adapter, input, { importedBy: req.importedBy, at, note });
  } catch (err) {
    // A file that is not one of the source's documents is the person's to fix; anything else is a parsing failure.
    return err instanceof ManualImportError ? fail(err.message, "rejected") : fail(describeError(err), "failed");
  }
  const { prepared } = parsed;

  let originalKey: string | null = null;
  if (deps.storeOriginal && prepared.original) {
    try {
      originalKey = await deps.storeOriginal({ code: adapter.code, externalId: prepared.externalId, ...prepared.original });
    } catch (err) {
      note(`The original file of ${prepared.externalId} could not be stored (${describeError(err)}); its text was stored.`);
    }
  }

  try {
    const stored = await deps.tx.write(async (tx) => {
      const outcome = await upsertDocument(tx, { code: adapter.code, doc: prepared, runId: run.id, originalS3Key: originalKey });
      counts[outcome.outcome] = 1;
      await finishRun(tx, run.id, { status: "completed", counts, notes, failures: [], errorMessage: null });
      await updateSourceAfterImport(tx, { code: adapter.code, at, manual, externalId: prepared.externalId, outcome: outcome.outcome });
      await insertImportLog(tx, {
        ...logBase,
        fileContentType: input.contentType,
        outcome: outcome.outcome,
        externalId: prepared.externalId,
        documentId: outcome.documentId,
        documentVersion: outcome.version,
        runId: run.id,
      });
      return outcome;
    });
    deps.log?.(`[library] ${adapter.code} manual import: ${prepared.externalId} ${stored.outcome} (version ${stored.version})`);
    return {
      ok: true,
      outcome: stored.outcome,
      documentId: stored.documentId,
      version: stored.version,
      externalId: prepared.externalId,
      title: prepared.title,
      runId: run.id,
      notes,
    };
  } catch (err) {
    return fail(describeError(err), "failed");
  }
}
