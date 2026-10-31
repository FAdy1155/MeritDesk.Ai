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
import { fileIdDate, parseNpdHeader, parseNpdListing, textLayerNote, type NpdForm, type NpdListing, type NpdRow } from "./parse";

// AAO non-precedent decisions, from USCIS's repository on uscis.gov: about
// 170,000 decisions from 2005 on, each a PDF (a scan with a text layer)
// filed under its decision folder and year, e.g.
// /sites/default/files/err/B2 - Aliens with Extraordinary Ability/Decisions_Issued_in_2026/AUG242026_05B2203.pdf.
// The only index is the page's Drupal view: rows of "<subject> - <file ID>",
// the decision's date, and its form and statute, 10 to 100 to a page, with
// filters for Decision Category (82 topics), Month and Year. There is no
// API, feed or sitemap for the files (the page's text search hands off to
// search.usa.gov).
//
// The view sorts by posting batch, newest first, and leaves the order
// within a batch to the database: two pages of the same query repeat some
// rows and skip others. Seen live: August 2026 (164 rows) gave 151 distinct
// decisions over its two pages, and March 2005 bond breaches (257 rows) gave
// 158 over three pages of 100 and 184 with pages of 25 and 10 added. A query
// that fits on one page of 100 rows is complete, so the history is walked in
// partitions small enough for that: a year, then each topic within it, then
// each month within a topic. A partition still over 100 rows at the month
// level (bond breaches in the mid-2000s, T visa applications in January
// and March 2026: 151 rows gave 139) is read page by page, with pages of
// 100 and then of 25, and a note says how many of its rows could be listed;
// what one chunk cannot take of it waits in the cursor as refs, so its pages
// are read once. When the topics (or months) of a partition add up to fewer
// rows than the partition itself, the rest are in no topic, and the
// partition is scanned through its pages of 100, one page per step (it can
// hold thousands of rows). The queries are those the page's own filter form
// submits: its action, its select names and its option values as read from
// the page. The cursor keeps the labels (year, topic) rather than the option
// values, which are positions in the lists and can shift when a year is added.
//
// - Daily: the 200 most recently posted rows (USCIS posted about 50
//   decisions a week in 2026, and the newest batches sit whole on the first
//   page while they add up to 100 rows or fewer), and once a week (Sundays,
//   UTC, or when the last successful run is more than a week old) every row
//   of the current year (and, from January to March, the previous year) by
//   partition, which catches a batch too large for the first page.
// - Backfill: every year the Year filter offers, newest first, by partition;
//   about three weeks of fetching in all, scheduled after the other uscis.gov
//   sources (backfillPriority).
// - uscis.gov's robots.txt asks for 10 seconds between requests: a chunk
//   reads about LIST_REQUESTS listing pages and returns at most about
//   MAX_REFS decisions (some 25 minutes of fetching).
//
// US government work: public domain, stored in full. Non-precedent
// decisions bind only the parties (the page and the AAO Practice Manual 3.15
// say so): stored as non_precedential.

const LISTING_URL = "https://www.uscis.gov/administrative-appeals/aao-decisions/aao-non-precedent-decisions";
const HOSTS = ["www.uscis.gov"] as const;
/** The largest "Rows per page" the view offers. */
const PAGE_SIZE = 100;
/** The second pass over a partition read page by page: smaller pages reach rows the pages of 100 skip. */
const SMALL_PAGE_SIZE = 25;
/** Pages of SMALL_PAGE_SIZE read for one partition at most (beyond that, only the pages of 100). */
const MAX_SMALL_PAGES = 40;
/** Pages of 100 read for one partition at most. */
const MAX_PAGES = 50;
/** Pages of 100 a year or topic scanned page by page may take (20,000 rows). */
const MAX_SCAN_PAGES = 200;
/** Listing pages one backfill chunk reads (10 seconds each), before a partition read page by page. */
const LIST_REQUESTS = 30;
/** Decisions one backfill chunk returns (about 10 seconds each). */
const MAX_REFS = 130;
/** Listing pages the weekly sweep of the current year may read. */
const SWEEP_REQUESTS = 320;
const MONTHS_NEWEST_FIRST = ["12", "11", "10", "9", "8", "7", "6", "5", "4", "3", "2", "1"];

/** A partition of the view: year and topic by their labels, month by its value (1 to 12). */
type Filters = { year?: string; category?: string; month?: string };

