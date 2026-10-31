import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText, pageTitle, resolveUrl } from "../../extract/html";
import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryDocumentInput,
  type LibraryGetOptions,
  type LibraryHttpResponse,
  type LibrarySourceAdapter,
} from "../../types";
import { countryFields } from "./country";
import {
  archiveLinks,
  headlineSubject,
  metaRefreshUrl,
  narrativeHeadingCountries,
  parseArchiveReportPage,
  parseArchiveYearLinks,
  parseSitemap,
  parseStateReportPage,
  statedTier,
  statedYear,
  type ArchiveLink,
  type ArchiveYearLink,
  type SitemapEntry,
} from "./parse";

// What the three State Department report collectors share (Country Reports
// on Human Rights Practices, the International Religious Freedom Report,
// the Trafficking in Persons Report): each annual report is published as
// one page per country, on two of the Department's sites.
//
// - www.state.gov holds the report years since 2016 (2017 for Trafficking in
//   Persons) at /reports/<year>-<report name>/<country>/, with some areas
//   one level further down (China: Hong Kong, Macau, Tibet; Ukraine:
//   Crimea). The site's Yoast sitemaps (sitemap_index.xml, then
//   state_report-sitemap*.xml) list every report page with its lastmod, so
//   they are the listing: the daily run reads only the report sitemaps
//   modified since the last run and keeps the series' pages modified since
//   then; backfill takes the series' pages year by year, newest first. A
//   sitemap entry's lastmod goes into the fingerprint, so an edited page is
//   fetched again (conditionally). Pages the sitemaps list that are a
//   draft, template or sample left published by mistake ("burma-draft",
//   "eap-template-2", "2022samplehrrwha") are skipped.
// - 2009-2017.state.gov, the Department's archive of its 2009-2017 site,
//   holds the earlier report years (from 1999 for human rights, 2001 for
//   religious freedom, 2001 for trafficking). The years are read from the
//   series' landing page (or the archive's own index), each year's index
//   page links the country pages (or region pages that do), and each
//   country page is the archive site's release template (the report name,
//   the release date, the country heading, the text). Backfill only: the
//   archive does not change.
// - The Trafficking in Persons reports before 2016 have no per-country
//   pages: the country narratives are published as a few pages or PDFs
//   covering a range of countries ("Country Narratives: Countries A Through
//   F"). Those are collected as they are, one document each, with no
//   single country.
//
// Every page's text is the report's own content (the page furniture, side
// navigation and "On This Page" list left out). The pages state no
// publication date on www.state.gov (only the page's modification time,
// kept in metadata.statedDates.modified); the archive pages state the
// release date, kept as publishedDate. documentYear is the year in the
// report's name. Country: metadata.country as the page names it (the part
// of the headline after the report's name, or the archive's country link),
// with metadata.countryKey for lookups (./country.ts).
//
// Both sites refuse the library's declared User-Agent (checked again in
// October 2026): www.state.gov answers HTTP 403, and 2009-2017.state.gov
// answers HTTP 200 with the same "Technical Difficulties" page in place of
// the page asked for. The site's filter lets through clients whose
// User-Agent starts "Mozilla/5.0" and does not contain "bot" (so a
// User-Agent that mentions robots.txt is refused); the collector does not
// try to get around it. The 403 fails the request, and the refusal page is
// recognized (refusalCheck) and fails it too, so the run fails with the
// site's answer and /library shows the source as failing until the sites
// let the library's User-Agent through. The page layouts were checked on
// the Internet Archive's copies of the pages. robots.txt on both asks for 5
// seconds between requests.
//
// US government work: public domain, stored in full.

