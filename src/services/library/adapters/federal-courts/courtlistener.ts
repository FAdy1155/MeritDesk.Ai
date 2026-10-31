import { extractPdfText } from "../../extract/pdf";
import { htmlToDocumentText, mainContent } from "../../extract/html";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryHttpResponse,
} from "../../types";
import { clOpinionTextSource, clOpinionTypeLabel, clPrecedential, isoDateOrNull, parseClSearchPage, type ClCluster } from "./parse";

// What the two CourtListener collectors share. CourtListener (Free Law
// Project, https://www.courtlistener.com) holds the federal courts' opinions
// as the courts published them, including the history before GovInfo
// (Harvard's Caselaw Access Project and Public.Resource.Org scans of the
// Federal Reporter and Federal Supplement) and the unpublished dispositions
// some circuits never sent GovInfo. Court opinions are public domain; only
// the opinions' own text is stored, never CourtListener's or a publisher's
// editorial matter (the cluster's syllabus, headnotes and summary fields
// are not kept).
//
// - Search API v4 (https://www.courtlistener.com/api/rest/v4/search/,
//   type=o) with the immigration query below, by court and filing date,
//   newest first; its own "next" link is the backfill cursor.
// - Text: the court's own file when CourtListener records an https link to
//   it on that court's site (the official copy; no API request), else the
//   opinions API (/api/rest/v4/opinions/<id>/), richest text field first.
// - The token (COURTLISTENER_API_TOKEN) goes in the Authorization header.
//
// The API allowance. CourtListener's documented default for a free account
// is 5 requests a minute, 50 an hour and 125 a day
// (https://wiki.free.law/c/courtlistener/help/api/rest/v4, "Rate Limits");
// COURTLISTENER_API_LIMITS ("5/minute,50/hour,125/day") states a larger one
// for a member account. This process counts its own API requests against
// it: a request waits for the minute window, and a backfill chunk that the
// hour or day cannot pay for fails with that message before it starts (the
// next hourly kick resumes from the same cursor), keeping DAILY_RESERVE
// requests of each day for the daily runs.

export const CL_HOST = "www.courtlistener.com";
const API = "https://www.courtlistener.com/api/rest/v4";
export const CL_TOKEN_ENV = "COURTLISTENER_API_TOKEN";
export const CL_LIMITS_ENV = "COURTLISTENER_API_LIMITS";
const DEFAULT_LIMITS = { perMinute: 5, perHour: 50, perDay: 125 };
/** Requests of each day's allowance a backfill chunk leaves for daily runs. */
export const DAILY_RESERVE = 20;

/**
 * The immigration query (CourtListener's search syntax, quoted phrases
 * OR'ed): the Board and immigration judges, the INS and its predecessors'
 * officers, the Act, USCIS, deportation and naturalization. It matches the
 * opinion's full text, so it also finds criminal and habeas cases that
 * turn on an immigration question.
 *
 * Not "removal proceedings": tried live (October 2026), every opinion it
 * added beyond the other terms was a civil case removed from state court
 * (14 of 633 in eleven district courts, 1990 to 2003; 6 of 57 in the Fifth
 * Circuit before 1936), and it added none in the Ninth Circuit's 2026
 * opinions, where removal cases always name the Board or the Act.
 */
export const IMMIGRATION_QUERY = [
  '"Board of Immigration Appeals"',
  '"immigration judge"',
  '"Immigration and Naturalization Service"',
  '"Immigration and Nationality Act"',
  '"Commissioner of Immigration"',
  '"Bureau of Immigration"',
  '"Immigration Act"',
  '"Citizenship and Immigration Services"',
  "deportation",
  // Not the bare word: CourtListener stems it, and "naturalization" then
  // matches "national origin" in employment cases.
  '"petition for naturalization"',
  '"application for naturalization"',
  '"certificate of naturalization"',
  "denaturalization",
].join(" OR ");

/** CourtListener's precedential status filters (stat_<value>=on), all of them for a full history. */
export const ALL_STATUSES = ["Published", "Unpublished", "Errata", "Separate", "In-chambers", "Relating-to", "Unknown"];

export class CourtListenerAllowanceError extends Error {
  constructor(detail: string) {
    super(`CourtListener's API allowance for this account is used up for now (${detail}); the walk resumes when it frees up.`);
    this.name = "CourtListenerAllowanceError";
  }
}

type Limits = typeof DEFAULT_LIMITS;

