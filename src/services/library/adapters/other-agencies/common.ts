import { htmlToDocumentText, mainContent } from "../../extract/html";
import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import type { KnownFetch, LibraryAdapterContext, LibraryDocumentInput, LibraryHttpResponse } from "../../types";
import { docxText } from "./docx";

// Helpers shared by the collectors in this folder (other federal agencies'
// immigration guidance, the Federal Register, Regulations.gov, OMB's
// paperwork records and the occupational sources): listing fingerprints,
// a per-run page cache, and reading one linked file (PDF, Word .docx or
// HTML page) into text. Pure apart from ctx.http: no database, no
// module-level state that outlives a run.

/** sha256Hex of what a listing states, cut to 32 characters (the listing fingerprint). */
export function fingerprintOf(...parts: (string | number | boolean | null | undefined)[]): string {
  return sha256Hex(parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("\u0000")).slice(0, 32);
}

// One cache per run context: a page read for the listing (an announcements
// page, a manual chapter that holds several sections) is not fetched again
// for each document on it in the same run. Keyed by the ctx object, so it
// is dropped with the run.
const RUN_CACHES = new WeakMap<LibraryAdapterContext, Map<string, Promise<unknown>>>();

/** `load()` once per run for `key`; a failed load is not cached. */
export function runCached<T>(ctx: LibraryAdapterContext, key: string, load: () => Promise<T>): Promise<T> {
  let cache = RUN_CACHES.get(ctx);
  if (!cache) {
    cache = new Map();
    RUN_CACHES.set(ctx, cache);
  }
  const hit = cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const promise = load();
  cache.set(key, promise);
  promise.catch(() => cache?.delete(key));
  return promise;
}

/** A page read once per run: its decoded text and the response. */
export function cachedPage(
  ctx: LibraryAdapterContext,
  url: string,
  options: { expect?: "html" | "xml" | "json" | "text" | "any"; maxBytes?: number; timeoutMs?: number } = {}
): Promise<{ text: string; response: LibraryHttpResponse }> {
  return runCached(ctx, `page:${url}`, async () => {
    const page = await ctx.http.getText(url, { expect: options.expect ?? "html", ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
    assertNotChallenged(page.response);
    return page;
  });
}

/**
 * A firewall's bot challenge comes back as an empty 202 (acf.gov's AWS WAF)
 * instead of the page. The collector never tries to pass one; it fails with
 * a message that says so, rather than as a layout change.
 */
export function assertNotChallenged(response: LibraryHttpResponse): void {
  if (response.status === 202 && response.body.length === 0) {
    throw new Error(
      `${response.url} answered with a firewall challenge (HTTP 202, empty body) instead of the page; the collector does not answer challenges. The library's User-Agent needs the "Mozilla/5.0 (compatible; ...)" form this host lets through.`
    );
  }
}

/** Waits `ms`, or until the run is stopped. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error("stopped"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("stopped"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Words that mark a title or summary as being about immigration (used to
 * keep only the immigration items of broad listings). Parole counts only in
 * its immigration senses: the Justice Department's broad search otherwise
 * brings in the U.S. Parole Commission's rules on federal prisoners.
 * Removal and trafficking likewise count only in their immigration senses.
 */
export const IMMIGRATION_TERMS =
  /\bimmigra\w*|\bemigra\w*|\basylum\b|\basylees?\b|\baliens?\b|\bnon-?citizens?\b|\bnaturaliz\w*|\bcitizenship\b|\bvisas?\b|\bnonimmigrants?\b|\b(?:humanitarian|significant public benefit|immigration|advance) parole\b|\bparole in place\b|\bparole (?:process|program)(?:es|s)?\b|\bparoled? (?:in)?to the United States\b|\bremoval (?:proceedings|orders?|of (?:aliens|noncitizens)|from the United States)\b|\borders? of removal\b|\bdeport\w*|\brefugees?\b|Temporary Protected Status|\bunaccompanied (?:alien |refugee )?(?:child|children|minors?)\b|\bH-1B\d?\b|\bH-2[AB]\b|\bH-1C\b|\bE-3\b|\bCW-1\b|\bD-1\b|\blabor certification\b|\bprevailing wage\b|\bforeign (?:labor|workers?)\b|\bPERM\b|\bE-Verify\b|\bForm I-9\b|\bI-9\b|\blawfully (?:residing|present)\b|\blawful presence\b|\bqualified (?:alien|non-?citizen)s?\b|\bT[- ]visa\b|\bU[- ]visa\b|\bhuman trafficking\b|\btrafficking (?:in persons|victims?)\b|\bvictims of (?:severe forms of )?trafficking\b|\bconsular\b/i;

/** Lowercased path of a URL, for telling files from pages. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export function isPdfUrl(url: string): boolean {
  return pathOf(url).endsWith(".pdf");
}

/** A response body as text, by its charset when it names one this runtime knows (UTF-8 otherwise). */
export function decodeText(response: LibraryHttpResponse): string {
  const charset = response.charset;
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(response.body);
    } catch {
      // an unknown charset: read as UTF-8
    }
  }
  return response.body.toString("utf-8");
}

