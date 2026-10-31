import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fetchPdf, fingerprintOf, isoDatePart } from "./common";
import { immigrationTerms, isImmigrationMatch, isRedactedTitle, parseOigListing, type OigListing, type OigRow } from "./parse";

// DHS Office of Inspector General reports on the immigration components,
// read from the OIG's own report listings on www.oig.dhs.gov:
//
// - "Audits, Inspections, and Evaluations" and "Management Alerts", each a
//   table (report number, title linked to the PDF, issue date, fiscal year)
//   with a "DHS agency" filter. The collector reads the filter's options
//   from the listing's own form and keeps every report of the CBP, ICE and
//   USCIS views (the immigration components), and the reports of the MGMT
//   and "Others" views (department-wide work) whose titles use an
//   immigration term (./parse.ts, immigrationTerms: "DHS Training Needs for
//   Hiring 15,000 Border Patrol Agents and Immigration Officers"); a report
//   listed under several views is one document.
// - Daily: the first page (the newest 50) of each of the ten views.
// - Backfill: every page of each view, following the pager's "next" link,
//   one page (50 reports) per chunk.
// - Each report is read from its PDF. The OIG publishes no landing page per
//   report, so the PDF is the official URL.
//
// The OIG's robots.txt sets no Crawl-delay: the default pace (about one
// request a second) applies. US government work: public domain, stored in
// full.

const LISTINGS = {
  aie: { url: "https://www.oig.dhs.gov/reports/audits-inspections-and-evaluations", name: "Audits, Inspections, and Evaluations" },
  ma: { url: "https://www.oig.dhs.gov/reports/management-alerts", name: "Management Alerts" },
} as const;
type ListingKey = keyof typeof LISTINGS;
/** The immigration components: every report listed under them is kept. */
const COMPONENTS = ["CBP", "ICE", "USCIS"] as const;
/** Department-wide views: a report listed under them is kept when its title uses an immigration term. */
const TITLE_FILTERED = ["MGMT", "Others"] as const;
type Component = (typeof COMPONENTS)[number] | (typeof TITLE_FILTERED)[number];
const ALL_COMPONENTS: readonly Component[] = [...COMPONENTS, ...TITLE_FILTERED];

function titleFiltered(component: Component): boolean {
  return (TITLE_FILTERED as readonly string[]).includes(component);
}

/** The rows of a page this collector keeps, with the immigration terms of each title (empty for the immigration components' views). */
function keptRows(view: View, rows: OigRow[]): { row: OigRow; terms: string[] }[] {
  if (!titleFiltered(view.component)) return rows.map((row) => ({ row, terms: [] }));
  return rows.map((row) => ({ row, terms: immigrationTerms(row.title) })).filter((r) => isImmigrationMatch(r.terms));
}

const HOSTS = ["www.oig.dhs.gov", "oig.dhs.gov"] as const;
const AGENCY = "U.S. Department of Homeland Security, Office of Inspector General";

type View = { listing: ListingKey; component: Component };
type Cursor = { views: View[]; nextUrl: string | null };

type Listing = {
  reportNumber: string | null;
  title: string;
  dateTime: string | null;
  dateText: string | null;
  fiscalYear: string | null;
  listing: string;
  listedUnder: Component[];
  listedOn: string;
  /** For a report kept from a department-wide view: the immigration terms its title uses. */
  matchedTerms?: string[];
};

function allViews(): View[] {
  const views: View[] = [];
  for (const listing of Object.keys(LISTINGS) as ListingKey[]) for (const component of ALL_COMPONENTS) views.push({ listing, component });
  return views;
}

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return (
    Boolean(c) &&
    Array.isArray(c.views) &&
    c.views.every((v) => v && v.listing in LISTINGS && (ALL_COMPONENTS as readonly string[]).includes(v.component)) &&
    (c.nextUrl === null || (typeof c.nextUrl === "string" && c.nextUrl.startsWith("https://www.oig.dhs.gov/")))
  );
}