export const STATE_WWW = "www.state.gov";
export const STATE_ARCHIVE = "2009-2017.state.gov";
export const STATE_HOSTS = [STATE_WWW, STATE_ARCHIVE] as const;
const SITEMAP_INDEX = "https://www.state.gov/sitemap_index.xml";
const AGENCY = "U.S. Department of State";
/** Report pages per backfill chunk: about 6 seconds each at the sites' 5-second pace. */
const CHUNK = 80;
/** The em or en dash between a parent and a sub-report's area in a headline (built from code points to keep this file ASCII). */
const SUB_AREA_DASH = new RegExp(`\\s*[${String.fromCharCode(0x2014, 0x2013)}]\\s*`);
/** Pages a sitemap lists that are not part of a published report. */
const NOT_PUBLISHED = /draft|template|sample/i;

export type StateSeriesConfig = {
  code: string;
  name: string;
  description: string;
  coverage: string;
  /** metadata.series: a stable key for the series. */
  series: string;
  /** The series' name, as the Department writes it. */
  seriesName: string;
  /** The series' landing page on www.state.gov. */
  officialUrl: string;
  /** A report page's path on www.state.gov: group 1 the year, group 2 the path below the report. */
  wwwPath: RegExp;
  /** The page whose links name the archive site's report years. */
  archiveIndexUrl: string;
  /** A year's index on the archive site: group 1 the report's folder. */
  archiveYearIndexPath: RegExp;
  /** A country page of the report in `dir`; group 1, when present, its region folder. */
  archiveCountryPath(dir: string): RegExp;
  /** Region pages of the report in `dir` that list its country pages (years whose index lists regions). */
  archiveHubPath?(dir: string): RegExp;
  /** Trafficking in Persons: the "Country Narratives" pages and the grouped narratives of years without country pages. */
  narratives?: {
    hubText: RegExp;
    hubPath(dir: string): RegExp;
    groupedText: RegExp;
    /** On a "Country Narratives" page only: links to grouped narratives by region (the 2004 report's "Africa", "Near East"). */
    hubGroupedText?: RegExp;
    groupedPath(dir: string): RegExp;
  };
};

type WwwListing = { kind: "www"; year: number; lastmod: string | null };
type ArchiveListing = {
  kind: "archive_country" | "archive_grouped_page" | "archive_grouped_pdf";
  year: number;
  dir: string;
  /** The archive year link's text ("Country Reports on Human Rights Practices for 2008"). */
  yearText: string;
  /** The year index page's <title> ("Trafficking in Persons Report 2014"), naming grouped narratives. */
  yearTitle: string;
  /** The link text the page or file was found under: the country, or the range of countries. */
  listedText: string;
  region: string | null;
  listedOn: string;
};

type Cursor = { phase: "www"; years: number[]; offset: number } | { phase: "archive"; dirs: string[]; offset: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  if (!c || typeof c !== "object" || !Number.isInteger(c.offset)) return false;
  if (c.phase === "www") return Array.isArray(c.years) && c.years.every((y) => Number.isInteger(y));
  if (c.phase === "archive") return Array.isArray(c.dirs) && c.dirs.every((d) => typeof d === "string");
  return false;
}

/** The page the State Department's sites serve in place of the one asked for when they refuse a client. */
const REFUSAL_TITLE = /^\s*Technical Difficulties\s*$/i;

/** Fails the request when `text` is the sites' refusal page rather than the page at `url`. */
function refusalCheck(text: string, url: string): void {
  if (REFUSAL_TITLE.test(pageTitle(text) ?? "")) {
    throw new Error(
      `${new URL(url).hostname} answered ${url} with its "Technical Difficulties" page (how the State Department's sites refuse a client) instead of the page; nothing from it was used.`
    );
  }
}

/** GET a page on either site as text, failing on the refusal page. */
async function stateText(ctx: LibraryAdapterContext, url: string, options: Partial<LibraryGetOptions>): Promise<{ text: string; response: LibraryHttpResponse }> {
  const got = await ctx.http.getText(url, options);
  if (!got.response.notModified) refusalCheck(got.text, got.response.url);
  return got;
}

// ---------------------------------------------------------------------------
// www.state.gov: the sitemaps

