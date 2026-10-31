import { parseStatedDate } from "@/services/monitoring/parse/dates";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import {
  fetchUscisFile,
  fingerprintOf,
  MAX_FILE_BYTES,
  pdfExtraction,
  pdfOriginal,
  permanentFetchProblem,
  sinceFilter,
  USCIS_AGENCY,
  USCIS_HOSTS,
} from "./common";
import { fileExtension, httpsForUscis, parseListingPage, parseRss, rssDate, statedFileBytes, urlPath } from "./parse";

// USCIS's FOIA Electronic Reading Room
// (https://www.uscis.gov/records/electronic-reading-room): records USCIS
// releases because they are requested often or likely to be: operational
// guidance and procedures (standard operating procedures, processing and
// training guidance), congressional and stakeholder correspondence,
// background research and the like. About 2,060 entries in October 2026,
// back to 1977.
//
// What is left out, by rule, at listing time (each counted in the run's
// notes):
// - entries that are web pages rather than released files (the standing
//   web guidance collector reads USCIS's pages);
// - FOIA request logs (/document/foia-logs/): logs of requests received;
// - files in USCIS's memoranda folders, which the memoranda collector
//   (uscis_policy_memoranda) holds with their currentness;
// - asylum officer lesson plans, training material and the asylum
//   procedures manuals, which the asylum officer training collector (other
//   agency guidance) holds;
// - the reading room's "A-Files of Notable People" (immigration files of
//   named individuals, released for historical interest: personal records,
//   not guidance) and "Contracts" (procurement records) categories, read
//   from the listing's own category filter each run;
// - files other than PDFs (spreadsheets, Word files), which the library
//   cannot read, and files the listing says are larger than the 60 MB the
//   library reads.
//
// - Daily: the reading room's RSS feed (its newest 250 entries), those dated
//   since the last run with a margin.
// - Backfill: the listing's pages, newest first, following its "next" link
//   (10 entries a page); the cursor is the next page's link.

const READING_ROOM_URL = "https://www.uscis.gov/records/electronic-reading-room";
const RSS_URL = "https://www.uscis.gov/news/rss-feed/60822";
// Four listing pages (about 40 files): some releases are scans of a thousand pages.
const PAGES_PER_CHUNK = 4;
const MEMO_FOLDERS = /^\/sites\/default\/files\/document\/(?:memos|policy-alerts|policy-manual)\//i;

// The listing's categories left out (see above), by the filter's own id and
// label; the label is checked on each read, so a renumbered filter fails the
// run instead of letting the wrong category through.
const LEFT_OUT_CATEGORIES = [
  { id: "33658", label: "A-Files of Notable People", why: "an A-file of a named person (personal records, not guidance)" },
  { id: "33668", label: "Contracts", why: "a USCIS contract (procurement records, not guidance)" },
] as const;
const MAX_CATEGORY_PAGES = 5;

type Listing = { title: string; dateText: string | null; date: string | null; summary: string; fileInfo: string | null };

type Cursor = { next: string; page: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && typeof c.next === "string" && c.next.startsWith(READING_ROOM_URL) && Number.isInteger(c.page);
}

/**
 * The rows the asylum officer training collector (other agency guidance)
 * holds: lesson plans, asylum officer training material and the asylum
 * procedures manuals, recognized by title or file name the way that
 * collector recognizes them, so the two never hold the same release.
 */
function isAsylumTrainingRow(title: string, url: string): boolean {
  let file = "";
  try {
    file = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    file = url;
  }
  return (
    /\bLP\s*\(RAIO\)|\bRAIO\b.*\b(?:Lesson|LP|Training)\b|\bLesson\s*Plans?\b/i.test(title) ||
    /_LP_RAIO|RAIO_Lesson_Plan|Lesson_?Plan/i.test(file) ||
    /\b(?:Affirmative Asylum|Credible Fear|Reasonable Fear)\b.*\bProcedures Manual\b/i.test(title) ||
    /\bAsylum Officer (?:Basic )?Training\b|\bAOBTC\b|\bADOTC\b|\bBasic Training Course\b/i.test(title)
  );
}

/**
 * The released files of the left-out categories, by URL path, with the
 * reason: each category's listing (100 rows a page) through the reading
 * room's own filter. Read once per run.
 */
