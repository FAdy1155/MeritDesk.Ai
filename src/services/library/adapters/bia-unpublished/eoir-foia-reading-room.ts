import { parseStatedDate } from "@/services/monitoring/parse/dates";
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
import { formDate, isoOfStated, parseReadingRoomForm, parseResultsPage, statedDay, type ReadingRoomForm, type ResultRow, type ResultsPage } from "./parse";

// Unpublished (non-precedent) Board of Immigration Appeals decisions, as
// EOIR releases them in the Reading Room of its FOIA Public Access Link
// (foia.eoir.justice.gov, linked from justice.gov/eoir/freedom-information-act-foia).
// The reading room says EOIR "has made certain redacted BIA decisions"
// available for the release periods it lists (FY2017 on, plus a 2016 pilot)
// and that new decisions are posted daily. Each decision is listed with its
// folder name, decision date, base city, appeal type, filed by, pages, size
// and the date it was posted ("Published Date"), and is one PDF.
//
// How it is read:
// - The search form (ReadingRoom.aspx) is read first on every run, for the
//   results URL, the Decision Date field's name and the folder-name sort
//   value; a change there fails the run instead of sending a search the
//   site would not filter (an unfiltered search returns all ~280,000 rows in
//   one ~280 MB page, so every search carries a date filter and a byte cap).
// - The results (SearchDocs.aspx) come ten to a page, and the site pages
//   only by form POST; ctx.http is GET only, and a GET always returns the
//   first page. So a search is read in parts that fit one page: sorted by
//   folder name ascending and descending (the first ten and the last ten),
//   then narrowed by folder-name prefix ("519*", the form's own wildcard)
//   over the names between the two, recursively. Every part is checked
//   against the filter it asked for, and the rows read are checked against
//   the page count the site reports.
// - Daily: the decisions posted on each day from two days before the last
//   successful run to today (Published Date filter).
// - Backfill: decision dates from today back to January 1, 2017, a day at a
//   time (Decision Date filter), newest first, 100 to 200 decisions a chunk
//   (a busy day is split with an offset). A decision took 3 to 10 seconds
//   to download when this was written, and its listing about a fifth of a
//   search, so a chunk takes about 10 to 35 minutes. The 2016 pilot project
//   is not collected: it is posted as eight monthly compilations of 2,000 to
//   2,750 pages (about 600 MB each) with no decision dates, not as
//   individual decisions.
// - Each decision is its PDF. Every PDF sampled (2017 to 2026 decisions)
//   is scanned page images with no text layer, and the library runs no OCR,
//   so most decisions are held as the listing's facts and the official link
//   (textKind "none"); a PDF with a text layer is stored with its text.
//
// The host has no robots.txt (404: everything allowed) and no Crawl-delay,
// so the default pace applies (one request in flight, about a second apart).
// A search takes the site 1 to 3 seconds. The files carry no ETag or
// Last-Modified, so a recheck downloads the file again: recheckAfterDays is
// long, since EOIR does not revise a released decision in place.
//
// US government work (EOIR FOIA release): public domain, stored in full.
// Unpublished BIA decisions are non-precedential.

const READING_ROOM_URL = "https://foia.eoir.justice.gov/app/ReadingRoom.aspx";
const HOSTS = ["foia.eoir.justice.gov"] as const;
/** The first day of the earliest release period of individual decisions (FY17 - Q2-Q4). */
const FIRST_DECISION_DAY = "2017-01-01";
/** Rows on one results page (fixed by the site). */
const PAGE_ROWS = 10;
/**
 * Cap on one results page. A results page carries view state in proportion
 * to how many rows the search matched (about 1 KB a row), so a filtered
 * search stays under a megabyte; the cap stops a search the site did not
 * filter long before its ~280 MB.
 */
const SEARCH_MAX_BYTES = 16 * 1024 * 1024;
/** The framework's default PDF cap (LIBRARY_MAX_PDF_MB); a decision listed larger is kept as its listing only. */
const MAX_PDF_BYTES = 60 * 1024 * 1024;
/** Searches one listing may send before it is treated as broken. */
const MAX_SEARCHES_PER_LISTING = 1_500;
/** Daily: the overlap before the last successful run, and how far back a first run or a long outage reaches. */
const DAILY_OVERLAP_DAYS = 2;
const FIRST_DAILY_DAYS = 3;
const MAX_DAILY_DAYS = 31;
/** Backfill: decisions a chunk aims for, the most it takes, and the most decision days it reads. */
const CHUNK_TARGET = 100;
const CHUNK_MAX = 200;
const CHUNK_MAX_DAYS = 62;