/** Every entry of the report sitemaps (only those modified since `cutoff`, when given). */
async function reportSitemapEntries(ctx: LibraryAdapterContext, cutoff: Date | null): Promise<SitemapEntry[]> {
  const { text } = await stateText(ctx, SITEMAP_INDEX, { expect: "xml" });
  const index = parseSitemap(text);
  if (!index || index.kind !== "index") throw new LibraryLayoutError(SITEMAP_INDEX, "not a sitemap index");
  const maps = index.entries.filter((e) => {
    try {
      const u = new URL(e.loc);
      return u.hostname === STATE_WWW && /^\/state_report-sitemap\d*\.xml$/.test(u.pathname);
    } catch {
      return false;
    }
  });
  if (maps.length === 0) throw new LibraryLayoutError(SITEMAP_INDEX, "no state_report sitemaps listed");
  const out: SitemapEntry[] = [];
  for (const map of maps) {
    const modified = map.lastmod ? new Date(map.lastmod) : null;
    if (cutoff && modified && !Number.isNaN(modified.getTime()) && modified < cutoff) continue;
    const { text: xml } = await stateText(ctx, map.loc, { expect: "xml" });
    const set = parseSitemap(xml);
    if (!set || set.kind !== "urlset") throw new LibraryLayoutError(map.loc, "not a sitemap URL set");
    out.push(...set.entries);
  }
  return out;
}