async function readListing(ctx: LibraryAdapterContext, url: string): Promise<OigListing & { pageUrl: string }> {
  const { text, response } = await ctx.http.getText(url, { expect: "html" });
  const parsed = parseOigListing(text, response.url);
  if (!parsed.recognized) throw new LibraryLayoutError(url, "no report table (views-table) and no empty-result message");
  for (const note of parsed.notes) ctx.note(`${url}: ${note}`);
  return { ...parsed, pageUrl: response.url };
}

/** The first page of a listing filtered to one component, built from the listing's own filter form (one request for the form per listing per run). */
async function firstPageUrl(ctx: LibraryAdapterContext, listing: ListingKey, component: Component, forms: Map<ListingKey, OigListing["agencyFilter"]>): Promise<string> {
  if (!forms.has(listing)) forms.set(listing, (await readListing(ctx, LISTINGS[listing].url)).agencyFilter);
  const filter = forms.get(listing);
  if (!filter) throw new LibraryLayoutError(LISTINGS[listing].url, "no DHS agency filter in the listing's form");
  const value = filter.options[component];
  if (!value) throw new LibraryLayoutError(LISTINGS[listing].url, `the DHS agency filter has no "${component}" option (options: ${Object.keys(filter.options).join(", ")})`);
  const url = new URL(filter.action);
  url.searchParams.set(filter.field, value);
  for (const [name, v] of Object.entries(filter.otherFields)) url.searchParams.set(name, v);
  return url.toString();
}

/** The report number; for the few older management alerts listed without one, the file's path on the OIG site. */
function idOf(row: OigRow): string {
  return row.reportNumber ?? new URL(row.fileUrl).pathname;
}

function refFor(row: OigRow, listing: ListingKey, components: Component[], pageUrl: string, terms: string[]): DocumentRef {
  const data: Listing = {
    reportNumber: row.reportNumber,
    title: row.title,
    dateTime: row.dateTime,
    dateText: row.dateText,
    fiscalYear: row.fiscalYear,
    listing: LISTINGS[listing].name,
    listedUnder: components,
    listedOn: pageUrl,
    ...(terms.length ? { matchedTerms: terms } : {}),
  };
  return {
    externalId: idOf(row),
    url: row.fileUrl,
    title: row.reportNumber ? `${row.reportNumber} ${row.title}` : row.title,
    // The same report is the same document whichever component or listing shows it. A management
    // alert also listed among the audits is the same report under a "Management Alert - " title and
    // an older copy of the file, so neither the prefix nor the file link is part of the fingerprint
    // (the file is still re-read every recheckAfterDays).
    fingerprint: fingerprintOf(row.reportNumber, row.title.replace(/^Management Alerts?\s*[-:\u2013\u2014]\s*/i, ""), row.dateTime, row.fiscalYear),
    listing: data,
  };
}

async function readView(ctx: LibraryAdapterContext, view: View, url: string, requireRows: boolean) {
  const page = await readListing(ctx, url);
  if (requireRows && page.rows.length === 0 && view.listing === "aie" && !titleFiltered(view.component)) {
    // Every immigration component has hundreds of audits; an empty first page is a changed page, not a quiet day.
    throw new LibraryLayoutError(url, `no reports in the ${view.component} view of ${LISTINGS[view.listing].name}`);
  }
  return page;
}