const leftOutThisRun = new WeakMap<LibraryAdapterContext, Promise<Map<string, string>>>();

function categoryExclusions(ctx: LibraryAdapterContext): Promise<Map<string, string>> {
  let found = leftOutThisRun.get(ctx);
  if (!found) {
    found = readCategoryExclusions(ctx);
    found.catch(() => leftOutThisRun.delete(ctx));
    leftOutThisRun.set(ctx, found);
  }
  return found;
}

async function readCategoryExclusions(ctx: LibraryAdapterContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const category of LEFT_OUT_CATEGORIES) {
    let next: string | null = `${READING_ROOM_URL}?topic_id%5B%5D=${category.id}&items_per_page=100`;
    let rows = 0;
    for (let page = 0; page < MAX_CATEGORY_PAGES && next; page++) {
      const { text, response } = await ctx.http.getText(next, { expect: "html" });
      const parsed = parseListingPage(text, response.url);
      if (!parsed.recognized) throw new LibraryLayoutError(next, "not the reading room listing (no listing view)");
      if (page === 0 && !new RegExp(`<option value="${category.id}"[^>]*>\\s*${category.label}\\s*</option>`).test(text)) {
        throw new LibraryLayoutError(next, `the category filter ${category.id} is no longer "${category.label}"`);
      }
      for (const row of parsed.rows) out.set(urlPath(row.url), category.why);
      rows += parsed.rows.length;
      next = parsed.rows.length && parsed.nextUrl?.startsWith(READING_ROOM_URL) ? parsed.nextUrl : null;
    }
    if (rows === 0) throw new LibraryLayoutError(READING_ROOM_URL, `the "${category.label}" category lists no entries`);
  }
  return out;
}

/** Why a reading room entry is not collected here, or null when it is. */
function leftOutBecause(url: string, fileInfo: string | null, title: string, byCategory: Map<string, string>): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a link";
  }
  if (u.hostname !== "www.uscis.gov") return "off www.uscis.gov";
  const path = u.pathname;
  if (!path.startsWith("/sites/default/files/")) return "a web page, not a released file";
  if (/^\/sites\/default\/files\/document\/foia-logs\//i.test(path)) return "a FOIA request log";
  const category = byCategory.get(path);
  if (category) return category;
  if (MEMO_FOLDERS.test(path)) return "in USCIS's memoranda folders (held by the memoranda collector)";
  if (isAsylumTrainingRow(title, url)) return "asylum officer training material (held by the asylum officer training collector)";
  if (fileExtension(url) !== "pdf") return `a .${fileExtension(url) || "unknown"} file, which the library does not read`;
  const bytes = statedFileBytes(fileInfo);
  if (bytes && bytes > MAX_FILE_BYTES) return `larger (${fileInfo}) than the library reads`;
  return null;
}

async function collect(ctx: LibraryAdapterContext, entries: { url: string; listing: Listing }[]): Promise<DocumentRef[]> {
  const byCategory = await categoryExclusions(ctx);
  const reasons = new Map<string, number>();
  const refs: DocumentRef[] = [];
  for (const e of entries) {
    const why = leftOutBecause(e.url, e.listing.fileInfo, e.listing.title, byCategory);
    if (why) {
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
      continue;
    }
    refs.push({
      externalId: urlPath(e.url),
      url: e.url,
      title: e.listing.title,
      // The parsed date, not the text: the feed and the listing pages write the same date differently.
      fingerprint: fingerprintOf(e.listing.title, e.url, e.listing.date),
      listing: e.listing,
    });
  }
  for (const [why, n] of reasons) ctx.note(`${n} reading room entr${n === 1 ? "y was" : "ies were"} left out: ${why}.`);
  return refs;
}