function readLimits(ctx: LibraryAdapterContext): Limits {
  const raw = ctx.env(CL_LIMITS_ENV);
  const limits = { ...DEFAULT_LIMITS };
  if (!raw) return limits;
  for (const part of raw.split(",")) {
    const m = /^\s*(\d+)\s*\/\s*(minute|hour|day)\s*$/i.exec(part);
    if (!m) continue;
    const n = Number(m[1]);
    if (n < 1) continue;
    if (/^minute$/i.test(m[2])) limits.perMinute = n;
    else if (/^hour$/i.test(m[2])) limits.perHour = n;
    else limits.perDay = n;
  }
  return limits;
}

/** This process's CourtListener API requests (start times), the last day's worth. */
let requestLog: number[] = [];

function usedSince(now: number, windowMs: number): number {
  return requestLog.filter((t) => t > now - windowMs).length;
}

/** Requests the hour and the day still allow. */
export function allowanceLeft(ctx: LibraryAdapterContext): { hour: number; day: number } {
  const limits = readLimits(ctx);
  const now = Date.now();
  requestLog = requestLog.filter((t) => t > now - 86_400_000);
  return { hour: limits.perHour - usedSince(now, 3_600_000), day: limits.perDay - usedSince(now, 86_400_000) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true }
    );
  });
}

async function takeSlot(ctx: LibraryAdapterContext): Promise<void> {
  const limits = readLimits(ctx);
  const left = allowanceLeft(ctx);
  if (left.day < 1) throw new CourtListenerAllowanceError(`${limits.perDay} a day`);
  if (left.hour < 1) throw new CourtListenerAllowanceError(`${limits.perHour} an hour`);
  for (;;) {
    const now = Date.now();
    const inMinute = requestLog.filter((t) => t > now - 60_000);
    if (inMinute.length < limits.perMinute) break;
    await sleep(inMinute[0] + 60_000 - now + 250, ctx.signal);
  }
  requestLog.push(Date.now());
}

function authHeaders(ctx: LibraryAdapterContext): Record<string, string> {
  const token = ctx.env(CL_TOKEN_ENV);
  return token ? { Authorization: `Token ${token}` } : {};
}

async function apiJson(ctx: LibraryAdapterContext, url: string): Promise<{ data: unknown; response: LibraryHttpResponse }> {
  await takeSlot(ctx);
  return ctx.http.getJson(url, { headers: authHeaders(ctx) });
}

export type SearchWindow = { courts: string[]; statuses: string[]; filedAfter?: string | null; filedBefore?: string | null };

/** The first page of a search (the API's documented parameters). */
export function searchUrl(w: SearchWindow): string {
  const params = new URLSearchParams({ type: "o", q: IMMIGRATION_QUERY, order_by: "dateFiled desc", court: w.courts.join(" ") });
  if (w.filedAfter) params.set("filed_after", w.filedAfter);
  if (w.filedBefore) params.set("filed_before", w.filedBefore);
  for (const s of w.statuses) params.set(`stat_${s}`, "on");
  return `${API}/search/?${params.toString()}`;
}

export async function searchPage(ctx: LibraryAdapterContext, url: string) {
  const { data } = await apiJson(ctx, url);
  const page = parseClSearchPage(data);
  if (!page) throw new LibraryLayoutError(url, "not a CourtListener search page (no results array)");
  if (page.next && !page.next.startsWith(`${API}/search/`)) throw new LibraryLayoutError(url, `its next link is not a search page (${page.next.slice(0, 120)})`);
  return page;
}

export type ClusterListing = {
  cluster: ClCluster;
  /** The court's own name for the court of this cluster (from the collector's table). */
  courtName: string;
  /** Hosts of this court's own site, where its opinion files are official copies. */
  courtHosts: string[];
  /** The search window the cluster was listed in ("unpublished since 2009", "before 2004"). */
  window: string;
};

export function clusterRef(cluster: ClCluster, courtName: string, courtHosts: string[], window: string): DocumentRef {
  const listing: ClusterListing = { cluster, courtName, courtHosts, window };
  return {
    externalId: `cluster ${cluster.clusterId}`,
    url: `https://${CL_HOST}${cluster.absoluteUrl}`,
    title: cluster.caseName,
    fingerprint: sha256Hex(
      [
        cluster.caseName,
        cluster.dateFiled ?? "",
        cluster.docketNumber ?? "",
        cluster.status ?? "",
        cluster.citations.join("|"),
        ...cluster.opinions.map((o) => `${o.id} ${o.type ?? ""} ${o.downloadUrl ?? ""} ${o.sha1 ?? ""}`),
      ].join("\u0000")
    ).slice(0, 32),
    listing,
  };
}

