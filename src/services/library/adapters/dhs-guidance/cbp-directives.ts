import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryDocumentInput,
  type LibrarySourceAdapter,
} from "../../types";
import { fetchFileText, fileMetadata, fingerprintOf, type FileText } from "./files";
import { cbpDirectiveDesignation, isPdfUrl, parseCbpDocumentPage, parseCbpListing, type CbpEntry, type CbpFile } from "./parse";

// CBP's policies, procedures and directives, from CBP's "Policies,
// Procedures and Directives" table (about 800 rows, 15 a page): each entry
// has its own page on cbp.gov, an abstract, one or more files, a post date
// and a last-modified date. An entry with several files is listed once per
// file; the rows are merged by the entry's page. The table covers the whole
// agency (trade, personnel and operations as well as immigration), and the
// collector keeps every entry rather than guess which ones bear on
// immigration practice.
//
// - Daily: the table sorted by last-modified date, newest first, walking on
//   while entries changed after the last successful run.
// - Backfill: the table sorted by post date, newest first, PAGES_PER_CHUNK
//   pages per chunk.
// - A document is the entry: its PDFs' text, in the order listed, each
//   headed "[File: <label>]" when there are several; an entry that
//   publishes no file is read from its page. The entry's page is the
//   address cited; the abstract is CBP's own summary.
//
// US government work: public domain, stored in full.

const LISTING_URL = "https://www.cbp.gov/newsroom/accountability-and-transparency/policies-procedures-and-directives";
const HOSTS = ["www.cbp.gov", "cbp.gov"] as const;
const AGENCY = "U.S. Customs and Border Protection";
const PAGES_PER_CHUNK = 6;
const DAILY_MAX_PAGES = 4;
const DAILY_OVERLAP_MS = 30 * 24 * 60 * 60 * 1000;

type Cursor = { page: number };
type Listing = Omit<CbpEntry, "pageUrl"> & { listedOn: string };

/** A page of the table in one of the orders its own column headers link ("?order=field_release_date&sort=desc"). */
function tableUrl(order: "field_release_date" | "field_date_release", page: number): string {
  const url = new URL(LISTING_URL);
  url.searchParams.set("order", order);
  url.searchParams.set("sort", "desc");
  if (page > 0) url.searchParams.set("page", String(page));
  return url.toString();
}

async function readTable(ctx: LibraryAdapterContext, order: "field_release_date" | "field_date_release", page: number) {
  const url = tableUrl(order, page);
  const { text, response } = await ctx.http.getText(url, { expect: "html" });
  const parsed = parseCbpListing(text, response.url, HOSTS);
  if (!parsed.recognized) throw new LibraryLayoutError(url, "no policies and directives table");
  if (page === 0 && parsed.entries.length === 0) throw new LibraryLayoutError(url, "the table lists no entries");
  return { url, ...parsed };
}

function refFor(entry: CbpEntry, listedOn: string): DocumentRef {
  const { pageUrl, ...rest } = entry;
  const listing: Listing = { ...rest, listedOn };
  return {
    externalId: new URL(pageUrl).pathname,
    url: pageUrl,
    title: entry.title,
    fingerprint: fingerprintOf(entry.title, entry.abstract, entry.files.map((f) => `${f.url} ${f.label}`).join("|"), entry.postDate, entry.lastModified),
    listing,
  };
}

function isCursor(value: unknown): value is Cursor {
  return Boolean(value) && Number.isInteger((value as Cursor).page) && (value as Cursor).page >= 0;
}