export const uscisFoiaReadingRoomAdapter: LibrarySourceAdapter = {
  code: "uscis_foia_reading_room",
  group: "uscis-policy-guidance",
  name: "USCIS FOIA Electronic Reading Room",
  description:
    "Records USCIS releases in its FOIA Electronic Reading Room: operational guidance, procedures and training material, and congressional and stakeholder correspondence, read from the released PDFs.",
  coverage:
    "Every released PDF the reading room lists (about 2,060 entries in October 2026, back to 1977), except FOIA request logs, web pages, A-files of notable people, contracts, memoranda files (held with the memoranda), asylum officer training material (held with the other agency guidance), non-PDF files and files over 60 MB.",
  cadence: "Daily",
  officialUrl: READING_ROOM_URL,
  hosts: USCIS_HOSTS,
  license: "public_domain",
  staleAfterHours: 72,
  recheckAfterDays: 120,
  maxDocumentsPerDailyRun: 60,

  async listUpdates(ctx, since) {
    // A conditional GET: an unchanged feed (HTTP 304) has nothing new.
    const { text, unchanged } = await ctx.http.getListing(RSS_URL, { expect: "xml" });
    if (unchanged) return { refs: [] };
    const feed = parseRss(text);
    if (!feed.recognized || feed.items.length === 0) throw new LibraryLayoutError(RSS_URL, "no <item> entries in the reading room feed");
    const entries = feed.items.map((item) => ({
      url: httpsForUscis(item.link),
      listing: { title: item.title, dateText: item.pubDate, date: rssDate(item.pubDate), summary: item.description, fileInfo: null },
    }));
    return { refs: sinceFilter(await collect(ctx, entries), (r) => (r.listing as Listing).date, since, 14, 40) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const state: Cursor = isCursor(cursor) ? cursor : { next: READING_ROOM_URL, page: 0 };
    const entries: { url: string; listing: Listing }[] = [];
    let next: string | null = state.next;
    let page = state.page;
    let total: number | null = null;
    for (let i = 0; i < PAGES_PER_CHUNK && next; i++) {
      const { text, response } = await ctx.http.getText(next, { expect: "html" });
      const parsed = parseListingPage(text, response.url);
      if (!parsed.recognized) throw new LibraryLayoutError(next, "not the reading room listing (no listing view)");
      if (parsed.rows.length === 0 && page === 0) throw new LibraryLayoutError(next, "the first page of the listing has no entries");
      for (const note of parsed.notes) ctx.note(note);
      total = parsed.total ?? total;
      for (const row of parsed.rows) {
        entries.push({
          url: row.url,
          listing: { title: row.title, dateText: row.dateText, date: parseStatedDate(row.dateText), summary: row.teaser, fileInfo: row.fileInfo },
        });
      }
      page++;
      next = parsed.rows.length && parsed.nextUrl?.startsWith(READING_ROOM_URL) ? parsed.nextUrl : null;
    }
    return {
      refs: await collect(ctx, entries),
      nextCursor: next ? { next, page } : null,
      progress: `listing pages ${state.page + 1} to ${page}${total ? ` (${total} entries in all)` : ""}`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.title) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    let file;
    try {
      file = await fetchUscisFile(ctx, ref.url, ref.known);
    } catch (err) {
      const problem = permanentFetchProblem(err);
      if (problem) return { kind: "skip", reason: problem };
      throw err;
    }
    if (file.kind === "not_modified") return { kind: "not_modified" };
    if (file.kind !== "pdf") return { kind: "skip", reason: `${file.response.url} answered ${file.response.contentType || "an unknown type"}, not a PDF.` };
    const pdf = file.pdf;
    if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "other",
        title: listing.title,
        citations: [],
        agency: USCIS_AGENCY,
        publishedDate: listing.date,
        precedentialStatus: "not_applicable",
        officialUrl: ref.url,
        originalUrl: file.response.url !== ref.url ? file.response.url : null,
        text: pdf.pagesWithText > 0 ? pdf.text : "",
        textKind: pdf.pagesWithText > 0 ? "full" : "none",
        metadata: {
          collection: "FOIA Electronic Reading Room",
          ...(listing.summary ? { summary: listing.summary } : {}),
          ...(listing.fileInfo ? { fileAsListed: listing.fileInfo } : {}),
          statedDates: listing.dateText ? { listed: listing.dateText } : {},
          pageCount: pdf.pageCount,
          ...(pdf.pagesWithText === 0 ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}),
          listedOn: READING_ROOM_URL,
        },
        original: pdfOriginal(file.response),
        fetch: { response: file.response, extraction: pdfExtraction(pdf) },
      },
    };
  },
};
