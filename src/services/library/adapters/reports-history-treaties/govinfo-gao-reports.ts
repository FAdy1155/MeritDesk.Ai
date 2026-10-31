import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fetchPdf, fingerprintOf, isMissing, readSitemap } from "./common";
import { govinfoHtmlText, immigrationTerms, isImmigrationMatch, parseGaoReportMods, type GaoReportMods } from "./parse";
import type { SitemapEntry } from "./parse";

// GAO reports on immigration from 1989 to 2008, from GovInfo's GAO Reports
// and Comptroller General Decisions collection (GAOREPORTS), which GPO
// keeps as an archive (its sitemap index lists one sitemap per year, 1989
// to 2008, and no new years).
//
// - Listing: GovInfo's public sitemaps (sitemap index, then one sitemap per
//   year, then one details page per package, "GAOREPORTS-GAO-05-399"). The
//   sitemaps carry no titles, so each package's MODS record is read to
//   decide: a report is kept when its title or GAO's subject terms use an
//   immigration term (./parse.ts, immigrationTerms; "border security" alone, which GAO also uses
//   for port and maritime security, does not decide). Comptroller General
//   decisions (B- numbers) are left out: they are bid protests and
//   appropriations-law opinions, not reports.
// - The MODS record of a package is at
//   https://www.govinfo.gov/metadata/pkg/<package ID>/mods.xml, the "MODS"
//   link every GovInfo details page prints for its package; it is built from
//   the package ID the sitemap gives instead of reading each details page for
//   the same link, which would double the requests. Every other link stored
//   (the HTML and PDF renditions, the details page) is the one the MODS
//   record states.
// - Daily: the sitemap index, and the packages whose own lastmod is after
//   the last run (the collection is an archive: usually none). The history
//   is read by the backfill.
// - Backfill: year by year, newest first, PACKAGES_PER_CHUNK MODS records per
//   chunk (GovInfo sets no Crawl-delay: about one request a second, so a
//   chunk reads for about 15 minutes).
// - Text: the HTML rendition (GAO's text as GovInfo holds it), else the PDF.
//
// US government work: public domain, stored in full.

const INDEX_URL = "https://www.govinfo.gov/sitemap/GAOREPORTS_sitemap_index.xml";
const HOSTS = ["www.govinfo.gov"] as const;
const SITEMAP_RE = /\/GAOREPORTS_(\d{4})_sitemap\.xml$/;
const PACKAGE_RE = /\/app\/details\/(GAOREPORTS-[A-Za-z0-9._-]+)$/;
const PACKAGES_PER_CHUNK = 800;
const AGENCY = "U.S. Government Accountability Office";

/** `size` (optional) overrides PACKAGES_PER_CHUNK, for a probe of a few packages. */
type Cursor = { sitemaps: string[]; offset: number; size?: number };
type Listing = { mods: GaoReportMods; modsUrl: string; matchedTerms: string[] };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && Array.isArray(c.sitemaps) && c.sitemaps.every((s) => typeof s === "string" && SITEMAP_RE.test(s)) && Number.isInteger(c.offset) && c.offset >= 0 && (c.size === undefined || (Number.isInteger(c.size) && c.size > 0 && c.size <= PACKAGES_PER_CHUNK));
}

function modsUrl(packageId: string): string {
  return `https://www.govinfo.gov/metadata/pkg/${encodeURIComponent(packageId)}/mods.xml`;
}

async function readIndex(ctx: LibraryAdapterContext): Promise<SitemapEntry[]> {
  const index = await readSitemap(ctx, INDEX_URL);
  const years = index.entries.filter((e) => SITEMAP_RE.test(e.loc));
  if (index.kind !== "index" || years.length === 0) throw new LibraryLayoutError(INDEX_URL, "no GAOREPORTS_<year>_sitemap.xml entries");
  return years.sort((a, b) => Number(SITEMAP_RE.exec(b.loc)![1]) - Number(SITEMAP_RE.exec(a.loc)![1]));
}

async function readYear(ctx: LibraryAdapterContext, url: string): Promise<{ packageId: string; lastmod: string | null }[]> {
  const sitemap = await readSitemap(ctx, url);
  if (sitemap.kind !== "urlset") throw new LibraryLayoutError(url, "not a urlset");
  const packages: { packageId: string; lastmod: string | null }[] = [];
  for (const e of sitemap.entries) {
    const m = PACKAGE_RE.exec(e.loc);
    if (m) packages.push({ packageId: m[1], lastmod: e.lastmod });
  }
  if (sitemap.entries.length > 0 && packages.length === 0) throw new LibraryLayoutError(url, "no GAOREPORTS details links");
  return packages;
}

/** A package's ref when its MODS record is an immigration report; null otherwise (and when GovInfo no longer has it). */
async function packageRef(ctx: LibraryAdapterContext, packageId: string): Promise<DocumentRef | null> {
  // Comptroller General decisions: bid protests and appropriations law, not reports.
  if (/^GAOREPORTS-B-/i.test(packageId)) return null;
  const url = modsUrl(packageId);
  let xml: string;
  try {
    ({ text: xml } = await ctx.http.getText(url, { expect: "xml" }));
  } catch (err) {
    if (!isMissing(err)) throw err;
    ctx.note(`${packageId}: GovInfo has no MODS record for it any more; left out.`);
    return null;
  }
  const mods = parseGaoReportMods(xml);
  if (!mods) throw new LibraryLayoutError(url, "not a GAOREPORTS MODS record");
  const terms = immigrationTerms([mods.title, ...mods.subjects].join("\n"));
  if (!isImmigrationMatch(terms)) return null;
  const fileUrl = mods.links.html ?? mods.links.pdf;
  if (!fileUrl) {
    ctx.note(`${packageId}: the MODS record links no HTML or PDF rendition; left out.`);
    return null;
  }
  const listing: Listing = { mods, modsUrl: url, matchedTerms: terms };
  return {
    externalId: mods.accessId,
    url: fileUrl,
    title: `${mods.reportNumber ?? mods.accessId} ${mods.title}`,
    fingerprint: fingerprintOf(mods.title, mods.reportNumber, mods.dateIssued, mods.abstract, mods.links.html, mods.links.pdf, mods.subjects.join("|")),
    listing,
  };
}