/** Same court, docket and filing date: CourtListener holds a few cases twice (a court's copy and a reporter's); the first listed is kept. */
export function dropDuplicateClusters(clusters: ClCluster[]): ClCluster[] {
  const seen = new Set<string>();
  return clusters.filter((c) => {
    if (!c.docketNumber || !c.dateFiled) return true;
    const key = `${c.courtId}|${c.docketNumber.replace(/\s+/g, "").toLowerCase()}|${c.dateFiled}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type ClusterText = {
  text: string;
  textKind: "full" | "none";
  officialUrl: string;
  response: LibraryHttpResponse;
  source: "court file" | "CourtListener opinions API";
  original: { bytes: Buffer; contentType: string; extension: string } | null;
  extraction: Record<string, unknown>;
  opinionParts: { id: number; type: string | null; label: string; author: string | null; field: string | null }[];
};

/** The one court-file link every opinion of the cluster shares, when it is https on the court's own site. */
function courtFileUrl(listing: ClusterListing): string | null {
  const links = [...new Set(listing.cluster.opinions.map((o) => o.downloadUrl).filter((u): u is string => Boolean(u)))];
  if (links.length !== 1) return null;
  try {
    const url = new URL(links[0]);
    return url.protocol === "https:" && listing.courtHosts.includes(url.hostname.toLowerCase()) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function fromCourtFile(ctx: LibraryAdapterContext, url: string, known: DocumentRef["known"]): Promise<ClusterText | "not_modified" | null> {
  let response: LibraryHttpResponse;
  try {
    response = await ctx.http.get(url, { expect: "any", conditional: known ?? null });
  } catch (err) {
    ctx.note(`The court's file ${url} could not be read (${err instanceof Error ? err.message : String(err)}); CourtListener's copy was used.`);
    return null;
  }
  if (response.notModified) return "not_modified";
  const isPdf = response.body.subarray(0, 5).toString("latin1") === "%PDF-";
  if (isPdf) {
    const pdf = await extractPdfText(response.body);
    const hasText = pdf.pagesWithText > 0;
    return {
      text: hasText ? pdf.text : "",
      textKind: hasText ? "full" : "none",
      officialUrl: response.url,
      response,
      source: "court file",
      original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
      extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated },
      opinionParts: [],
    };
  }
  if (/html/i.test(response.contentType ?? "")) {
    const text = htmlToDocumentText(mainContent(response.body.toString("utf-8")));
    if (text.length > 200) {
      return { text, textKind: "full", officialUrl: response.url, response, source: "court file", original: null, extraction: { method: "html" }, opinionParts: [] };
    }
  }
  ctx.note(`The court's file ${url} is neither a PDF nor an HTML opinion (${response.contentType ?? "no content type"}); CourtListener's copy was used.`);
  return null;
}

const OPINION_FIELDS = "id,type,author_str,per_curiam,joined_by_str,download_url,page_count,extracted_by_ocr,plain_text,html,html_lawbox,html_columbia,html_anon_2020,xml_harvard,html_with_citations";

/** For the Caselaw Access Project's XML: the <opinion> elements only (the court's words), when it has them. */
function harvardOpinions(xml: string): string {
  const opinions = [...xml.matchAll(/<opinion\b[^>]*>[\s\S]*?<\/opinion\s*>/gi)].map((m) => m[0]);
  return opinions.length ? opinions.join("\n") : xml;
}

async function fromApi(ctx: LibraryAdapterContext, listing: ClusterListing): Promise<ClusterText | null> {
  const ops = listing.cluster.opinions;
  // A "combined" opinion already holds every part; the parts beside it are the same text split up.
  const combined = ops.filter((o) => /combined/i.test(o.type ?? ""));
  const chosen = combined.length ? combined.slice(0, 1) : ops;
  const chunks: string[] = [];
  const parts: ClusterText["opinionParts"] = [];
  let response: LibraryHttpResponse | null = null;
  let ocr = false;
  for (const op of chosen) {
    const got = await apiJson(ctx, `${API}/opinions/${op.id}/?fields=${OPINION_FIELDS}`);
    response ??= got.response;
    const record = got.data && typeof got.data === "object" ? (got.data as Record<string, unknown>) : null;
    if (!record || record.id !== op.id) throw new LibraryLayoutError(`${API}/opinions/${op.id}/`, "not an opinion record");
    if (record.extracted_by_ocr === true) ocr = true;
    const source = clOpinionTextSource(record);
    const label = clOpinionTypeLabel(typeof record.type === "string" ? record.type : op.type);
    const author = typeof record.author_str === "string" && record.author_str.trim() ? record.author_str.trim() : null;
    parts.push({ id: op.id, type: typeof record.type === "string" ? record.type : op.type, label, author, field: source?.field ?? null });
    if (!source) continue;
    const text = source.html !== null ? htmlToDocumentText(source.field === "xml_harvard" ? harvardOpinions(source.html) : source.html) : source.plain ?? "";
    // With several opinions, each is headed by CourtListener's type and author for it.
    chunks.push(chosen.length > 1 ? `[${label}${author ? `: ${author}` : ""}]\n\n${text}` : text);
  }
  if (!response) return null;
  const text = chunks.join("\n\n").trim();
  return {
    text,
    textKind: text ? "full" : "none",
    officialUrl: `https://${CL_HOST}${listing.cluster.absoluteUrl}`,
    response,
    source: "CourtListener opinions API",
    original: null,
    extraction: { method: "courtlistener-api", opinions: chosen.length, extractedByOcr: ocr },
    opinionParts: parts,
  };
}

/** The cluster's text: the court's own file when there is one, else CourtListener's. */
export async function clusterText(ctx: LibraryAdapterContext, ref: DocumentRef): Promise<ClusterText | "not_modified" | null> {
  const listing = ref.listing as ClusterListing;
  const file = courtFileUrl(listing);
  if (file) {
    const fromFile = await fromCourtFile(ctx, file, ref.known);
    if (fromFile) return fromFile;
  }
  return fromApi(ctx, listing);
}

/** One search window of a collector: a set of courts, statuses and filing dates walked newest first. */
export type ClWindow = {
  id: string;
  /** For the run's notes and the document's metadata ("Ninth Circuit unpublished, 2009 on"). */
  label: string;
  search: SearchWindow;
  /** Whether the daily run reads this window (it is still open to new opinions). */
  daily: boolean;
  /** API requests a 20-case page costs beyond the search: about 20 when the texts come from the opinions API, 2 when from the courts' files. */
  apiCostPerPage: number;
};

export type ClCourtTable = { name(courtId: string, cluster: ClCluster): string; hosts(courtId: string): string[] };

export type ClCursor = { windows: string[]; next: string | null; lastDate: string | null };

export function isClCursor(value: unknown): value is ClCursor {
  const c = value as ClCursor;
  return (
    Boolean(c) &&
    Array.isArray(c.windows) &&
    c.windows.every((s) => typeof s === "string") &&
    (c.next === null || typeof c.next === "string") &&
    (c.lastDate === null || isoDateOrNull(c.lastDate) !== null)
  );
}

function refsOfPage(results: ClCluster[], window: ClWindow, courts: ClCourtTable): DocumentRef[] {
  return dropDuplicateClusters(results).map((c) => clusterRef(c, courts.name(c.courtId, c), courts.hosts(c.courtId), window.label));
}

/**
 * The daily run: each open window's opinions filed on or after
 * `filedAfter` (or the window's own start, whichever is later), all pages.
 */
export async function recentRefs(ctx: LibraryAdapterContext, windows: ClWindow[], courts: ClCourtTable, filedAfter: string, maxPages: number): Promise<DocumentRef[]> {
  const refs: DocumentRef[] = [];
  for (const w of windows.filter((x) => x.daily)) {
    const after = w.search.filedAfter && w.search.filedAfter > filedAfter ? w.search.filedAfter : filedAfter;
    let url: string | null = searchUrl({ ...w.search, filedAfter: after });
    for (let pages = 0; url && pages < maxPages; pages++) {
      const page = await searchPage(ctx, url);
      refs.push(...refsOfPage(page.results, w, courts));
      url = page.next;
      if (url && pages + 1 === maxPages) ctx.note(`${w.label}: more than ${maxPages} pages of new opinions; the rest waits for the next run.`);
    }
  }
  return refs;
}

/** One backfill chunk: one search page of the first window left. */
export async function walkChunk(ctx: LibraryAdapterContext, windows: ClWindow[], courts: ClCourtTable, cursor: unknown): Promise<BackfillChunk> {
  const state: ClCursor = isClCursor(cursor) ? cursor : { windows: windows.map((w) => w.id), next: null, lastDate: null };
  let id = state.windows[0];
  while (id !== undefined && !windows.some((w) => w.id === id)) {
    // A window this collector no longer has (a stale cursor): noted and passed.
    ctx.note(`The saved search window ${id} is no longer one of this collector's; it was skipped.`);
    state.windows = state.windows.slice(1);
    state.next = null;
    state.lastDate = null;
    id = state.windows[0];
  }
  if (id === undefined) return { refs: [], nextCursor: null, progress: "every search window is done" };
  const w = windows.find((x) => x.id === id)!;
  const left = allowanceLeft(ctx);
  const reserve = ctx.mode === "backfill" ? DAILY_RESERVE : 0;
  if (left.day - reserve < 1 + w.apiCostPerPage) throw new CourtListenerAllowanceError(`${left.day} request(s) left today, ${reserve} kept for the daily runs`);
  if (left.hour < 1 + w.apiCostPerPage) throw new CourtListenerAllowanceError(`${left.hour} request(s) left this hour`);

  let page;
  if (state.next) {
    try {
      page = await searchPage(ctx, state.next);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "http_400" && code !== "http_404") throw err;
      // CourtListener no longer accepts the saved page: the window restarts at the last date reached.
      ctx.note(`The saved CourtListener page for ${w.label} was refused; the window restarts at ${state.lastDate ?? "its start"}.`);
      page = await searchPage(ctx, searchUrl({ ...w.search, filedBefore: state.lastDate ?? w.search.filedBefore }));
    }
  } else {
    page = await searchPage(ctx, searchUrl(w.search));
  }
  const refs = refsOfPage(page.results, w, courts);
  const dates = page.results.map((c) => c.dateFiled).filter((d): d is string => Boolean(d)).sort();
  const rest = state.windows.slice(1);
  const nextCursor: ClCursor | null = page.next
    ? { windows: state.windows, next: page.next, lastDate: dates[0] ?? state.lastDate }
    : rest.length
      ? { windows: rest, next: null, lastDate: null }
      : null;
  return {
    refs,
    nextCursor,
    progress: `${w.label}: ${page.results.length} case(s) filed ${dates[0] ?? "?"} to ${dates[dates.length - 1] ?? "?"}${page.count !== null ? ` (${page.count} in the window)` : ""}; ${rest.length} more window(s) after this one`,
  };
}

