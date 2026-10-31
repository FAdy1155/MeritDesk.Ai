import { cleanText } from "../../text";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fetchPdf, fingerprintOf, isMissing, isoDatePart } from "./common";
import { immigrationTerms, isImmigrationMatch } from "./parse";

// Congressional Research Service reports on immigration, from the
// Congress.gov API's CRS reports endpoints (https://api.congress.gov/v3/crsreport,
// documented at https://github.com/LibraryOfCongress/api.congress.gov):
//
// - The list endpoint gives every CRS product (Reports, In Focus, Insights,
//   Legal Sidebars) with its ID, title, version and dates, newest update
//   first, filtered by update time (fromDateTime/toDateTime).
// - A product is kept when its title uses an immigration term, or else when
//   its record names one of CRS's immigration topics (the item endpoint
//   carries the topics, so the listing reads it for the products whose title
//   does not decide). Archived products carry no topics: only their titles
//   decide.
// - Daily: products updated since the last run (a day of overlap).
// - Backfill: the whole list as it stood when the walk began (toDateTime is
//   fixed in the cursor, so products updated during the walk drop out of it
//   and are picked up by the daily run), newest update first, one page per
//   chunk.
// - The document is the item endpoint's record (title, authors, dates,
//   status, version, topics, related laws and bills, the links to the PDF and
//   HTML on congress.gov, CRS's summary in metadata.summary) and the full
//   report, read from the PDF the record links
//   (https://www.congress.gov/crs_external_products/<type>/PDF/<id>/<id>.<version>.pdf).
//   www.congress.gov serves those files to the collector (robots.txt allows
//   them and asks for 2 seconds between requests), while its HTML pages,
//   including the report's own page and the HTML rendition, answer with a
//   Cloudflare challenge (HTTP 403). When the PDF is refused or is not a PDF,
//   CRS's summary is the text kept (textKind "excerpt") and the run notes
//   it. The official link is the report's congress.gov page as the record
//   states it.
// - The API key goes in the X-Api-Key header (api.data.gov), never in the URL.
//
// CRS reports are US government works: public domain.

const API = "https://api.congress.gov/v3/crsreport";
const HOSTS = ["api.congress.gov", "www.congress.gov", "crsreports.congress.gov"] as const;
const PAGE_SIZE = 250;
/** The API can be slow (tens of seconds) under load. */
const API_TIMEOUT_MS = 150_000;
const DAILY_MAX_ITEMS = 2_000;
/** The answers that mean congress.gov will not give the collector the report file (a Cloudflare challenge, a moved file): keep the summary. */
const REFUSED_FILE = /^(?:http_40[34]|http_410|unexpected_content_type|not_pdf|too_large)$/;

/** CRS's own topic names for immigration (as the item endpoint states them). */
const IMMIGRATION_TOPICS = /immigra|border security|unauthorized foreign nationals|asylees|refugees|citizenship|naturali[sz]ation|visa/i;

type ListItem = { id: string; title: string; contentType?: string; publishDate?: string; updateDate?: string; status?: string; version?: number; url?: string };
type ListPage = { CRSReports?: ListItem[]; pagination?: { count?: number; next?: string } };
type ItemRecord = {
  id: string;
  title: string;
  contentType?: string;
  currentVersion?: number;
  publishDate?: string;
  updateDate?: string;
  status?: string;
  url?: string;
  summary?: string;
  authors?: { author?: string }[];
  topics?: { topic?: string }[];
  formats?: { format?: string; url?: string }[];
  relatedMaterials?: { number?: string | number; title?: string | null; type?: string; congress?: number; URL?: string }[];
};

type Cursor = { to: string; offset: number; pageSize?: number };
type Listing = { matchedBy: "title" | "topics"; matchedTerms: string[]; listedVersion: number | null };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && typeof c.to === "string" && !Number.isNaN(Date.parse(c.to)) && Number.isInteger(c.offset) && c.offset >= 0 && (c.pageSize === undefined || (Number.isInteger(c.pageSize) && c.pageSize > 0 && c.pageSize <= PAGE_SIZE));
}

function apiHeaders(ctx: LibraryAdapterContext): Record<string, string> {
  const key = ctx.env("CONGRESS_GOV_API_KEY");
  if (!key) throw new Error("CONGRESS_GOV_API_KEY is not set.");
  return { "X-Api-Key": key, Accept: "application/json" };
}

function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function listUrl(from: Date, to: Date, offset: number, limit: number): string {
  const u = new URL(API);
  u.searchParams.set("format", "json");
  u.searchParams.set("fromDateTime", isoSeconds(from));
  u.searchParams.set("toDateTime", isoSeconds(to));
  u.searchParams.set("offset", String(offset));
  u.searchParams.set("limit", String(limit));
  return u.toString();
}

