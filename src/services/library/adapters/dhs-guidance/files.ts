import { htmlToDocumentText, mainContent } from "../../extract/html";
import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import type { KnownFetch, LibraryAdapterContext, LibraryDocumentInput, LibraryHttpResponse } from "../../types";
import { isPdfUrl, mainElement } from "./parse";

// Fetching the files and pages the DHS guidance collectors link: a PDF
// (text with [Page N] markers; a scan with no text layer is kept with its
// metadata and link only) or an HTML page (its main content). Shared by
// every adapter in this folder.

/** sha256Hex of what a listing states, cut to 32 characters (the listing fingerprint). */
export function fingerprintOf(...parts: (string | number | boolean | null | undefined)[]): string {
  return sha256Hex(parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("\u0000")).slice(0, 32);
}

/** The text-bearing fields of a document read from one fetched file. */
export type FileText = {
  response: LibraryHttpResponse;
  text: string;
  textKind: "full" | "none";
  kind: "pdf" | "html";
  /** For PDFs: the page count, and a note when the file has no text layer. */
  pageCount: number | null;
  noTextLayer: boolean;
  extraction: Record<string, unknown> | null;
  original: LibraryDocumentInput["original"];
};

/**
 * One linked file or page, conditional when `known` names it: a PDF's text
 * (pdf.js), or an HTML page's main content (`htmlContent` picks the content
 * container; default the page's <main>). Returns "not_modified" on a 304.
 * `maxBytes` and `timeoutMs` raise the PDF cap and the per-attempt timeout for a source known to publish larger files.
 */
export async function fetchFileText(
  ctx: LibraryAdapterContext,
  url: string,
  known: KnownFetch | null | undefined,
  options: { htmlContent?: (html: string) => string | null; maxBytes?: number; timeoutMs?: number } = {}
): Promise<FileText | "not_modified"> {
  if (isPdfUrl(url)) {
    const response = await ctx.http.get(url, { expect: "pdf", conditional: known ?? null, ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
    if (response.notModified) return "not_modified";
    const pdf = await extractPdfText(response.body);
    if (pdf.truncated) ctx.note(`${url}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    const hasText = pdf.pagesWithText > 0;
    return {
      response,
      text: hasText ? pdf.text : "",
      textKind: hasText ? "full" : "none",
      kind: "pdf",
      pageCount: pdf.pageCount,
      noTextLayer: !hasText,
      extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated },
      original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
    };
  }
  const { text: html, response } = await ctx.http.getText(url, { expect: "html", conditional: known ?? null });
  if (response.notModified) return "not_modified";
  const content = options.htmlContent?.(html) ?? mainElement(html) ?? mainContent(html);
  const text = htmlToDocumentText(content);
  return {
    response,
    text,
    textKind: text ? "full" : "none",
    kind: "html",
    pageCount: null,
    noTextLayer: false,
    extraction: null,
    original: null,
  };
}

/**
 * The fields every document read from one file carries: its text, the
 * original, the fetch, and the file's address after redirects (an http://
 * or bare-domain link lands on the https://www. address), which is the
 * address to cite.
 */
export function fileFields(file: FileText): Pick<LibraryDocumentInput, "text" | "textKind" | "original" | "fetch" | "officialUrl"> {
  return {
    officialUrl: file.response.url,
    text: file.text,
    textKind: file.textKind,
    original: file.original,
    fetch: { response: file.response, ...(file.extraction ? { extraction: file.extraction } : {}) },
  };
}

/** Metadata notes about a PDF (its page count; that it has no text layer). */
export function fileMetadata(file: FileText): Record<string, unknown> {
  return {
    ...(file.pageCount !== null ? { pageCount: file.pageCount } : {}),
    ...(file.noTextLayer ? { textNote: "The PDF has no text layer (a scan); no OCR is run, so only its title, metadata and link are held." } : {}),
  };
}