export const cbpDirectivesAdapter: LibrarySourceAdapter = {
  code: "cbp_policies_directives",
  group: "other-agency-guidance",
  name: "CBP policies, procedures and directives",
  description:
    "CBP's directives, policy memoranda and procedures as CBP lists them on its Policies, Procedures and Directives page, each with CBP's abstract and the text of its files.",
  coverage:
    "Every entry in CBP's Policies, Procedures and Directives table (about 800 rows, posted 2013 to the present), immigration and non-immigration alike; scans without a text layer are held with their abstract and link.",
  cadence: "Daily",
  officialUrl: LISTING_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 60,

  async listUpdates(ctx, since) {
    const refs = new Map<string, DocumentRef>();
    const cutoff = since ? since.getTime() - DAILY_OVERLAP_MS : null;
    for (let page = 0; page < DAILY_MAX_PAGES; page++) {
      const listed = await readTable(ctx, "field_date_release", page);
      for (const entry of listed.entries) {
        const ref = refFor(entry, listed.url);
        if (!refs.has(ref.externalId)) refs.set(ref.externalId, ref);
      }
      const changed = listed.entries
        .map((e) => Date.parse(e.lastModifiedDateTime ?? e.postDateTime ?? ""))
        .filter((t) => Number.isFinite(t));
      const oldest = changed.length ? Math.min(...changed) : -Infinity;
      const hasNext = listed.lastPage !== null && listed.lastPage > page;
      if (!hasNext || cutoff === null || !(oldest > cutoff)) break;
    }
    return { refs: [...refs.values()] };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const start = isCursor(cursor) ? cursor.page : 0;
    const refs = new Map<string, DocumentRef>();
    let page = start;
    let lastPage: number | null = null;
    for (; page < start + PAGES_PER_CHUNK; page++) {
      const listed = await readTable(ctx, "field_release_date", page);
      lastPage = listed.lastPage ?? page;
      for (const entry of listed.entries) {
        const ref = refFor(entry, listed.url);
        if (!refs.has(ref.externalId)) refs.set(ref.externalId, ref);
      }
      // Past the last page (a stale cursor after the table shrank) or on it: the walk is done.
      if (listed.entries.length === 0 || page >= lastPage) {
        page++;
        return { refs: [...refs.values()], nextCursor: null, progress: `table pages ${start + 1} to ${page}; the last page was reached` };
      }
    }
    return {
      refs: [...refs.values()],
      nextCursor: { page },
      progress: `table pages ${start + 1} to ${page} of ${lastPage !== null ? lastPage + 1 : "?"}, ${refs.size} entries`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.title) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const pdfs = listing.files.filter((f) => isPdfUrl(f.url));
    const others = listing.files.filter((f) => !isPdfUrl(f.url));
    const read: { file: CbpFile; text: FileText }[] = [];
    let body: string | null = null;
    let pageResponse: FileText["response"] | null = null;
    let publicationNumber: string | null = null;

    if (pdfs.length > 0) {
      for (const f of pdfs) {
        // A single file can be checked with a conditional GET; several are read again together.
        const result = await fetchFileText(ctx, f.url, pdfs.length === 1 ? ref.known : null);
        if (result === "not_modified") return { kind: "not_modified" };
        read.push({ file: f, text: result });
      }
    } else {
      const { text: html, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
      if (response.notModified) return { kind: "not_modified" };
      const page = parseCbpDocumentPage(html);
      if (!page.bodyHtml) return { kind: "skip", reason: `${ref.url}: the entry's page has no body and the table lists no PDF.` };
      body = htmlToDocumentText(page.bodyHtml);
      pageResponse = response;
      publicationNumber = page.publicationNumber;
    }

    const withText = read.filter((r) => r.text.textKind === "full");
    const text =
      body ??
      (read.length === 1 ? read[0].text.text : withText.map((r) => `[File: ${r.file.label}]\n\n${r.text.text}`).join("\n\n"));
    const first = read[0]?.text ?? null;
    const designation = cbpDirectiveDesignation(listing.title);
    const extra: Partial<LibraryDocumentInput> = first
      ? {
          originalUrl: first.response.url,
          original: read.length === 1 ? first.original : null,
          fetch: { response: first.response, ...(first.extraction ? { extraction: first.extraction } : {}) },
        }
      : { fetch: pageResponse ? { response: pageResponse } : null };
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "policy_memorandum",
        title: listing.title,
        citations: designation ? [designation] : [],
        agency: AGENCY,
        publishedDate: parseStatedDate(listing.postDate),
        precedentialStatus: "not_applicable",
        officialUrl: ref.url,
        text,
        textKind: text ? "full" : "none",
        ...extra,
        metadata: {
          ...(listing.abstract ? { summary: listing.abstract, summaryKind: "CBP's abstract" } : {}),
          ...(designation ? { designation } : {}),
          ...(publicationNumber ? { publicationNumber } : {}),
          files: listing.files.map((f) => ({ label: f.label, url: f.url })),
          ...(others.length ? { filesNotRead: others.map((f) => f.url) } : {}),
          ...(read.some((r) => r.text.noTextLayer) ? { filesWithoutTextLayer: read.filter((r) => r.text.noTextLayer).map((r) => r.file.url) } : {}),
          ...(read.length === 1 ? fileMetadata(read[0].text) : {}),
          ...(listing.lastModified && parseStatedDate(listing.lastModified) ? { lastModified: parseStatedDate(listing.lastModified) } : {}),
          listedOn: listing.listedOn,
          statedDates: {
            ...(listing.postDate ? { documentPostDate: listing.postDate } : {}),
            ...(listing.lastModified ? { lastModifiedDate: listing.lastModified } : {}),
          },
        },
      },
    };
  },
};