export const govinfoGaoReportsAdapter: LibrarySourceAdapter = {
  code: "govinfo_gao_immigration_reports",
  group: "oversight-reports",
  name: "GAO reports on immigration, 1989 to 2008 (GovInfo)",
  description:
    "GAO reports and testimonies on immigration from GovInfo's GAO Reports collection, chosen by their titles and GAO's subject terms, with GAO's abstract and the full text GovInfo holds.",
  coverage:
    "Reports in GovInfo's GAOREPORTS collection (1989 to 2008, as GovInfo's sitemaps list them) whose title or subject terms concern immigration; Comptroller General decisions are not collected.",
  cadence: "Checked daily; GovInfo keeps the collection as an archive",
  officialUrl: "https://www.govinfo.gov/app/collection/gaoreports",
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 24 * 8,
  recheckAfterDays: 365,

  async listUpdates(ctx, since) {
    const years = await readIndex(ctx);
    if (!since) {
      ctx.note("The history of this archive is read by the backfill; the daily run follows packages GovInfo changes after it.");
      return { refs: [] };
    }
    const refs: DocumentRef[] = [];
    for (const year of years) {
      if (!year.lastmod || new Date(year.lastmod) <= since) continue;
      for (const p of await readYear(ctx, year.loc)) {
        if (p.lastmod && new Date(p.lastmod) <= since) continue;
        const ref = await packageRef(ctx, p.packageId);
        if (ref) refs.push(ref);
      }
    }
    return { refs };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const state: Cursor = isCursor(cursor) ? cursor : { sitemaps: (await readIndex(ctx)).map((y) => y.loc), offset: 0 };
    const sitemap = state.sitemaps[0];
    if (!sitemap) return { refs: [], nextCursor: null, progress: "every year is done" };
    const year = SITEMAP_RE.exec(sitemap)![1];
    let packages: { packageId: string; lastmod: string | null }[];
    try {
      packages = await readYear(ctx, sitemap);
    } catch (err) {
      if (!isMissing(err)) throw err;
      ctx.note(`${sitemap} is gone (the index no longer lists ${year}); skipped.`);
      return { refs: [], nextCursor: state.sitemaps.length > 1 ? { sitemaps: state.sitemaps.slice(1), offset: 0 } : null };
    }
    const size = state.size ?? PACKAGES_PER_CHUNK;
    const slice = packages.slice(state.offset, state.offset + size);
    const refs: DocumentRef[] = [];
    for (const p of slice) {
      if (ctx.signal.aborted) break;
      const ref = await packageRef(ctx, p.packageId);
      if (ref) refs.push(ref);
    }
    const nextOffset = state.offset + size;
    const nextCursor: Cursor | null =
      nextOffset < packages.length ? { ...state, offset: nextOffset } : state.sitemaps.length > 1 ? { ...state, sitemaps: state.sitemaps.slice(1), offset: 0 } : null;
    return {
      refs,
      nextCursor,
      progress: `${year}: packages ${state.offset + 1} to ${state.offset + slice.length} of ${packages.length} read, ${refs.length} immigration report(s); ${state.sitemaps.length - 1} more year(s) after this one`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.mods?.accessId) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const mods = listing.mods;
    const statedDates = mods.dateIssued ? { issued: mods.dateIssued } : {};
    const metadata: Record<string, unknown> = {
      ...(mods.reportNumber ? { reportNumber: mods.reportNumber } : {}),
      packageId: mods.accessId,
      ...(mods.productType ? { productType: mods.productType } : {}),
      subjects: mods.subjects,
      ...(mods.abstract ? { summary: mods.abstract, summaryKind: "abstract" } : {}),
      ...(mods.sudoc ? { sudocClass: mods.sudoc } : {}),
      ...(mods.pages ? { extent: mods.pages } : {}),
      ...(mods.links.details ? { detailsPage: mods.links.details } : {}),
      ...(mods.links.pdf ? { pdfUrl: mods.links.pdf } : {}),
      modsUrl: listing.modsUrl,
      matchedTerms: listing.matchedTerms,
      statedDates,
    };
    const base = {
      externalId: ref.externalId,
      docType: "report" as const,
      title: mods.title,
      citations: mods.reportNumber ? [mods.reportNumber] : [],
      agency: AGENCY,
      publishedDate: mods.dateIssued,
      precedentialStatus: "not_applicable" as const,
      officialUrl: mods.links.details ?? ref.url,
    };
    if (ref.url === mods.links.html) {
      const { text: html, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
      if (response.notModified) return { kind: "not_modified" };
      const text = govinfoHtmlText(html);
      return {
        kind: "document",
        document: { ...base, originalUrl: response.url, text, textKind: text ? "full" : "none", metadata, fetch: { response } },
      };
    }
    const pdf = await fetchPdf(ctx, ref.url, ref.known, { label: ref.externalId });
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