type Task =
  /** The first page of a partition; `check` names the sum its total counts toward. */
  | { k: "list"; f: Filters; check?: number }
  /** A partition over one page that no filter splits further: read page by page. */
  | { k: "pages"; f: Filters; total: number }
  /** What such a partition listed beyond one chunk's share, returned by the next chunk without reading its pages again. */
  | { k: "rest"; f: Filters; refs: DocumentRef[] }
  /**
   * A year or topic whose topics or months list fewer decisions than it does:
   * its pages of 100 read one at a time from `page` on (it can run to
   * thousands of rows, too many to hold in the cursor; the rows its parts
   * already listed come back again and are skipped by their fingerprints).
   */
  | { k: "scan"; f: Filters; total: number; page: number }
  /** After a split's children: do their totals add up to the parent's? */
  | { k: "check"; id: number; f: Filters; expected: number; got: number };

type WalkState = { v: 1; tasks: Task[]; nextId: number };

type Listing = Omit<NpdRow, "pdfUrl">;

function isTask(value: unknown): value is Task {
  const t = value as Task;
  if (!t || typeof t !== "object" || !t.f || typeof t.f !== "object") return false;
  const strings = [t.f.year, t.f.category, t.f.month].every((v) => v === undefined || typeof v === "string");
  if (t.k === "list") return strings && (t.check === undefined || Number.isInteger(t.check));
  if (t.k === "pages") return strings && Number.isInteger(t.total);
  if (t.k === "scan") return strings && Number.isInteger(t.total) && Number.isInteger(t.page);
  if (t.k === "rest") return strings && Array.isArray(t.refs) && t.refs.every((r) => Boolean(r) && typeof r.externalId === "string" && typeof r.url === "string");
  if (t.k === "check") return strings && Number.isInteger(t.id) && Number.isInteger(t.expected) && Number.isInteger(t.got);
  return false;
}

function isWalkState(value: unknown): value is WalkState {
  const c = value as WalkState;
  return Boolean(c) && c.v === 1 && Array.isArray(c.tasks) && c.tasks.every(isTask) && Number.isInteger(c.nextId);
}

function label(f: Filters): string {
  const parts = [f.year ?? "all years", f.category ? `topic "${f.category}"` : null, f.month ? `month ${f.month}` : null].filter(Boolean);
  return parts.join(", ");
}

/** The GET query the page's filter form submits for a partition; what is missing when the form no longer offers it. */
function queryUrl(form: NpdForm, f: Filters, page: number, size = PAGE_SIZE): { url: string } | { missing: string } {
  const params = new URLSearchParams();
  if (f.category) {
    const o = form.categories.find((c) => c.label === f.category);
    if (!o) return { missing: `the topic "${f.category}"` };
    params.set("uri_1", o.value);
  }
  if (f.month) {
    const o = form.months.find((m) => m.value === f.month);
    if (!o) return { missing: `month ${f.month}` };
    params.set("m", o.value);
  }
  if (f.year) {
    const o = form.years.find((y) => y.label === f.year);
    if (!o) return { missing: `the year ${f.year}` };
    params.set("y", o.value);
  }
  params.set("items_per_page", String(size));
  if (page > 0) params.set("page", String(page));
  return { url: `${form.action}?${params.toString()}` };
}

function refFor(row: NpdRow): DocumentRef {
  const { pdfUrl, ...listing } = row;
  return {
    // The file ID is the AAO's own name for the decision; older years write the month in mixed case.
    externalId: row.fileId.toUpperCase(),
    url: pdfUrl,
    title: row.caption,
    fingerprint: sha256Hex([row.caption, row.dateText ?? "", row.formAndAuthority ?? "", row.sizeText ?? "", pdfUrl].join("\u0000")).slice(0, 32),
    listing: listing satisfies Listing,
  };
}

/** One listing page, checked: the view, its form and a row counter (or its empty result) must be there. */
async function readPage(ctx: LibraryAdapterContext, url: string): Promise<NpdListing & { form: NpdForm; total: number }> {
  const { text, response } = await ctx.http.getText(url, { expect: "html" });
  const parsed = parseNpdListing(text, response.url);
  if (!parsed.recognized) throw new LibraryLayoutError(url, "no aao_npd_recent view");
  if (!parsed.form) throw new LibraryLayoutError(url, "the view's filter form (Decision Category, Month, Year) is missing");
  if (!parsed.form.pageSizes.includes(String(PAGE_SIZE))) throw new LibraryLayoutError(url, `"Rows per page" no longer offers ${PAGE_SIZE}`);
  if (parsed.total === null) throw new LibraryLayoutError(url, "no row counter and no empty result");
  if (parsed.total > 0 && parsed.rows.length === 0 && parsed.range) {
    throw new LibraryLayoutError(url, `the counter says ${parsed.total} rows but no row could be read${parsed.notes[0] ? ` (${parsed.notes[0]})` : ""}`);
  }
  if (parsed.range && parsed.rows.length < parsed.range[1] - parsed.range[0] + 1) {
    ctx.note(`${url}: ${parsed.range[1] - parsed.range[0] + 1 - parsed.rows.length} of the rows printed could not be read (${parsed.notes[0] ?? "no detail"}).`);
  }
  for (const note of parsed.notes) ctx.note(note);
  return parsed as NpdListing & { form: NpdForm; total: number };
}

