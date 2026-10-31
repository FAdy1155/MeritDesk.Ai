import { extractPdfText, type PdfText } from "../../extract/pdf";
import type { LibraryAdapterContext, LibraryHttpResponse } from "../../types";
import { pdfPages, type PdfPage } from "./parse";

// Reading one case out of a file that holds many: the Supreme Court links
// the opinions of its older terms to a page of a preliminary print or bound
// volume ("588US2PP_final.pdf#page=502"), and consecutive refs usually point
// into the same file. The last file read is kept (one at a time, for the
// life of the process) with its validators, so a chunk of refs into one
// volume downloads and extracts it once; a conditional GET checks it is
// still current for each ref.

type CachedFile = { url: string; response: LibraryHttpResponse; pdf: PdfText; pages: PdfPage[] };

let lastFile: CachedFile | null = null;

const VOLUME_TIMEOUT_MS = 3 * 60 * 1000;

export type FilePages = {
  /** The response the pages were read from (the cached one when the file has not changed). */
  response: LibraryHttpResponse;
  pdf: PdfText;
  pages: PdfPage[];
};

/**
 * The file at `url` (no fragment), its text split into pages. With `known`
 * (the stored document's validators) a 304 returns null: nothing changed.
 */
export async function readPdfPages(
  ctx: LibraryAdapterContext,
  url: string,
  known: { url: string; etag: string | null; lastModified: string | null } | null
): Promise<FilePages | null> {
  const cached = lastFile && lastFile.url === url ? lastFile : null;
  const conditional =
    known && known.url === url
      ? known
      : cached
        ? { url, etag: cached.response.etag, lastModified: cached.response.lastModified }
        : null;
  // A bound volume or preliminary print runs to several megabytes, and
  // supremecourt.gov has timed out at the default minute serving one (586BV.pdf,
  // 5 MB, October 2026): each attempt gets three minutes.
  const response = await ctx.http.get(url, { expect: "pdf", conditional, timeoutMs: VOLUME_TIMEOUT_MS });
  if (response.notModified) {
    // Unchanged since the stored copy (known) or since the copy read for an earlier ref (cached).
    if (known && known.url === url) return null;
    if (cached) return { response: cached.response, pdf: cached.pdf, pages: cached.pages };
    return null;
  }
  const pdf = await extractPdfText(response.body);
  const pages = pdfPages(pdf.text);
  lastFile = { url, response, pdf, pages };
  return { response, pdf, pages };
}
