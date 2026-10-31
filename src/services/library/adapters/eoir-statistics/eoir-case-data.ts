import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { decodeReleaseText, FOIA_LIBRARY_URL, parseCountFile, parseFoiaLibraryPage, parseSchemaFile } from "./parse";
import { readReleaseDirectory, readSmallEntries, type ReleaseDirectory } from "./release";
import { releaseFolder, type ZipEntry } from "./zip";

// EOIR's public case data release: the "EOIR Case Data" file EOIR posts in
// its FOIA library (a ZIP64 archive of about 4.5 GB, updated monthly, of
// tab-separated tables from its CASE database, with lookup tables and a
// schema listing), and the "EOIR Case Data Code Key" PDF beside it.
//
// This collector keeps two library documents: the release's own description
// (its file list, Readme.txt, Count.txt and the field list of
// EOIRDB_Schema.csv, read by HTTP range requests from the end of the
// archive: a few hundred kilobytes, never the tables) and the code key's
// text. The statistics themselves (judges, courts, outcomes, relief,
// appeals, processing times) are built from the tables by a separate worker
// job that streams the release (./loader.ts, ./jobs.ts) into aggregate
// tables (src/db/schema-eoir-stats.ts); no record of a person is kept.
//
// - Daily: the FOIA library page, both links; the release document is
//   re-read when its label changes ("(August 2026)") and checked weekly with
//   a conditional request (the archive's ETag), so a new release posted
//   under the same label is still found.
// - Backfill: EOIR keeps only the current release online, so the history is
//   the same two documents.
// - justice.gov asks for 10 seconds between requests; fileshare.eoir has no
//   robots.txt (404: everything allowed) and gets the default pace.
//
// US government work: public domain, stored in full. Not a decision:
// precedential status not_applicable.

const HOSTS = ["www.justice.gov", "justice.gov", "fileshare.eoir.justice.gov"] as const;
const AGENCY = "Executive Office for Immigration Review";
const RELEASE_ID = "eoir-case-data-release";
const CODE_KEY_ID = "eoir-case-data-code-key";

type Listing = { kind: "release" | "code_key"; linkText: string; label: string | null; pageUrl: string; pageUpdated: string | null };

async function listing(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(FOIA_LIBRARY_URL, { expect: "html" });
  const links = parseFoiaLibraryPage(text, response.url);
  if (!links) throw new LibraryLayoutError(FOIA_LIBRARY_URL, 'no "EOIR Case Data" link to a .zip file');
  const refs: DocumentRef[] = [];
  const release: Listing = { kind: "release", linkText: links.caseData.linkText, label: links.caseData.label, pageUrl: response.url, pageUpdated: links.pageUpdated };
  refs.push({
    externalId: RELEASE_ID,
    url: links.caseData.url,
    title: `${links.caseData.linkText}${links.caseData.label ? ` (${links.caseData.label})` : ""}`,
    fingerprint: sha256Hex([links.caseData.url, links.caseData.linkText, links.caseData.label ?? ""].join("\u0000")).slice(0, 32),
    listing: release,
  });
  if (links.codeKey) {
    const key: Listing = { kind: "code_key", linkText: links.codeKey.linkText, label: links.codeKey.label, pageUrl: response.url, pageUpdated: links.pageUpdated };
    refs.push({
      externalId: CODE_KEY_ID,
      url: links.codeKey.url,
      title: `${links.codeKey.linkText}${links.codeKey.label ? ` (${links.codeKey.label})` : ""}`,
      fingerprint: sha256Hex([links.codeKey.url, links.codeKey.linkText, links.codeKey.label ?? ""].join("\u0000")).slice(0, 32),
      listing: key,
    });
  } else {
    ctx.note('The FOIA library page has no "EOIR Case Data Code Key" link today; only the release was listed.');
  }
  return refs;
}

/** "August 2026" -> 2026; null for anything else. */
function labelYear(label: string | null): number | null {
  const m = /\b(19|20)(\d{2})\b/.exec(label ?? "");
  return m ? Number(m[1] + m[2]) : null;
}

function fileLine(e: ZipEntry): string {
  return `- ${e.name}: ${e.size.toLocaleString("en-US")} bytes (${e.compressedSize.toLocaleString("en-US")} compressed)${e.modified ? `, dated ${e.modified}` : ""}`;
}

/** The release's description as one text: the file list and the release's own Readme, row counts and schema listing, verbatim. */
function releaseText(params: { title: string; release: ReleaseDirectory; folder: string | null; readme: string | null; count: string | null; schema: string | null }): string {
  const { release } = params;
  const files = release.entries.filter((e) => !e.name.endsWith("/"));
  const parts = [
    params.title,
    `Release folder: ${params.folder ?? "(the archive has no single top folder)"}`,
    `File: ${release.url}, ${release.fileSize.toLocaleString("en-US")} bytes${release.lastModified ? `, Last-Modified ${release.lastModified}` : ""}`,
    "",
    `Files in the release (${files.length}):`,
    ...files.map(fileLine),
  ];
  if (params.readme) parts.push("", "Readme.txt", "", params.readme.trim());
  if (params.count) parts.push("", "Schema_Related/Count.txt", "", params.count.trim());
  if (params.schema) {
    const fields = parseSchemaFile(params.schema);
    parts.push("", "Schema_Related/EOIRDB_Schema.csv (table, field, data type, nullable)", "");
    if (fields.length) {
      for (const f of fields) parts.push(`${f.table}\t${f.field}\t${f.type}\t${f.nullable}`);
    } else {
      parts.push(params.schema.trim());
    }
  }
  return parts.join("\n");
}