function addRows(refs: Map<string, DocumentRef>, rows: NpdRow[]): void {
  for (const row of rows) {
    const ref = refFor(row);
    if (!refs.has(ref.externalId)) refs.set(ref.externalId, ref);
  }
}

/** Every distinct decision the pages of one partition list: pages of 100, then pages of 25. */
async function readAllPages(ctx: LibraryAdapterContext, form: NpdForm, f: Filters, total: number): Promise<{ refs: DocumentRef[]; requests: number }> {
  const found = new Map<string, DocumentRef>();
  let requests = 0;
  for (const size of [PAGE_SIZE, SMALL_PAGE_SIZE]) {
    const pages = Math.ceil(total / size);
    if (size !== PAGE_SIZE && (pages > MAX_SMALL_PAGES || !form.pageSizes.includes(String(size)))) continue;
    for (let page = 0; page < Math.min(pages, MAX_PAGES); page++) {
      if (ctx.signal.aborted) break;
      const query = queryUrl(form, f, page, size);
      if ("missing" in query) return { refs: [], requests };
      const listing = await readPage(ctx, query.url);
      requests++;
      addRows(found, listing.rows);
      if (listing.rows.length === 0 || found.size >= total) break;
    }
    if (found.size >= total) break;
  }
  // A stable order, so a later chunk's offset continues where this one stopped.
  return { refs: [...found.values()].sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0)), requests };
}

/**
 * Works through the partition tasks until they are done or a limit is
 * reached: a partition that fits on one page is read whole; a larger one is
 * split by topic, then by month, then read page by page.
 */
async function walk(
  ctx: LibraryAdapterContext,
  form: NpdForm,
  state: WalkState,
  limits: { requests: number; refs: number },
  refs: Map<string, DocumentRef>
): Promise<{ requests: number }> {
  let requests = 0;
  while (state.tasks.length > 0) {
    if (ctx.signal.aborted) break;
    const task = state.tasks[0];
    if (task.k === "check") {
      state.tasks.shift();
      if (task.got < task.expected) {
        ctx.note(`${label(task.f)}: its ${task.f.category ? "months" : "topics"} list ${task.got} of its ${task.expected} decisions; the partition is read page by page for the rest.`);
        state.tasks.unshift({ k: "scan", f: task.f, total: task.expected, page: 0 });
      }
      continue;
    }
    if (requests >= limits.requests || refs.size > limits.refs - PAGE_SIZE) break;
    state.tasks.shift();

    if (task.k === "scan") {
      const query = queryUrl(form, task.f, task.page);
      if ("missing" in query) {
        ctx.note(`${label(task.f)}: the page's filters no longer offer ${query.missing}; that partition was skipped.`);
        continue;
      }
      const listing = await readPage(ctx, query.url);
      requests++;
      addRows(refs, listing.rows);
      const pages = Math.min(Math.ceil(listing.total / PAGE_SIZE), MAX_SCAN_PAGES);
      if (listing.rows.length > 0 && task.page + 1 < pages) state.tasks.unshift({ ...task, page: task.page + 1 });
      continue;
    }

    if (task.k === "pages" || task.k === "rest") {
      let found = task.k === "rest" ? task.refs : [];
      if (task.k === "pages") {
        const all = await readAllPages(ctx, form, task.f, task.total);
        requests += all.requests;
        found = all.refs;
        if (all.refs.length < task.total) {
          ctx.note(
            `${label(task.f)}: the counter reports ${task.total} rows and ${all.refs.length} distinct decisions could be listed through its pages; rows that share a posting batch come back in a different order on each page, so the others cannot be reached through this listing.`
          );
        }
      }
      // The chunk takes what fits; the rest waits in the cursor, so the pages (whose order shifts) are read once.
      const room = Math.max(limits.refs - refs.size, PAGE_SIZE);
      for (const ref of found.slice(0, room)) if (!refs.has(ref.externalId)) refs.set(ref.externalId, ref);
      if (found.length > room) state.tasks.unshift({ k: "rest", f: task.f, refs: found.slice(room) });
      continue;
    }

    const query = queryUrl(form, task.f, 0);
    if ("missing" in query) {
      ctx.note(`${label(task.f)}: the page's filters no longer offer ${query.missing}; that partition was skipped.`);
      continue;
    }
    const listing = await readPage(ctx, query.url);
    requests++;
    if (task.check !== undefined) {
      const check = state.tasks.find((t): t is Extract<Task, { k: "check" }> => t.k === "check" && t.id === task.check);
      if (check) check.got += listing.total;
    }
    if (listing.total <= PAGE_SIZE) {
      addRows(refs, listing.rows);
      continue;
    }
    const id = state.nextId++;
    if (!task.f.category) {
      state.tasks.unshift(
        ...form.categories.map((c): Task => ({ k: "list", f: { ...task.f, category: c.label }, check: id })),
        { k: "check", id, f: task.f, expected: listing.total, got: 0 }
      );
    } else if (!task.f.month) {
      state.tasks.unshift(
        ...MONTHS_NEWEST_FIRST.map((m): Task => ({ k: "list", f: { ...task.f, month: m }, check: id })),
        { k: "check", id, f: task.f, expected: listing.total, got: 0 }
      );
    } else {
      state.tasks.unshift({ k: "pages", f: task.f, total: listing.total });
    }
  }
  return { requests };
}