/** The text-bearing fields of a document read from one fetched file. */
export type FileText = {
  response: LibraryHttpResponse;
  text: string;
  textKind: "full" | "none";
  kind: "pdf" | "docx" | "html" | "text" | "other";
  pageCount: number | null;
  /** Why there is no text, when there is none (a scan, a legacy .doc, a spreadsheet). */
  noTextReason: string | null;
  extraction: Record<string, unknown> | null;
  original: LibraryDocumentInput["original"];
};

function looksLikePdf(body: Buffer): boolean {
  return body.subarray(0, 1024).toString("latin1").includes("%PDF-");
}

function looksLikeZip(body: Buffer): boolean {
  return body.length > 4 && body.readUInt32LE(0) === 0x04034b50;
}

/**
 * One linked file or page, conditional when `known` names it: a PDF's text
 * (pdf.js, with [Page N] markers), a Word .docx's paragraphs, an HTML
 * page's content (`htmlContent` picks the container; default <main>), or
 * plain text. Anything else (a legacy .doc, a spreadsheet) is kept with its
 * metadata and link only. Returns "not_modified" on a 304.
 */
export async function fetchFileText(
  ctx: LibraryAdapterContext,
  url: string,
  known: KnownFetch | null | undefined,
  options: { htmlContent?: (html: string) => string | null; maxBytes?: number; headers?: Record<string, string> } = {}
): Promise<FileText | "not_modified"> {
  const response = await ctx.http.get(url, {
    expect: "any",
    conditional: known ?? null,
    maxBytes: options.maxBytes ?? 80 * 1024 * 1024,
    ...(options.headers ? { headers: options.headers } : {}),
  });
  if (response.notModified) return "not_modified";
  assertNotChallenged(response);
  const type = response.contentType ?? "";
  const path = pathOf(response.url);

  if (looksLikePdf(response.body)) {
    const pdf = await extractPdfText(response.body);
    if (pdf.truncated) ctx.note(`${response.url}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    const hasText = pdf.pagesWithText > 0;
    return {
      response,
      text: hasText ? pdf.text : "",
      textKind: hasText ? "full" : "none",
      kind: "pdf",
      pageCount: pdf.pageCount,
      noTextReason: hasText ? null : "The PDF has no text layer (a scan); no OCR is run, so only its title, metadata and link are held.",
      extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated },
      original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
    };
  }

  if (looksLikeZip(response.body) && (path.endsWith(".docx") || /wordprocessingml|docx|octet-stream|msword/.test(type))) {
    const docx = docxText(response.body);
    if (docx !== null) {
      return {
        response,
        text: docx,
        textKind: docx ? "full" : "none",
        kind: "docx",
        pageCount: null,
        noTextReason: docx ? null : "The Word file holds no text.",
        extraction: { method: "docx" },
        original: { bytes: response.body, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: "docx" },
      };
    }
  }

  if (/^text\/html|xhtml/.test(type)) {
    const html = decodeText(response);
    const content = options.htmlContent?.(html) ?? mainContent(html);
    const text = htmlToDocumentText(content);
    return { response, text, textKind: text ? "full" : "none", kind: "html", pageCount: null, noTextReason: text ? null : "The page has no text.", extraction: null, original: null };
  }

  if (/^text\/plain/.test(type)) {
    const text = decodeText(response);
    return { response, text, textKind: text.trim() ? "full" : "none", kind: "text", pageCount: null, noTextReason: null, extraction: null, original: null };
  }

  return {
    response,
    text: "",
    textKind: "none",
    kind: "other",
    pageCount: null,
    noTextReason: `The file is ${type || "of an unknown type"}, which is not read for text; only its title, metadata and link are held.`,
    extraction: null,
    original: null,
  };
}

/** The fields every document read from one file carries: text, original, fetch, and the address it was read from. */
export function fileFields(file: FileText): Pick<LibraryDocumentInput, "text" | "textKind" | "original" | "fetch" | "officialUrl"> {
  return {
    officialUrl: file.response.url,
    text: file.text,
    textKind: file.textKind,
    original: file.original,
    fetch: { response: file.response, ...(file.extraction ? { extraction: file.extraction } : {}) },
  };
}

/** Metadata notes about a file (its page count; why it has no text). */
export function fileMetadata(file: FileText): Record<string, unknown> {
  return {
    ...(file.pageCount !== null ? { pageCount: file.pageCount } : {}),
    ...(file.noTextReason ? { textNote: file.noTextReason } : {}),
    fileKind: file.kind,
  };
}

/** A non-negative integer offset cursor ({ offset }). */
export function offsetOf(cursor: unknown): number {
  const offset = (cursor as { offset?: unknown } | null)?.offset;
  return typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

/** Hands a full listing out `size` refs at a time with an { offset } cursor (a stale offset past the end finishes the walk). */
export function chunkOf<T>(all: T[], cursor: unknown, size: number): { items: T[]; nextCursor: { offset: number } | null; progress: string } {
  const offset = Math.min(offsetOf(cursor), all.length);
  const items = all.slice(offset, offset + size);
  const next = offset + size;
  return {
    items,
    nextCursor: next < all.length ? { offset: next } : null,
    progress: all.length ? `entries ${offset + 1} to ${offset + items.length} of ${all.length} listed` : "nothing listed",
  };
}

/** The HTML page as clean text when the page itself is the document. */
export function pageText(fragment: string): string {
  return htmlToDocumentText(fragment);
}