async function fetchRelease(ctx: LibraryAdapterContext, ref: DocumentRef, listed: Listing): Promise<FetchDocumentResult> {
  const read = await readReleaseDirectory(ctx.http, ref.url, ref.known ?? null);
  if (read.notModified) return { kind: "not_modified" };
  const { folder, date } = releaseFolder(read.entries);
  const byName = (suffix: string) => read.entries.find((e) => e.name.toLowerCase().endsWith(suffix.toLowerCase())) ?? null;
  const wanted = [byName("/Readme.txt"), byName("/Schema_Related/Count.txt"), byName("/Schema_Related/EOIRDB_Schema.csv")].filter((e): e is ZipEntry => e !== null);
  if (!wanted.some((e) => e.name.endsWith("Count.txt"))) ctx.note("The release has no Schema_Related/Count.txt this time.");
  const small = await readSmallEntries(ctx.http, read, wanted);
  const textOf = (e: ZipEntry | null) => (e && small.get(e.name) ? decodeReleaseText(small.get(e.name)!) : null);
  const readme = textOf(byName("/Readme.txt"));
  const count = textOf(byName("/Schema_Related/Count.txt"));
  const schema = textOf(byName("/Schema_Related/EOIRDB_Schema.csv"));
  const title = ref.title ?? `${listed.linkText}${listed.label ? ` (${listed.label})` : ""}`;
  const tables = read.entries
    .filter((e) => /\.csv$/i.test(e.name))
    .map((e) => ({ file: e.name, bytes: e.size, compressedBytes: e.compressedSize, dated: e.modified }));
  return {
    kind: "document",
    document: {
      externalId: RELEASE_ID,
      docType: "statistics",
      title,
      citations: [],
      agency: AGENCY,
      // The date in the release's folder name ("EOIR Case Data 2026-0901"): the date of the data extract.
      publishedDate: date,
      documentYear: date ? null : labelYear(listed.label),
      precedentialStatus: "not_applicable",
      officialUrl: read.url,
      text: releaseText({ title, release: read, folder, readme, count, schema }),
      metadata: {
        listedLabel: listed.label,
        listedOn: listed.pageUrl,
        ...(listed.pageUpdated ? { listingPageUpdated: listed.pageUpdated } : {}),
        releaseFolder: folder,
        dataDate: date,
        statedDates: { ...(folder ? { releaseFolder: folder } : {}), ...(listed.label ? { listedLabel: listed.label } : {}), ...(read.lastModified ? { lastModified: read.lastModified } : {}) },
        archiveBytes: read.fileSize,
        archiveEtag: read.etag,
        zip64: read.zip64,
        fileCount: read.entries.filter((e) => !e.name.endsWith("/")).length,
        tables,
        rowCounts: count ? parseCountFile(count) : [],
        textNote: "The tables themselves are not stored as text; the app's EOIR statistics are built from them by a separate job, as aggregate counts only.",
      },
      // The archive (4.5 GB) is never downloaded whole, so there is no original file to keep.
      original: null,
      fetch: { response: read.response, extraction: { method: "zip range requests", entriesRead: wanted.map((e) => e.name) } },
    },
  };
}

async function fetchCodeKey(ctx: LibraryAdapterContext, ref: DocumentRef, listed: Listing): Promise<FetchDocumentResult> {
  const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
  if (response.notModified) return { kind: "not_modified" };
  const pdf = await extractPdfText(response.body);
  if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
  return {
    kind: "document",
    document: {
      externalId: CODE_KEY_ID,
      docType: "statistics",
      title: ref.title ?? listed.linkText,
      citations: [],
      agency: AGENCY,
      documentYear: labelYear(listed.label),
      precedentialStatus: "not_applicable",
      officialUrl: ref.url,
      originalUrl: response.url !== ref.url ? response.url : null,
      text: pdf.pagesWithText > 0 ? pdf.text : "",
      textKind: pdf.pagesWithText > 0 ? "full" : "none",
      metadata: {
        listedLabel: listed.label,
        listedOn: listed.pageUrl,
        statedDates: listed.label ? { listedLabel: listed.label } : {},
        pageCount: pdf.pageCount,
        ...(pdf.pagesWithText === 0 ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}),
      },
      original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
      fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
    },
  };
}

export const eoirCaseDataAdapter: LibrarySourceAdapter = {
  code: "eoir_case_data",
  group: "eoir-statistics",
  name: "EOIR case data release (FOIA library)",
  description:
    "EOIR's monthly public release of its immigration court and Board case database (tables, lookup tables and schema), with its code key. The library keeps the release's description and the code key; the app's judge, court, relief and appeal statistics are computed from the release's tables.",
  coverage:
    "The current release only (EOIR replaces the file each month and keeps no earlier releases online): its file list, Readme, row counts and schema, and the EOIR Case Data Code Key. Statistics: every completed proceeding in the release, as aggregate counts.",
  cadence: "Daily check; EOIR posts a new release about monthly",
  officialUrl: FOIA_LIBRARY_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 7,

  async listUpdates(ctx) {
    return { refs: await listing(ctx) };
  },

  async backfill(ctx): Promise<BackfillChunk> {
    // EOIR keeps only the current release online: the history is the current listing.
    return { refs: await listing(ctx), nextCursor: null, progress: "the current release and its code key (EOIR keeps no earlier releases online)" };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listed = ref.listing as Listing | undefined;
    if (!listed?.kind) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    return listed.kind === "release" ? fetchRelease(ctx, ref, listed) : fetchCodeKey(ctx, ref, listed);
  },
};