async function readList(ctx: LibraryAdapterContext, url: string): Promise<{ items: ListItem[]; count: number | null; next: string | null }> {
  const { data } = await ctx.http.getJson<ListPage>(url, { headers: apiHeaders(ctx), timeoutMs: API_TIMEOUT_MS });
  if (!data || !Array.isArray(data.CRSReports)) throw new LibraryLayoutError(url, "no CRSReports array in the response");
  const items = data.CRSReports.filter((r): r is ListItem => Boolean(r && typeof r.id === "string" && typeof r.title === "string"));
  const next = typeof data.pagination?.next === "string" && data.pagination.next.startsWith(`${API}?`) ? data.pagination.next : null;
  return { items, count: typeof data.pagination?.count === "number" ? data.pagination.count : null, next };
}

/** The item endpoint's URL for an ID the list gave (the list's own `url` field when it is the API's). */
function itemUrl(item: { id: string; url?: string }): string {
  if (item.url && item.url.startsWith(`${API}/`)) return item.url;
  return `${API}/${encodeURIComponent(item.id)}`;
}

async function readItem(ctx: LibraryAdapterContext, url: string) {
  const { data, response } = await ctx.http.getJson<{ CRSReport?: ItemRecord }>(withFormat(url), { headers: apiHeaders(ctx), timeoutMs: API_TIMEOUT_MS });
  const record = data?.CRSReport;
  if (!record || typeof record.id !== "string" || typeof record.title !== "string") throw new LibraryLayoutError(url, "no CRSReport record in the response");
  return { record, response };
}

function withFormat(url: string): string {
  const u = new URL(url);
  u.searchParams.set("format", "json");
  return u.toString();
}

/** The refs among a page of list items: by title, or by the item record's topics when the title does not decide. */
async function selectItems(ctx: LibraryAdapterContext, items: ListItem[]): Promise<{ refs: DocumentRef[]; checked: number }> {
  const refs: DocumentRef[] = [];
  let checked = 0;
  for (const item of items) {
    if (ctx.signal.aborted) break;
    const url = itemUrl(item);
    let listing: Listing | null = null;
    const titleTerms = immigrationTerms(item.title);
    if (isImmigrationMatch(titleTerms)) listing = { matchedBy: "title", matchedTerms: titleTerms, listedVersion: item.version ?? null };
    else if (item.status !== "Archived") {
      checked++;
      try {
        const { record } = await readItem(ctx, url);
        const topics = (record.topics ?? []).map((t) => t.topic ?? "").filter((t) => IMMIGRATION_TOPICS.test(t));
        if (topics.length) listing = { matchedBy: "topics", matchedTerms: topics, listedVersion: item.version ?? null };
      } catch (err) {
        if (!isMissing(err)) throw err;
        ctx.note(`${item.id}: the API has no record for it any more; left out.`);
      }
    }
    if (!listing) continue;
    refs.push({
      externalId: item.id,
      url,
      title: `${item.id} ${item.title}`,
      fingerprint: fingerprintOf(item.id, item.title, item.version, item.publishDate, item.status),
      listing,
    });
  }
  return { refs, checked };
}