function describeState(state: WalkState): string {
  const next = state.tasks.find((t) => t.k !== "check");
  const open = state.tasks.filter((t) => t.k !== "check").length;
  return next ? `next: ${label(next.f)}${next.k === "rest" ? `, ${next.refs.length} decision(s) listed and not yet returned` : next.k === "scan" ? `, page ${next.page + 1}` : ""}; ${open} partition(s) queued` : "nothing queued";
}

export const uscisAaoNonPrecedentAdapter: LibrarySourceAdapter = {
  code: "uscis_aao_non_precedent_decisions",
  group: "aao-decisions",
  name: "AAO non-precedent decisions (USCIS)",
  description:
    "Non-precedent decisions of the USCIS Administrative Appeals Office on appeals, motions and certifications, by form type, read from USCIS's decision repository and each decision's PDF.",
  coverage:
    "The decisions USCIS's repository lists, 2005 to the present (about 170,000), as USCIS posts them, typically within a month of the decision; decisions issued before 2005 are available from USCIS only through FOIA. Where the repository lists more than 100 decisions for one topic in one month (bond breaches in the mid-2000s; T visa applications in some months of 2026), its pages cannot reach all of them, and the run notes say how many were listed; decisions posted after this collector starts are taken from the newest postings each day.",
  cadence: "Daily",
  officialUrl: LISTING_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  // Decisions are not revised once posted; a changed listing row (caption, date, file) is fetched again by its fingerprint.
  recheckAfterDays: 365,
  // About 10 seconds a decision: 50 minutes of fetching, beside the sweep's listing pages, inside a daily run's 100 minutes.
  maxDocumentsPerDailyRun: 300,
  // The whole history takes about three weeks at uscis.gov's pace and holds that host's backfill slot while it
  // runs, so it goes after the other uscis.gov groups (USCIS guidance, forms, TPS, other agency guidance: places
  // 17 to 20 in groups.ts's backfill order). The daily run and its weekly sweep cover the current year meanwhile.
  backfillPriority: 20.5,

  async listUpdates(ctx, since) {
    const refs = new Map<string, DocumentRef>();
    // The default order is by posting batch, newest first: the first 200 rows hold the latest batches.
    const first = await readPage(ctx, `${LISTING_URL}?items_per_page=${PAGE_SIZE}`);
    if (first.total === 0) throw new LibraryLayoutError(LISTING_URL, "the repository lists no decisions at all");
    addRows(refs, first.rows);
    const second = await readPage(ctx, `${LISTING_URL}?items_per_page=${PAGE_SIZE}&page=1`);
    addRows(refs, second.rows);

    const weekAgo = ctx.now.getTime() - 7 * 24 * 60 * 60 * 1000;
    if (!since || since.getTime() < weekAgo || ctx.now.getUTCDay() === 0) {
      const thisYear = String(ctx.now.getUTCFullYear());
      const lastYear = String(ctx.now.getUTCFullYear() - 1);
      const years = first.form.years.map((y) => y.label);
      const sweep = [thisYear, ...(ctx.now.getUTCMonth() <= 2 ? [lastYear] : [])].filter((y) => years.includes(y));
      if (sweep.length === 0 && years[0]) sweep.push(years[0]);
      const state: WalkState = { v: 1, tasks: sweep.map((year): Task => ({ k: "list", f: { year } })), nextId: 1 };
      await walk(ctx, first.form, state, { requests: SWEEP_REQUESTS, refs: Number.MAX_SAFE_INTEGER }, refs);
      if (state.tasks.some((t) => t.k !== "check")) {
        ctx.note(`The weekly sweep of ${sweep.join(" and ")} stopped after ${SWEEP_REQUESTS} listing pages (${describeState(state)}); the backfill covers the rest.`);
      }
    }
    return { refs: [...refs.values()] };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    // The form first: the cursor names years and topics, the queries need the form's current values for them.
    const form = (await readPage(ctx, LISTING_URL)).form;
    let state: WalkState;
    if (isWalkState(cursor)) state = cursor;
    else {
      if (cursor !== null && cursor !== undefined) ctx.note("The saved backfill cursor was not one this collector writes; the walk starts again from the newest year.");
      state = { v: 1, tasks: form.years.map((y): Task => ({ k: "list", f: { year: y.label } })), nextId: 1 };
    }
    const refs = new Map<string, DocumentRef>();
    const { requests } = await walk(ctx, form, state, { requests: LIST_REQUESTS, refs: MAX_REFS }, refs);
    const done = !state.tasks.some((t) => t.k !== "check");
    return {
      refs: [...refs.values()],
      nextCursor: done ? null : state,
      progress: `${requests} listing page(s), ${refs.size} decision(s); ${done ? "every year the filter offers is done" : describeState(state)}`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.fileId) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const pdf = await extractPdfText(response.body);
    const header = parseNpdHeader(pdf.text);
    // The listed date is the decision's (the decision's own date line and its
    // file ID carry the same date); a disagreement is noted, the listing kept.
    const decisionDate = parseStatedDate(listing.dateText);
    const idDate = fileIdDate(listing.fileId);
    if (decisionDate && idDate && decisionDate !== idDate) {
      ctx.note(`${ref.externalId}: the listed date (${listing.dateText}) differs from the date in the file ID; the listed date is kept.`);
    }
    if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    const hasText = pdf.pagesWithText > 0;
    const textNote = textLayerNote(pdf.pageCount, pdf.pagesWithText);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "decision",
        title: listing.caption,
        // The file ID, and the caption decisions of about 2015 to 2019 print first ("MATTER OF E-B-M-K-"), the name the AAO cites them by.
        citations: [listing.fileId, ...(header.matterOf ? [`MATTER OF ${header.matterOf}`] : [])],
        court: "Administrative Appeals Office",
        agency: "U.S. Citizenship and Immigration Services",
        decisionDate,
        precedentialStatus: "non_precedential",
        officialUrl: ref.url,
        originalUrl: response.url !== ref.url ? response.url : null,
        text: hasText ? pdf.text : "",
        textKind: hasText ? "full" : "none",
        metadata: {
          fileId: listing.fileId,
          subject: listing.subject,
          ...(listing.formNumber ? { formNumber: listing.formNumber } : {}),
          ...(listing.authorities.length ? { authorities: listing.authorities } : {}),
          ...(listing.formAndAuthority ? { listedFormAndAuthority: listing.formAndAuthority } : {}),
          ...(listing.folder ? { decisionFolder: listing.folder } : {}),
          ...(listing.yearFolder ? { yearFolder: listing.yearFolder } : {}),
          ...(listing.sizeText ? { listedFileSize: listing.sizeText } : {}),
          ...(header.inReNumber ? { inReNumber: header.inReNumber } : {}),
          ...(header.idNumber ? { idNumber: header.idNumber } : {}),
          ...(header.matterOf ? { captionInDecision: `MATTER OF ${header.matterOf}` } : {}),
          ...(header.office ? { office: header.office } : {}),
          statedDates: {
            ...(listing.dateText ? { listed: listing.dateText } : {}),
            ...(header.dateLine ? { decisionDateLine: header.dateLine } : {}),
          },
          pageCount: pdf.pageCount,
          ...(textNote ? { textNote } : {}),
        },
        original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
        fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
      },
    };
  },
};