type Listing = {
  docId: string;
  palFlag: string;
  folderName: string;
  decisionDateText: string;
  baseCity: string;
  appealType: string;
  filedBy: string;
  pagesText: string;
  sizeText: string;
  publishedDateText: string;
  folderInfoUrl: string;
};

type Cursor = { day: string; offset?: number };

/** One search: a posting day or a decision day, narrowed by folder-name prefix. */
type Search = { published?: string; decided?: string; prefix: string };

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * 24 * 60 * 60 * 1000));
}

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return (
    Boolean(c) &&
    typeof c.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(c.day) &&
    isoOfStated(formDate(c.day)) === c.day &&
    (c.offset === undefined || (Number.isInteger(c.offset) && c.offset >= 0))
  );
}

function describe(search: Search): string {
  const parts = [search.published ? `posted ${search.published}` : null, search.decided ? `decided ${search.decided}` : null];
  if (search.prefix) parts.push(`folder ${search.prefix}*`);
  return parts.filter(Boolean).join(", ");
}

async function readForm(ctx: LibraryAdapterContext): Promise<ReadingRoomForm> {
  const { text, response } = await ctx.http.getText(READING_ROOM_URL, { expect: "html" });
  const { form, problems } = parseReadingRoomForm(text, response.url);
  if (!form) throw new LibraryLayoutError(READING_ROOM_URL, problems.join("; "));
  return form;
}

/**
 * The results URL for one search, with the parameters the reading room's
 * own search script sends (fnSearch: doctypes, filename, sdate, edate,
 * content, sortBy, sortOrder, custom, pageIndex), the dates as MM/DD/YYYY.
 */
function searchUrl(form: ReadingRoomForm, search: Search, order: "ASC" | "DESC"): string {
  if (!search.published && !search.decided) throw new Error("A reading room search needs a date filter.");
  const customFields = search.decided
    ? [form.decisionFrom, form.decisionTo].map((f) => ({ Name: f.name, Value: formDate(search.decided!), Type: f.type, CustomListId: f.customListId }))
    : [];
  const params = new URLSearchParams({
    doctypes: "",
    filename: `${search.prefix}*`,
    sdate: search.published ? formDate(search.published) : "",
    edate: search.published ? formDate(search.published) : "",
    content: "",
    sortBy: form.folderSortValue,
    sortOrder: order,
    custom: JSON.stringify({ customFields }),
    pageIndex: "0",
  });
  return `${form.searchUrl}?${params.toString()}`;
}

