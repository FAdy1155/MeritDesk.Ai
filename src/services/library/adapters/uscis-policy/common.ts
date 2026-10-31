import { extractPdfText, type PdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import { LibraryLayoutError, type KnownFetch, type LibraryAdapterContext, type LibraryHttpResponse } from "../../types";
import { parseSitemapIndex, parseSitemapUrls, type SitemapUrl } from "./parse";

// What the USCIS policy collectors share: the host list, the agency's name,
// the change fingerprint, and reading a file or page from www.uscis.gov
// whose kind is not known before it is fetched (a memorandum link may answer
// with the PDF, or redirect to the Policy Manual page that superseded it).
//
// uscis.gov's robots.txt asks for 10 seconds between requests
// (https://www.uscis.gov/robots.txt), which ctx.http applies to every
// request on the host, and disallows /sites/default/files/archive/; every
// collector here counts about 10 seconds a request when sizing its chunks.
// USCIS publications are works of the U.S. government: public domain,
// stored in full.

export const USCIS_HOSTS = ["www.uscis.gov", "uscis.gov"] as const;
export const USCIS_AGENCY = "U.S. Citizenship and Immigration Services";
/** The largest file read (the framework's default PDF cap, LIBRARY_MAX_PDF_MB = 60). */
export const MAX_FILE_BYTES = 60 * 1024 * 1024;

/** A listing fingerprint over what the listing states about a document. */
export function fingerprintOf(...parts: (string | number | null | undefined)[]): string {
  return sha256Hex(parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("\u0000")).slice(0, 32);
}

/** The body of a response as text, by its charset (UTF-8 when it names none). */
export function bodyText(response: LibraryHttpResponse): string {
  try {
    return new TextDecoder(response.charset ?? "utf-8").decode(response.body);
  } catch {
    return response.body.toString("utf-8");
  }
}

/** The error code of a failed official fetch ("http_404"), when the error carries one. */
export function fetchErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export type FetchedFile =
  | { kind: "not_modified" }
  | { kind: "pdf"; response: LibraryHttpResponse; pdf: PdfText }
  | { kind: "html"; response: LibraryHttpResponse; html: string }
  | { kind: "other"; response: LibraryHttpResponse };

/**
 * GET a file or page on www.uscis.gov whose kind is known only from the
 * answer: a PDF (its text read), an HTML page (decoded), or something else
 * (a Word or Excel file, which the library cannot read; the caller skips
 * it). Conditional when the stored copy came from the same URL.
 */
export async function fetchUscisFile(ctx: LibraryAdapterContext, url: string, known: KnownFetch | null | undefined): Promise<FetchedFile> {
  const response = await ctx.http.get(url, { expect: "any", maxBytes: MAX_FILE_BYTES, timeoutMs: 180_000, conditional: known ?? null });
  if (response.notModified) return { kind: "not_modified" };
  const isPdf = response.contentType === "application/pdf" || response.body.subarray(0, 1024).toString("latin1").includes("%PDF-");
  if (isPdf) return { kind: "pdf", response, pdf: await extractPdfText(response.body) };
  if (response.contentType === "text/html" || response.contentType === "application/xhtml+xml") {
    return { kind: "html", response, html: bodyText(response) };
  }
  return { kind: "other", response };
}

/** What a PDF's extraction looked like, for the stored fetch information. */
export function pdfExtraction(pdf: PdfText): Record<string, unknown> {
  return { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated };
}

/** The original file to keep (stored when LIBRARY_STORE_ORIGINALS is on). */
export function pdfOriginal(response: LibraryHttpResponse): { bytes: Buffer; contentType: string; extension: string } {
  return { bytes: response.body, contentType: "application/pdf", extension: "pdf" };
}

/**
 * Fetch errors that mean the document is not there to read (gone, or
 * reached only through a path robots.txt disallows): the ref is skipped
 * with the reason instead of failing and being retried.
 */
export function permanentFetchProblem(err: unknown): string | null {
  const code = fetchErrorCode(err);
  if (code === "http_404" || code === "http_410" || code === "robots_disallowed" || code === "too_large") {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

export const SITEMAP_URL = "https://www.uscis.gov/sitemap.xml";

/**
 * Every URL uscis.gov's site map lists, with its lastmod: the index, then
 * each of its pages (six in October 2026, about 20,000 URLs). The site map
 * is the only list of every file and page the site publishes.
 */
export async function readSitemap(ctx: LibraryAdapterContext): Promise<SitemapUrl[]> {
  const { text } = await ctx.http.getText(SITEMAP_URL, { expect: "xml" });
  const pages = parseSitemapIndex(text);
  if (pages.length === 0) throw new LibraryLayoutError(SITEMAP_URL, "no <sitemap> pages in the site map index");
  const out: SitemapUrl[] = [];
  for (const page of pages) {
    if (!/^https:\/\/www\.uscis\.gov\//.test(page)) {
      ctx.note(`The site map index lists ${page}, which is not on www.uscis.gov; it was not read.`);
      continue;
    }
    const { text: xml } = await ctx.http.getText(page, { expect: "xml", timeoutMs: 120_000 });
    const urls = parseSitemapUrls(xml);
    if (!urls) throw new LibraryLayoutError(page, "not a <urlset>");
    out.push(...urls);
  }
  if (out.length < 1000) throw new LibraryLayoutError(SITEMAP_URL, `only ${out.length} URLs in the site map`);
  return out;
}

/** Items newer than the last run (with a margin), or the newest `firstRun` items before the first run. */
export function sinceFilter<T>(items: T[], dateOf: (item: T) => string | null, since: Date | null, marginDays: number, firstRun: number): T[] {
  if (!since) return items.slice(0, firstRun);
  const from = new Date(since.getTime() - marginDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return items.filter((item) => {
    const date = dateOf(item);
    // An item whose date cannot be read is kept: the fingerprint skips it when it is unchanged.
    return !date || date >= from;
  });
}