/** The series' refs among sitemap entries, each page once (the id ignores case and a missing trailing slash). */
function wwwRefs(cfg: StateSeriesConfig, entries: SitemapEntry[]): DocumentRef[] {
  const byId = new Map<string, DocumentRef>();
  for (const e of entries) {
    let u: URL;
    try {
      u = new URL(e.loc);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" || u.hostname !== STATE_WWW) continue;
    const m = cfg.wwwPath.exec(u.pathname);
    if (!m || !m[2].replace(/\/+$/, "") || NOT_PUBLISHED.test(m[2])) continue;
    const id = `${STATE_WWW}${u.pathname.toLowerCase().replace(/\/?$/, "/")}`;
    const listing: WwwListing = { kind: "www", year: Number(m[1]), lastmod: e.lastmod };
    const ref: DocumentRef = {
      externalId: id,
      url: u.toString(),
      title: `${m[1]} ${cfg.seriesName}: ${m[2].replace(/\/+$/, "")}`,
      fingerprint: sha256Hex([u.toString(), e.lastmod ?? ""].join("\u0000")).slice(0, 32),
      listing,
    };
    // Keep the canonical (trailing slash) spelling when the sitemap lists both.
    const prior = byId.get(id);
    if (!prior || (!prior.url.endsWith("/") && ref.url.endsWith("/"))) byId.set(id, ref);
  }
  return [...byId.values()];
}

function wwwYear(ref: DocumentRef): number {
  return (ref.listing as WwwListing).year;
}

// ---------------------------------------------------------------------------
// 2009-2017.state.gov: the archive

async function archiveYears(ctx: LibraryAdapterContext, cfg: StateSeriesConfig): Promise<ArchiveYearLink[]> {
  const { text, response } = await stateText(ctx, cfg.archiveIndexUrl, { expect: "html" });
  const years = parseArchiveYearLinks(text, response.url, STATE_ARCHIVE, cfg.archiveYearIndexPath);
  if (years.length === 0) throw new LibraryLayoutError(cfg.archiveIndexUrl, "no links to the archive site's report years");
  return years;
}

/** A page on the archive host, following one meta refresh (the archive's way of moving a page) when it has one. */
async function archivePage(ctx: LibraryAdapterContext, url: string): Promise<{ text: string; url: string }> {
  const first = await stateText(ctx, url, { expect: "html" });
  const refresh = metaRefreshUrl(first.text, first.response.url);
  if (refresh && refresh !== first.response.url && new URL(refresh).hostname === STATE_ARCHIVE) {
    const next = await stateText(ctx, refresh, { expect: "html" });
    return { text: next.text, url: next.response.url };
  }
  return { text: first.text, url: first.response.url };
}

function archiveRef(year: ArchiveYearLink, yearTitle: string, link: ArchiveLink, kind: ArchiveListing["kind"], listedOn: string): DocumentRef {
  const u = new URL(link.url);
  const listing: ArchiveListing = { kind, year: year.year, dir: year.dir, yearText: year.text, yearTitle, listedText: link.text, region: link.region, listedOn };
  return {
    externalId: `${STATE_ARCHIVE}${u.pathname}`,
    url: link.url,
    title: `${year.text}: ${link.text}`,
    fingerprint: sha256Hex([link.url, link.text, year.text].join("\u0000")).slice(0, 32),
    listing,
  };
}

/** Every ref of one archived report year. */
async function archiveYearRefs(ctx: LibraryAdapterContext, cfg: StateSeriesConfig, year: ArchiveYearLink): Promise<DocumentRef[]> {
  const page = await archivePage(ctx, year.url);
  const yearTitle = pageTitle(page.text) ?? year.text;
  const countryPath = cfg.archiveCountryPath(year.dir);
  let countries = archiveLinks(page.text, page.url, STATE_ARCHIVE, countryPath).map((l) => ({ link: l, on: page.url }));
  const grouped: { link: ArchiveLink; on: string }[] = [];

  if (countries.length === 0 && cfg.archiveHubPath) {
    for (const hub of archiveLinks(page.text, page.url, STATE_ARCHIVE, cfg.archiveHubPath(year.dir))) {
      const hubPage = await archivePage(ctx, hub.url);
      countries.push(...archiveLinks(hubPage.text, hubPage.url, STATE_ARCHIVE, countryPath).map((l) => ({ link: l, on: hubPage.url })));
    }
  }
  if (countries.length === 0 && cfg.narratives) {
    const n = cfg.narratives;
    const groupedPath = n.groupedPath(year.dir);
    grouped.push(...archiveLinks(page.text, page.url, STATE_ARCHIVE, groupedPath, true).filter((l) => n.groupedText.test(l.text)).map((l) => ({ link: l, on: page.url })));
    const hubs = archiveLinks(page.text, page.url, STATE_ARCHIVE, n.hubPath(year.dir), true).filter((l) => n.hubText.test(l.text));
    for (const hub of hubs) {
      const hubPage = await archivePage(ctx, hub.url);
      countries.push(...archiveLinks(hubPage.text, hubPage.url, STATE_ARCHIVE, countryPath).map((l) => ({ link: l, on: hubPage.url })));
      grouped.push(
        ...archiveLinks(hubPage.text, hubPage.url, STATE_ARCHIVE, groupedPath, true)
          .filter((l) => n.groupedText.test(l.text) || (n.hubGroupedText?.test(l.text) ?? false))
          .map((l) => ({ link: l, on: hubPage.url }))
      );
    }
  }

  const seen = new Set<string>();
  const once = <T extends { link: ArchiveLink }>(list: T[]) => list.filter((x) => (seen.has(x.link.url) ? false : (seen.add(x.link.url), true)));
  countries = once(countries);
  if (countries.length > 0) return countries.map((c) => archiveRef(year, yearTitle, c.link, "archive_country", c.on));
  const groups = once(grouped);
  if (groups.length > 0) {
    ctx.note(`${year.text}: no per-country pages; ${groups.length} grouped country-narrative document(s) collected instead.`);
    return groups.map((g) => archiveRef(year, yearTitle, g.link, /\.pdf$/i.test(new URL(g.link.url).pathname) ? "archive_grouped_pdf" : "archive_grouped_page", g.on));
  }
  // Every archived year read when this collector was written (1999 to 2015, and 2001 to 2016 for trafficking) links one of the above.
  throw new LibraryLayoutError(year.url, cfg.narratives ? "no country pages and no grouped country narratives linked" : "no country pages or region pages linked");
}

// ---------------------------------------------------------------------------
// The documents

/**
 * The archived report's name for a page that does not print it: the year
 * index's title ("Trafficking in Persons Report 2014"), with the year link's
 * text after it when that title states no year ("... (2005 Report)").
 */
function yearName(listing: ArchiveListing): string {
  const title = listing.yearTitle ?? listing.yearText;
  return title.includes(String(listing.year)) ? title : `${title} (${listing.yearText})`;
}

function wwwDocument(cfg: StateSeriesConfig, ref: DocumentRef, html: string, response: LibraryDocumentInput["fetch"]): LibraryDocumentInput {
  const page = parseStateReportPage(html);
  const url = response!.response.url;
  if (!page) throw new LibraryLayoutError(url, "no report headline or report content");
  const listing = ref.listing as WwwListing | undefined;
  const reportYear = statedYear(page.headline) ?? listing?.year ?? null;
  // A sub-report's headline names its parent, an em or en dash, and the area ("Israel, West Bank and Gaza" + dash + "West Bank and Gaza").
  const named = headlineSubject(page.headline);
  const parts = named ? named.split(SUB_AREA_DASH).filter(Boolean) : [];
  const subject = parts.length > 1 ? parts[parts.length - 1] : named;
  const parentArea = parts.length > 1 ? parts[0] : null;
  const pdfUrl = page.pdfHref ? resolveUrl(page.pdfHref, url) : null;
  const tier = cfg.narratives ? statedTier(page.firstSectionTitle) : null;
  return {
    externalId: ref.externalId,
    docType: "report",
    title: page.headline,
    citations: [],
    agency: AGENCY,
    documentYear: reportYear,
    precedentialStatus: "not_applicable",
    officialUrl: url,
    text: htmlToDocumentText(page.contentHtml),
    metadata: {
      series: cfg.series,
      seriesName: cfg.seriesName,
      ...(reportYear ? { reportYear } : {}),
      ...countryFields(subject),
      ...(parentArea ? { parentArea } : {}),
      ...(tier ? { tier } : {}),
      ...(pdfUrl ? { pdfUrl } : {}),
      site: STATE_WWW,
      statedDates: page.modified ? { modified: page.modified } : {},
      ...(listing?.lastmod ? { sitemapLastmod: listing.lastmod } : {}),
    },
    fetch: response,
  };
}

function archiveDocument(cfg: StateSeriesConfig, ref: DocumentRef, listing: ArchiveListing, html: string, response: LibraryDocumentInput["fetch"]): LibraryDocumentInput {
  const url = response!.response.url;
  const page = parseArchiveReportPage(html);
  if (!page) throw new LibraryLayoutError(url, "no page heading or centre block (the archive's release template)");
  const reportName = page.reportTitle ?? yearName(listing);
  // The year the archive's link to the report states ("... for 2008", "2005 Report"); the report's own name can
  // state another year first ("Victims of Trafficking and Violence Protection Act of 2000: ... (2005 Report)").
  const reportYear = listing.year;
  // Some archived pages head themselves with the report's name too ("2008 Human Rights Report: Democratic Republic of the Congo").
  const heading = /\breport\b[^:]*:\s*\S/i.test(page.heading) ? (headlineSubject(page.heading) ?? page.heading) : page.heading;
  const isCountry = listing.kind === "archive_country";
  const pdfUrl = page.pdfHref ? resolveUrl(page.pdfHref, url) : null;
  const text = htmlToDocumentText(page.contentHtml);
  const tier = cfg.narratives && isCountry ? statedTier(text.slice(0, 300)) : null;
  return {
    externalId: ref.externalId,
    docType: "report",
    title: `${reportName}: ${heading}`,
    citations: [],
    agency: AGENCY,
    publishedDate: parseStatedDate(page.dateLong),
    documentYear: reportYear,
    precedentialStatus: "not_applicable",
    officialUrl: url,
    text,
    metadata: {
      series: cfg.series,
      seriesName: cfg.seriesName,
      reportYear,
      reportName,
      ...(isCountry ? countryFields(listing.listedText) : { countriesCovered: heading, ...countryFields(narrativeHeadingCountries(text)) }),
      ...(listing.region ? { regionFolder: listing.region } : {}),
      ...(tier ? { tier } : {}),
      ...(page.bureau ? { bureau: page.bureau } : {}),
      ...(pdfUrl ? { pdfUrl } : {}),
      ...(page.htmlTitle ? { pageTitle: page.htmlTitle } : {}),
      site: STATE_ARCHIVE,
      listedOn: listing.listedOn,
      statedDates: page.dateLong ? { released: page.dateLong } : {},
    },
    fetch: response,
  };
}

async function fetchStateDocument(ctx: LibraryAdapterContext, cfg: StateSeriesConfig, ref: DocumentRef): Promise<FetchDocumentResult> {
  const listing = ref.listing as WwwListing | ArchiveListing | undefined;
  if (listing?.kind === "archive_grouped_pdf") {
    const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const pdf = await extractPdfText(response.body);
    if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    const label = listing.listedText.replace(/\s*\(PDF\)\s*$/i, "").trim();
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "report",
        title: `${yearName(listing)}: ${label}`,
        citations: [],
        agency: AGENCY,
        documentYear: listing.year,
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text: pdf.pagesWithText > 0 ? pdf.text : "",
        textKind: pdf.pagesWithText > 0 ? "full" : "none",
        metadata: {
          series: cfg.series,
          seriesName: cfg.seriesName,
          reportYear: listing.year,
          countriesCovered: label,
          ...countryFields(narrativeHeadingCountries(pdf.text)),
          listedText: listing.listedText,
          site: STATE_ARCHIVE,
          listedOn: listing.listedOn,
          pageCount: pdf.pageCount,
          ...(pdf.pagesWithText === 0 ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}),
        },
        original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
        fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
      },
    };
  }
  const { text, response } = await stateText(ctx, ref.url, { expect: "html", conditional: ref.known ?? null });
  if (response.notModified) return { kind: "not_modified" };
  const host = new URL(response.url).hostname;
  if (listing && listing.kind !== "www") return { kind: "document", document: archiveDocument(cfg, ref, listing, text, { response }) };
  if (host !== STATE_WWW) return { kind: "skip", reason: `${ref.url} led to ${response.url}, off www.state.gov.` };
  return { kind: "document", document: wwwDocument(cfg, ref, text, { response }) };
}

