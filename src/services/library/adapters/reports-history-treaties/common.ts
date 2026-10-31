import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import { LibraryLayoutError, type KnownFetch, type LibraryAdapterContext, type LibraryDocumentInput, type LibraryHttpResponse } from "../../types";
import { parseSitemap, type SitemapEntry } from "./parse";

// What the collectors in this folder share: the listing fingerprint, the
// "gone" test for a 404 or 410, sitemap reading, and a PDF read into the
// fields a document carries.

/** sha256Hex of what a listing states, cut to 32 characters (the listing fingerprint). */
export function fingerprintOf(...parts: (string | number | boolean | null | undefined)[]): string {
  return sha256Hex(parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("\u0000")).slice(0, 32);
}

/** A file over the byte cap (OfficialFetchError code too_large). */
export function isTooLarge(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "too_large";
}

/** An HTTP 400, 404 or 410 from ctx.http (OfficialFetchError's code): the host has no such page or file. */
export function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "http_400" || code === "http_404" || code === "http_410";
}

/** A sitemap (index or urlset) read from `url`; a page that is neither fails the run. */
export async function readSitemap(ctx: LibraryAdapterContext, url: string): Promise<{ kind: "index" | "urlset"; entries: SitemapEntry[] }> {
  const { text } = await ctx.http.getText(url, { expect: "xml" });
  const parsed = parseSitemap(text);
  if (!parsed.recognized || !parsed.kind) throw new LibraryLayoutError(url, "not a sitemap (no <sitemapindex> or <urlset>)");
  return { kind: parsed.kind, entries: parsed.entries };
}

export type PdfFields = Pick<LibraryDocumentInput, "text" | "textKind" | "original" | "fetch"> & { pageCount: number; noTextLayer: boolean };

/**
 * A PDF fetched (conditional when `known` names it) and read with pdf.js:
 * its text with [Page N] markers, or textKind "none" for a scan with no
 * text layer. "not_modified" on a 304.
 */
export async function fetchPdf(
  ctx: LibraryAdapterContext,
  url: string,
  known: KnownFetch | null | undefined,
  options: { timeoutMs?: number; maxBytes?: number; label: string }
): Promise<(PdfFields & { response: LibraryHttpResponse }) | "not_modified"> {
  const response = await ctx.http.get(url, { expect: "pdf", conditional: known ?? null, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}) });
  if (response.notModified) return "not_modified";
  const pdf = await extractPdfText(response.body);
  if (pdf.truncated) ctx.note(`${options.label}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
  const hasText = pdf.pagesWithText > 0;
  return {
    response,
    text: hasText ? pdf.text : "",
    textKind: hasText ? "full" : "none",
    pageCount: pdf.pageCount,
    noTextLayer: !hasText,
    original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
    fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
  };
}

/** The YYYY-MM-DD of an ISO time stamp whose date part is the stated date ("2026-09-29T12:00:00Z"); null otherwise. */
export function isoDatePart(value: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(value?.trim() ?? "");
  return m ? m[1] : null;
}