export const crsReportsAdapter: LibrarySourceAdapter = {
  code: "crs_immigration_reports",
  group: "oversight-reports",
  name: "Congressional Research Service reports on immigration (Congress.gov API)",
  description:
    "CRS Reports, In Focus, Insights and Legal Sidebars on immigration, from the Congress.gov API: each product's record, authors, topics, related laws and bills, CRS's summary, and the full report from the PDF the record links on congress.gov.",
  coverage:
    "Every CRS product in the Congress.gov API whose title concerns immigration or whose CRS topics are immigration topics (Archived products by title only); the record, CRS's summary and the full report PDF's text are kept (the summary alone when congress.gov refuses the file).",
  cadence: "Daily",
  officialUrl: "https://crsreports.congress.gov/",
  hosts: HOSTS,
  license: "public_domain",
  requiredEnv: ["CONGRESS_GOV_API_KEY"],
  staleAfterHours: 48,
  recheckAfterDays: 60,

  async listUpdates(ctx, since) {
    const to = ctx.now;
    const from = since ? new Date(since.getTime() - 24 * 3600 * 1000) : new Date(to.getTime() - 3 * 24 * 3600 * 1000);
    const refs: DocumentRef[] = [];
    let url: string | null = listUrl(from, to, 0, PAGE_SIZE);
    let seen = 0;
    let checked = 0;
    while (url && seen < DAILY_MAX_ITEMS && !ctx.signal.aborted) {
      const page = await readList(ctx, url);
      seen += page.items.length;
      const selected = await selectItems(ctx, page.items);
      refs.push(...selected.refs);
      checked += selected.checked;
      url = page.items.length ? page.next : null;
    }
    if (url) ctx.note(`More than ${DAILY_MAX_ITEMS} products were updated since the last run; the rest are reached by the next run.`);
    ctx.note(`${seen} CRS product(s) updated since ${isoSeconds(from)}; ${checked} record(s) read for their topics; ${refs.length} on immigration.`);
    return { refs };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const state: Cursor = isCursor(cursor) ? cursor : { to: isoSeconds(ctx.now), offset: 0 };
    const pageSize = state.pageSize ?? PAGE_SIZE;
    const page = await readList(ctx, listUrl(new Date("1900-01-01T00:00:00Z"), new Date(state.to), state.offset, pageSize));
    const selected = await selectItems(ctx, page.items);
    const nextOffset = state.offset + page.items.length;
    const done = page.items.length === 0 || (page.count !== null && nextOffset >= page.count);
    return {
      refs: selected.refs,
      nextCursor: done ? null : { ...state, offset: nextOffset },
      progress: `products ${state.offset + 1} to ${nextOffset}${page.count !== null ? ` of ${page.count}` : ""} updated by ${state.to}; ${selected.checked} record(s) read for topics; ${selected.refs.length} on immigration`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const { record, response } = await readItem(ctx, ref.url);
    const summary = record.summary ? cleanText(record.summary) : "";
    // The record's `url` is the report's congress.gov page, written without a scheme ("www.congress.gov/crs-report/R45020").
    const pageUrl = record.url ? (/^https:\/\//.test(record.url) ? record.url : `https://${record.url.replace(/^\/+/, "")}`) : null;
    const formats = (record.formats ?? []).filter((f) => f.url && /^https:\/\/www\.congress\.gov\//.test(f.url)).map((f) => ({ format: f.format ?? null, url: f.url! }));
    const officialUrl = pageUrl && /^https:\/\/www\.congress\.gov\//.test(pageUrl) ? pageUrl : (formats.find((f) => f.format === "HTML")?.url ?? formats[0]?.url ?? null);
    if (!officialUrl) return { kind: "skip", reason: `${ref.externalId}: the API record gives no congress.gov link.` };
    const authors = [...new Set((record.authors ?? []).map((a) => a.author?.trim()).filter((a): a is string => Boolean(a)))];
    const topics = (record.topics ?? []).map((t) => t.topic).filter((t): t is string => Boolean(t));
    const related = (record.relatedMaterials ?? []).map((m) => ({ type: m.type ?? null, congress: m.congress ?? null, number: m.number ?? null, title: m.title ?? null }));
    const statedDates: Record<string, string> = {};
    if (record.publishDate) statedDates.publishDate = record.publishDate;
    if (record.updateDate) statedDates.updateDate = record.updateDate;
    const metadata: Record<string, unknown> = {
      productId: record.id,
      ...(record.contentType ? { productType: record.contentType } : {}),
      ...(record.status ? { status: record.status } : {}),
      ...(typeof record.currentVersion === "number" ? { version: record.currentVersion } : {}),
      authors,
      topics,
      relatedMaterials: related,
      formats,
      ...(summary ? { summary, summaryKind: "CRS summary" } : {}),
      ...(listing ? { matchedBy: listing.matchedBy, matchedTerms: listing.matchedTerms } : {}),
      statedDates,
    };
    const base = {
      externalId: ref.externalId,
      docType: "report" as const,
      title: record.title,
      citations: [`CRS Report ${record.id}`],
      agency: "Congressional Research Service",
      // "2025-03-31T04:00:00Z" is midnight Eastern on the stated day: the date part is the date CRS states.
      publishedDate: isoDatePart(record.publishDate),
      precedentialStatus: "not_applicable" as const,
      officialUrl,
    };
    const summaryOnly = (why: string): FetchDocumentResult => ({
      kind: "document",
      document: {
        ...base,
        text: summary,
        textKind: summary ? "excerpt" : "none",
        metadata: { ...metadata, textNote: `The text kept is CRS's summary from the Congress.gov API: ${why} The full report is at the official link.` },
        fetch: { response },
      },
    });

    const pdfLink = formats.find((f) => f.format === "PDF" && /\.pdf$/i.test(new URL(f.url).pathname))?.url ?? null;
    if (!pdfLink) return summaryOnly("the record links no PDF.");
    let pdf: Awaited<ReturnType<typeof fetchPdf>>;
    try {
      pdf = await fetchPdf(ctx, pdfLink, ref.known, { label: ref.externalId, timeoutMs: API_TIMEOUT_MS });
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !REFUSED_FILE.test(code)) throw err;
      ctx.note(`${ref.externalId}: congress.gov answered the report PDF with ${code}; CRS's summary was kept instead.`);
      return summaryOnly(`congress.gov answered the report PDF with ${code}.`);
    }
    if (pdf === "not_modified") return { kind: "not_modified" };
    return {
      kind: "document",
      document: {
        ...base,
        originalUrl: pdf.response.url,
        text: pdf.text,
        textKind: pdf.textKind,
        metadata: { ...metadata, pageCount: pdf.pageCount, ...(pdf.noTextLayer ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}) },
        original: pdf.original,
        fetch: pdf.fetch,
      },
    };
  },
};