/** One results page for a search, checked against the filter it asked for. */
async function runSearch(ctx: LibraryAdapterContext, form: ReadingRoomForm, search: Search, order: "ASC" | "DESC"): Promise<ResultsPage> {
  const url = searchUrl(form, search, order);
  const { text, response } = await ctx.http.getText(url, { expect: "html", maxBytes: SEARCH_MAX_BYTES });
  const page = parseResultsPage(text, response.url);
  if (!page.recognized) throw new LibraryLayoutError(url, page.problem ?? "unreadable results");
  if (page.rows.length === 0 && page.unreadable.length > 0) throw new LibraryLayoutError(url, `none of the ${page.unreadable.length} result rows could be read`);
  for (const message of page.unreadable) ctx.note(`A row of the reading room's results (${describe(search)}) could not be read and was left out: ${message}`);
  for (const row of page.rows) {
    const wrong =
      (search.published && isoOfStated(row.publishedDateText) !== search.published && `posted ${row.publishedDateText}`) ||
      (search.decided && isoOfStated(statedDay(row.decisionDateText)) !== search.decided && `decided ${row.decisionDateText}`) ||
      (!row.folderName.toLowerCase().startsWith(search.prefix.toLowerCase()) && `folder ${row.folderName}`);
    if (wrong) throw new LibraryLayoutError(url, `the search for ${describe(search)} returned a decision ${wrong}: the filter was not applied`);
  }
  if (page.rows.length > PAGE_ROWS) throw new LibraryLayoutError(url, `${page.rows.length} rows on one page, not ${PAGE_ROWS}`);
  const names = page.rows.map((r) => r.folderName);
  if (names.every((n) => /^\d+$/.test(n))) {
    for (let i = 1; i < names.length; i++) {
      const outOfOrder = order === "ASC" ? names[i - 1] > names[i] : names[i - 1] < names[i];
      if (outOfOrder) throw new LibraryLayoutError(url, `the results are not sorted by folder name (${order})`);
    }
  }
  return page;
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/**
 * Every row a search matches, read with GET requests only (see the file
 * comment): the first ten and last ten by folder name, then the folder-name
 * prefixes between them that hold rows not yet seen, recursively.
 */
async function listAll(ctx: LibraryAdapterContext, form: ReadingRoomForm, base: { published?: string; decided?: string }): Promise<ResultRow[]> {
  const rows = new Map<string, ResultRow>();
  let searches = 0;

  const search = async (prefix: string, order: "ASC" | "DESC") => {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("aborted");
    if (++searches > MAX_SEARCHES_PER_LISTING) {
      throw new LibraryLayoutError(form.searchUrl, `reading ${describe({ ...base, prefix: "" })} took more than ${MAX_SEARCHES_PER_LISTING} searches`);
    }
    const page = await runSearch(ctx, form, { ...base, prefix }, order);
    for (const row of page.rows) rows.set(row.docId, row);
    return page;
  };

  const cover = async (prefix: string): Promise<ResultsPage> => {
    const asc = await search(prefix, "ASC");
    if (asc.empty || asc.totalPages <= 1) return asc;
    const desc = await search(prefix, "DESC");
    // Two pages or fewer: the first ten and the last ten are all of them.
    if (asc.totalPages <= 2) return asc;
    const lo = asc.rows[asc.rows.length - 1]?.folderName;
    const hi = desc.rows[desc.rows.length - 1]?.folderName;
    const min = asc.rows[0]?.folderName;
    const max = desc.rows[0]?.folderName;
    if (!lo || !hi || !min || !max) return asc;
    // Every row's name lies between the smallest and the largest, so they all share the prefix those two share.
    const shared = commonPrefix(min, max);
    if (lo >= hi || shared.length >= Math.max(min.length, max.length)) {
      ctx.note(`More than ${2 * PAGE_ROWS} decisions (${describe({ ...base, prefix })}) share folder name ${lo}; only ${2 * PAGE_ROWS} of them could be listed.`);
      return asc;
    }
    const alphabet = new Set("0123456789");
    for (const r of [...asc.rows, ...desc.rows]) if (r.folderName.length > shared.length) alphabet.add(r.folderName[shared.length]);
    for (const ch of [...alphabet].sort()) {
      const child = shared + ch;
      // Names below lo are all among the first ten, names above hi among the last ten.
      if (child < lo && !lo.startsWith(child)) continue;
      if (child > hi) continue;
      await cover(child);
    }
    return asc;
  };

  const root = await cover("");
  if (!root.empty) {
    const atLeast = PAGE_ROWS * (root.totalPages - 1) + 1;
    if (rows.size < atLeast) {
      const message = `The reading room lists at least ${atLeast} decisions ${describe({ ...base, prefix: "" })} (${root.totalPages} pages), but ${rows.size} could be read by folder name.`;
      if (rows.size < atLeast / 2) throw new LibraryLayoutError(form.searchUrl, message);
      ctx.note(`${message} The rest are left for a later run.`);
    }
  }
  return [...rows.values()];
}

function refFor(row: ResultRow): DocumentRef {
  const listing: Listing = {
    docId: row.docId,
    palFlag: row.palFlag,
    folderName: row.folderName,
    decisionDateText: row.decisionDateText,
    baseCity: row.baseCity,
    appealType: row.appealType,
    filedBy: row.filedBy,
    pagesText: row.pagesText,
    sizeText: row.sizeText,
    publishedDateText: row.publishedDateText,
    folderInfoUrl: row.folderInfoUrl,
  };
  return {
    // The reading room's own document id (its download and folder links use
    // it). Folder names are kept in metadata; whether one folder can hold
    // more than one decision is not stated, so they do not key documents.
    externalId: `PAL ${row.docId}`,
    url: row.downloadUrl,
    title: titleOf(listing),
    fingerprint: sha256Hex(
      [row.docId, row.folderName, row.decisionDateText, row.baseCity, row.appealType, row.filedBy, row.pagesText, row.sizeText, row.publishedDateText, row.downloadUrl].join("\u0000")
    ).slice(0, 32),
    listing,
  };
}

/**
 * The reading room gives a decision no caption (the parties' names are
 * redacted): its title is the folder name. The library's title is that name
 * after "Unpublished BIA decision", followed by the listing's own appeal
 * type, base city and decision date, and nothing else.
 */
function titleOf(listing: Listing): string {
  const decided = statedDay(listing.decisionDateText);
  const details = [listing.appealType, listing.baseCity, decided ? `decided ${decided}` : null].filter(Boolean);
  return `Unpublished BIA decision ${listing.folderName}${details.length ? ` (${details.join(", ")})` : ""}`;
}

function byNewestPosting(a: DocumentRef, b: DocumentRef): number {
  const x = Number((a.listing as Listing).docId);
  const y = Number((b.listing as Listing).docId);
  return y - x;
}

export const eoirFoiaUnpublishedBiaAdapter: LibrarySourceAdapter = {
  code: "eoir_bia_unpublished_foia",
  group: "bia-unpublished",
  name: "Unpublished BIA decisions (EOIR FOIA reading room)",
  description:
    "Redacted non-precedent decisions of the Board of Immigration Appeals that EOIR posts in the Reading Room of its FOIA Public Access Link, with the decision date, base city, appeal type and filing party the reading room lists, and each decision's PDF.",
  coverage:
    "Individual decisions dated January 1, 2017 or later that EOIR has posted (its release periods run from FY2017 to FY2025, with FY2026 in progress), plus anything new it posts. EOIR posts them as scanned images with no text layer, and the library runs no OCR, so most are held as the reading room's listing facts with the link to the PDF, not as searchable text. The 2016 pilot project's monthly compilations are not collected.",
  cadence: "Daily (EOIR posts new decisions daily)",
  officialUrl: READING_ROOM_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 365,
  maxDocumentsPerDailyRun: 800,

  async listUpdates(ctx, since) {
    const form = await readForm(ctx);
    const today = isoDay(ctx.now);
    let start = since ? addDays(isoDay(since), -DAILY_OVERLAP_DAYS) : addDays(today, -(FIRST_DAILY_DAYS - 1));
    const earliest = addDays(today, -MAX_DAILY_DAYS);
    if (start < earliest) {
      ctx.note(`The last successful run was before ${earliest}; decisions posted before then are not listed by this run (restarting the backfill picks them up).`);
      start = earliest;
    }
    const refs: DocumentRef[] = [];
    for (let day = today; day >= start; day = addDays(day, -1)) {
      const rows = await listAll(ctx, form, { published: day });
      refs.push(...rows.map(refFor).sort(byNewestPosting));
    }
    return { refs };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const today = isoDay(ctx.now);
    if (cursor !== null && cursor !== undefined && !isCursor(cursor)) ctx.note("The saved cursor is not one this collector writes; the walk starts again from today.");
    const state: Cursor = isCursor(cursor) ? cursor : { day: today };
    if (state.day < FIRST_DECISION_DAY) return { refs: [], nextCursor: null, progress: `every decision date back to ${FIRST_DECISION_DAY} is done` };
    const form = await readForm(ctx);
    let day = state.day > today ? today : state.day;
    let offset = state.day > today ? 0 : (state.offset ?? 0);
    const firstDay = day;
    const refs: DocumentRef[] = [];
    let daysRead = 0;
    while (day >= FIRST_DECISION_DAY && daysRead < CHUNK_MAX_DAYS && refs.length < CHUNK_TARGET) {
      const dayRefs = (await listAll(ctx, form, { decided: day })).map(refFor).sort(byNewestPosting);
      daysRead++;
      const remaining = dayRefs.slice(offset);
      const room = CHUNK_MAX - refs.length;
      if (remaining.length > room) {
        refs.push(...remaining.slice(0, room));
        return {
          refs,
          nextCursor: { day, offset: offset + room },
          progress: `decision dates ${firstDay} back to ${day}: ${refs.length} decisions (${day} continues after ${offset + room} of its ${dayRefs.length}); walking back to ${FIRST_DECISION_DAY}`,
        };
      }
      refs.push(...remaining);
      offset = 0;
      day = addDays(day, -1);
    }
    const lastRead = addDays(day, 1);
    return {
      refs,
      nextCursor: day >= FIRST_DECISION_DAY ? { day } : null,
      progress: `decision dates ${firstDay} back to ${lastRead}: ${refs.length} decisions in ${daysRead} day(s); ${day >= FIRST_DECISION_DAY ? `next ${day}, walking back to ${FIRST_DECISION_DAY}` : "the walk is complete"}`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.docId || !listing.folderName) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const decided = statedDay(listing.decisionDateText);
    const statedDates: Record<string, string> = {};
    if (listing.decisionDateText) statedDates.decided = listing.decisionDateText;
    if (listing.publishedDateText) statedDates.postedToReadingRoom = listing.publishedDateText;
    const listedPages = /^\d+$/.test(listing.pagesText) ? Number(listing.pagesText) : null;
    const listedSize = /^\d+$/.test(listing.sizeText) ? Number(listing.sizeText) : null;
    const facts = {
      readingRoomDocumentId: Number(listing.docId),
      folderName: listing.folderName,
      listedName: listing.folderName,
      ...(listing.baseCity ? { baseCity: listing.baseCity } : {}),
      ...(listing.appealType ? { appealType: listing.appealType } : {}),
      ...(listing.filedBy ? { filedBy: listing.filedBy } : {}),
      ...(listedPages !== null ? { listedPages } : {}),
      ...(listedSize !== null ? { listedSizeBytes: listedSize } : {}),
      statedDates,
      folderInformationUrl: listing.folderInfoUrl,
      readingRoom: READING_ROOM_URL,
    };
    const base = {
      externalId: ref.externalId,
      docType: "decision" as const,
      title: titleOf(listing),
      citations: [],
      court: "Board of Immigration Appeals",
      agency: null,
      decisionDate: parseStatedDate(decided),
      // The reading room's "Published Date": the day EOIR posted the decision there.
      publishedDate: isoOfStated(listing.publishedDateText),
      precedentialStatus: "non_precedential" as const,
      officialUrl: ref.url,
    };

    if (listedSize !== null && listedSize > MAX_PDF_BYTES) {
      // Kept as its listing: the file is over the library's PDF cap.
      return {
        kind: "document",
        document: {
          ...base,
          text: "",
          textKind: "none",
          metadata: { ...facts, textNote: `The PDF is listed at ${listedSize} bytes, over the library's ${MAX_PDF_BYTES}-byte PDF limit; it was not downloaded.` },
        },
      };
    }

    const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const scanNote = "EOIR posted this decision as scanned page images with no text layer; no OCR is run, so only the listing's facts and the link are held.";
    const document = {
      ...base,
      originalUrl: response.url !== ref.url ? response.url : null,
      original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
    };
    if (!mayHaveText(response.body)) {
      return {
        kind: "document",
        document: { ...document, text: "", textKind: "none", metadata: { ...facts, textNote: scanNote }, fetch: { response, extraction: { method: "no-font-resources" } } },
      };
    }
    const pdf = await extractPdfText(response.body);
    if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    const hasText = pdf.pagesWithText > 0;
    return {
      kind: "document",
      document: {
        ...document,
        text: hasText ? pdf.text : "",
        textKind: hasText ? "full" : "none",
        metadata: { ...facts, pageCount: pdf.pageCount, ...(hasText ? {} : { textNote: scanNote }) },
        fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
      },
    };
  },
};

/**
 * False when the PDF cannot carry a text layer: text is drawn only with a
 * font named in a /Font resource, and a file with no "/Font" anywhere and no
 * compressed object streams (/ObjStm, where a resource dictionary could be
 * hidden) has none. EOIR's scans are such files (one image per page), and
 * this check saves running pdf.js (about 3 seconds a decision, on a worker
 * shared with every other source) on each of them.
 */
function mayHaveText(bytes: Buffer): boolean {
  return bytes.includes("/Font", 0, "latin1") || bytes.includes("/ObjStm", 0, "latin1");
}