// ---------------------------------------------------------------------------
// The adapter

export function stateReportsAdapter(cfg: StateSeriesConfig): LibrarySourceAdapter {
  return {
    code: cfg.code,
    group: "country-conditions",
    name: cfg.name,
    description: cfg.description,
    coverage: cfg.coverage,
    cadence: "Each annual release; the State Department's sitemaps are checked daily",
    officialUrl: cfg.officialUrl,
    hosts: STATE_HOSTS,
    license: "public_domain",
    staleAfterHours: 72,
    recheckAfterDays: 90,
    maxDocumentsPerDailyRun: 300,

    async listUpdates(ctx, since) {
      // Two days of margin: lastmod times are the site's, and a run can start late.
      const cutoff = since ? new Date(since.getTime() - 2 * 24 * 60 * 60 * 1000) : null;
      const refs = wwwRefs(cfg, await reportSitemapEntries(ctx, cutoff));
      if (!cutoff) {
        // The first run takes the newest report year as its baseline; backfill walks the rest.
        const newest = Math.max(0, ...refs.map(wwwYear));
        return { refs: refs.filter((r) => wwwYear(r) === newest) };
      }
      return {
        refs: refs.filter((r) => {
          const lastmod = (r.listing as WwwListing).lastmod;
          const t = lastmod ? new Date(lastmod).getTime() : NaN;
          return Number.isNaN(t) || t >= cutoff.getTime();
        }),
      };
    },

    async backfill(ctx, cursor): Promise<BackfillChunk> {
      let state: Cursor | null = isCursor(cursor) ? cursor : null;
      // The first chunk reads the sitemaps once, for the years and for the newest year's pages.
      let listed: DocumentRef[] | null = null;
      if (!state) {
        listed = wwwRefs(cfg, await reportSitemapEntries(ctx, null));
        const years = [...new Set(listed.map(wwwYear))].sort((a, b) => b - a);
        if (years.length === 0) throw new LibraryLayoutError(SITEMAP_INDEX, `no ${cfg.seriesName} pages in the report sitemaps`);
        state = { phase: "www", years, offset: 0 };
      }

      if (state.phase === "www") {
        const year = state.years[0];
        if (year === undefined) {
          const dirs = (await archiveYears(ctx, cfg)).map((y) => y.dir);
          return { refs: [], nextCursor: { phase: "archive", dirs, offset: 0 }, progress: `www.state.gov done; ${dirs.length} archived report year(s) next` };
        }
        const all = (listed ?? wwwRefs(cfg, await reportSitemapEntries(ctx, null)))
          .filter((r) => wwwYear(r) === year)
          .sort((a, b) => a.externalId.localeCompare(b.externalId));
        if (all.length === 0) ctx.note(`The ${year} ${cfg.seriesName} is no longer in the sitemaps; skipped.`);
        const refs = all.slice(state.offset, state.offset + CHUNK);
        const nextOffset = state.offset + CHUNK;
        const nextCursor: Cursor =
          nextOffset < all.length ? { phase: "www", years: state.years, offset: nextOffset } : { phase: "www", years: state.years.slice(1), offset: 0 };
        return {
          refs,
          nextCursor,
          progress: `www.state.gov ${year}: pages ${state.offset + 1} to ${state.offset + refs.length} of ${all.length}; ${state.years.length - 1} more year(s) there, then the archive`,
        };
      }

      const dir = state.dirs[0];
      if (dir === undefined) return { refs: [], nextCursor: null, progress: "every report year on both sites is done" };
      const link = (await archiveYears(ctx, cfg)).find((y) => y.dir === dir);
      const rest: Cursor | null = state.dirs.length > 1 ? { phase: "archive", dirs: state.dirs.slice(1), offset: 0 } : null;
      if (!link) {
        ctx.note(`The archived report "${dir}" is no longer linked from ${cfg.archiveIndexUrl}; skipped.`);
        return { refs: [], nextCursor: rest, progress: `archive ${dir} skipped` };
      }
      const all = await archiveYearRefs(ctx, cfg, link);
      const refs = all.slice(state.offset, state.offset + CHUNK);
      const nextOffset = state.offset + CHUNK;
      return {
        refs,
        nextCursor: nextOffset < all.length ? { phase: "archive", dirs: state.dirs, offset: nextOffset } : rest,
        progress: `${STATE_ARCHIVE} ${link.text}: pages ${state.offset + 1} to ${state.offset + refs.length} of ${all.length}; ${state.dirs.length - 1} more archived year(s)`,
      };
    },

    fetchDocument(ctx, ref) {
      return fetchStateDocument(ctx, cfg, ref);
    },

    // Import from the official site (../../manual-import.ts): a country's
    // page of a www.state.gov report year, saved as HTML. The ref is the one
    // the sitemap listing builds for that address (the sitemap's lastmod,
    // which only the sitemap states, is left out). The archive site's pages
    // are not taken: their report and country names come from its year
    // index pages, and the archive no longer changes.
    manualImportPaths: [
      {
        path: cfg.wwwPath,
        hosts: [STATE_WWW],
        file: "html",
        role: "document",
        label: `A country's page of a ${cfg.seriesName} on www.state.gov (https://www.state.gov/reports/...), saved as HTML`,
      },
    ],
    manualImportIntervalDays: 400,
    async parseImported(ctx, input) {
      const [ref] = wwwRefs(cfg, [{ loc: input.url, lastmod: null }]);
      if (!ref) return { kind: "skip", reason: `${input.url} is not a published country page of the ${cfg.seriesName} (drafts, templates and samples are not part of the report).` };
      return fetchStateDocument(ctx, cfg, { ...ref, url: input.url });
    },
  };
}