export const dhsOigReportsAdapter: LibrarySourceAdapter = {
  code: "dhs_oig_immigration_reports",
  group: "oversight-reports",
  name: "DHS Inspector General reports (CBP, ICE, USCIS)",
  description:
    "Audits, inspections, evaluations and management alerts of the DHS Office of Inspector General on U.S. Customs and Border Protection, Immigration and Customs Enforcement and U.S. Citizenship and Immigration Services, and department-wide ones on immigration, read from the OIG's report listings and each report's PDF.",
  coverage:
    "Every report the OIG's Audits, Inspections, and Evaluations and Management Alerts listings show under CBP, ICE or USCIS (back to 2003 as the OIG lists them), and those listed under MGMT or Others whose titles concern immigration; reports filed only under other DHS components are not collected.",
  cadence: "Daily",
  officialUrl: LISTINGS.aie.url,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,

  async listUpdates(ctx) {
    const forms = new Map<ListingKey, OigListing["agencyFilter"]>();
    const byId = new Map<string, { row: OigRow; listing: ListingKey; components: Component[]; pageUrl: string; terms: string[] }>();
    for (const view of allViews()) {
      const page = await readView(ctx, view, await firstPageUrl(ctx, view.listing, view.component, forms), true);
      for (const { row, terms } of keptRows(view, page.rows)) {
        const seen = byId.get(idOf(row));
        if (seen) {
          if (!seen.components.includes(view.component)) seen.components.push(view.component);
          if (seen.row.fileUrl !== row.fileUrl) ctx.note(`${idOf(row)} is listed with two different files (${seen.row.fileUrl} and ${row.fileUrl}); the first was kept.`);
          continue;
        }
        byId.set(idOf(row), { row, listing: view.listing, components: [view.component], pageUrl: page.pageUrl, terms });
      }
    }
    return { refs: [...byId.values()].map((e) => refFor(e.row, e.listing, e.components, e.pageUrl, e.terms)) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const state: Cursor = isCursor(cursor) ? cursor : { views: allViews(), nextUrl: null };
    const view = state.views[0];
    if (!view) return { refs: [], nextCursor: null, progress: "every view is done" };
    const forms = new Map<ListingKey, OigListing["agencyFilter"]>();
    const url = state.nextUrl ?? (await firstPageUrl(ctx, view.listing, view.component, forms));
    const page = await readView(ctx, view, url, state.nextUrl === null);
    if (page.rows.length === 0 && state.nextUrl) ctx.note(`${url} lists no reports any more (the listing changed since the cursor was saved); moving to the next view.`);
    const refs = keptRows(view, page.rows).map(({ row, terms }) => refFor(row, view.listing, [view.component], page.pageUrl, terms));
    const nextCursor: Cursor | null =
      page.nextUrl && page.rows.length > 0 ? { views: state.views, nextUrl: page.nextUrl } : state.views.length > 1 ? { views: state.views.slice(1), nextUrl: null } : null;
    const pageNo = new URL(page.pageUrl).searchParams.get("page") ?? "0";
    return {
      refs,
      nextCursor,
      progress: `${LISTINGS[view.listing].name}, ${view.component}, page ${Number(pageNo) + 1} (${page.rows.length} listed, ${refs.length} kept); ${state.views.length - 1} more view(s) after this one`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.title) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    if (!/\.pdf$/i.test(new URL(ref.url).pathname)) return { kind: "skip", reason: `${ref.externalId}: the listing links ${ref.url}, not a PDF report.` };
    const pdf = await fetchPdf(ctx, ref.url, ref.known, { label: ref.externalId, timeoutMs: 120_000 });
    if (pdf === "not_modified") return { kind: "not_modified" };
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "report",
        title: listing.title,
        citations: listing.reportNumber ? [listing.reportNumber] : [],
        agency: AGENCY,
        publishedDate: isoDatePart(listing.dateTime),
        precedentialStatus: "not_applicable",
        officialUrl: pdf.response.url,
        text: pdf.text,
        textKind: pdf.textKind,
        metadata: {
          ...(listing.reportNumber ? { reportNumber: listing.reportNumber } : {}),
          series: listing.listing,
          listedUnder: listing.listedUnder,
          ...(listing.fiscalYear ? { fiscalYear: listing.fiscalYear } : {}),
          redacted: isRedactedTitle(listing.title),
          listedOn: listing.listedOn,
          ...(listing.matchedTerms?.length ? { matchedTerms: listing.matchedTerms } : {}),
          statedDates: listing.dateText ? { issued: listing.dateText } : {},
          pageCount: pdf.pageCount,
          ...(pdf.noTextLayer ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}),
        },
        original: pdf.original,
        fetch: pdf.fetch,
      },
    };
  },
};