/** One cluster (case) read into a library document. */
export async function fetchCluster(ctx: LibraryAdapterContext, ref: DocumentRef, kind: "appeals" | "district"): Promise<FetchDocumentResult> {
  const listing = ref.listing as ClusterListing | undefined;
  const c = listing?.cluster;
  if (!listing || !c?.clusterId) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
  const got = await clusterText(ctx, ref);
  if (got === "not_modified") return { kind: "not_modified" };
  if (!got) return { kind: "skip", reason: `${ref.externalId} (${c.caseName}): CourtListener lists no opinion records for it.` };
  const precedential = kind === "district" ? { status: "non_precedential" as const, basis: "district court decision" } : clPrecedential(c.status, c.citations);
  const pageUrl = `https://${CL_HOST}${c.absoluteUrl}`;
  const fileLinks = [...new Set(c.opinions.map((o) => o.downloadUrl).filter((u): u is string => Boolean(u)))];
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "opinion",
      title: c.caseName,
      citations: c.citations.slice(0, 50),
      court: listing.courtName,
      decisionDate: c.dateFiled,
      precedentialStatus: precedential.status,
      officialUrl: got.officialUrl,
      originalUrl: null,
      text: got.text,
      textKind: got.textKind,
      metadata: {
        clusterId: c.clusterId,
        courtListenerUrl: pageUrl,
        courtId: c.courtId,
        ...(c.docketNumber ? { docket: c.docketNumber } : {}),
        ...(c.docketId !== null ? { courtListenerDocketId: c.docketId } : {}),
        ...(c.caseNameFull && c.caseNameFull !== c.caseName ? { caseNameFull: c.caseNameFull } : {}),
        ...(c.status ? { courtListenerStatus: c.status } : {}),
        ...(precedential.basis ? { precedentialBasis: precedential.basis } : {}),
        ...(c.judge ? { judges: c.judge } : {}),
        ...(c.panelNames.length ? { panel: c.panelNames } : {}),
        ...(c.dateArgued ? { dateArgued: c.dateArgued } : {}),
        ...(c.suitNature ? { natureOfSuit: c.suitNature } : {}),
        textSource: got.source,
        ...(got.opinionParts.length ? { opinions: got.opinionParts } : {}),
        ...(fileLinks.length ? { courtFileAsRecorded: fileLinks } : {}),
        listedIn: listing.window,
        statedDates: c.dateFiled ? { filed: c.dateFiled } : {},
      },
      original: got.original,
      fetch: { response: got.response, extraction: got.extraction },
    },
  };
}

/** A YYYY-MM-DD one day before `date`, for an exclusive filed_before. */
export function dayBefore(date: string): string {
  const d = new Date(`${isoDateOrNull(date) ?? date}T00:00:00Z`);
  return new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
}
