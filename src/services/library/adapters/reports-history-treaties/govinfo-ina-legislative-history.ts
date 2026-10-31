import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fetchPdf, fingerprintOf, isMissing, isTooLarge, readSitemap } from "./common";
import { classifyStatuteLaw, govinfoHtmlText, parseCommitteeReportMods, parseStatuteVolumeMods, type StatuteGranule } from "./parse";
import type { SitemapEntry } from "./parse";

// The legislative history of the Immigration and Nationality Act from its
// enactment in 1952 through 2007, from GovInfo's official copies:
//
// - Statutory history: the public laws on immigration in the United States
//   Statutes at Large (GovInfo's STATUTE collection), volumes 66 (1952)
//   through 121 (2007). Each volume's MODS record lists every law it prints
//   with its title, long titles, short titles, Public Law number, date of
//   approval, the committee reports and bills its legislative-history note
//   names, and the PDF of the law as printed. A public law is kept when its
//   title, a long title or a short title uses an immigration term
//   (./parse.ts, classifyStatuteLaw), or a short title or name-index
//   title is one of the immigration Acts whose names use none
//   (knownImmigrationActs: the REAL ID
//   Act, NACARA, the trafficking and violence-against-women laws that made
//   the T and U visas, and others); private laws ("for the relief of")
//   and commemorative resolutions are left out. The document is the law's
//   text as printed in the Statutes at Large.
// - Committee reports: the House and Senate reports the Statutes at Large
//   record names for those laws, when the law itself is an immigration law
//   (its title or a long title uses an immigration term). For an omnibus law
//   that only contains an immigration Act (Pub. L. 104-208 holds IIRIRA),
//   the reports named are on the vehicle bill (there, the Defense
//   appropriations bill), so they are not collected. Each report is resolved
//   with GovInfo's link service, the documented way to reach a GovInfo
//   document from its citation (https://www.govinfo.gov/link-docs/): it
//   leads to the report's MODS record in the Congressional Reports (CRPT)
//   collection (104th Congress on) or in the digitized Serial Set (some
//   earlier Congresses), and the text is read from the record's HTML or PDF
//   rendition. A report GovInfo has no copy of is skipped with a note.
// - The volume MODS record is at https://www.govinfo.gov/metadata/pkg/<package ID>/mods.xml,
//   the "MODS" link every GovInfo details page prints for its package; it is
//   built from the package ID the sitemap gives. Every other link stored is
//   the one a MODS record states.
// - Daily: the STATUTE sitemap index, then the year sitemaps (1952 to 2007)
//   and volumes whose lastmod moved since the last run (the volumes are
//   printed; GovInfo rarely touches them); the first daily run lists
//   nothing, the history being the backfill's. Backfill: the same volumes,
//   newest first, VOLUMES_PER_CHUNK per chunk.
//
// US government works: public domain, stored in full.

const INDEX_URL = "https://www.govinfo.gov/sitemap/STATUTE_sitemap_index.xml";
const HOSTS = ["www.govinfo.gov"] as const;
const SITEMAP_RE = /\/STATUTE_(\d{4})_sitemap\.xml$/;
const PACKAGE_RE = /\/app\/details\/(STATUTE-\d+)$/;
const FIRST_YEAR = 1952;
const LAST_YEAR = 2007;
/** Volume 66 (1952) prints the INA; volume 121 is 2007. A year sitemap can list two volumes. */
const FIRST_VOLUME = 66;
const LAST_VOLUME = 121;
const VOLUMES_PER_CHUNK = 3;
/** The PDF cap for the Statutes at Large and committee reports (page scans: a Serial Set report runs to 80 MB). */
const SCAN_MAX_BYTES = 160 * 1024 * 1024;

function ordinal(n: string): string {
  const v = Number(n) % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : (["th", "st", "nd", "rd"][v % 10] ?? "th");
  return `${n}${suffix}`;
}

type ActListing = {
  kind: "act";
  packageId: string;
  granule: StatuteGranule;
  matchedTerms: string[];
  /** The committee reports collected with this law (empty when the law only contains an immigration Act). */
  reportIds: string[];
};
type ReportListing = {
  kind: "report";
  congress: string;
  number: string;
  chamber: "H" | "S";
  acts: { accessId: string; title: string; citation: string | null; publicLaw: string | null }[];
};
type Cursor = { sitemaps: string[] };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && Array.isArray(c.sitemaps) && c.sitemaps.every((s) => typeof s === "string" && SITEMAP_RE.test(s));
}

function reportId(r: { congress: string; number: string; chamber: "H" | "S" }): string {
  return `${r.chamber === "H" ? "H. Rept." : "S. Rept."} ${r.congress}-${r.number}`;
}

/** GovInfo's link service for a committee report's MODS record (see the file comment). */
function reportLinkUrl(r: { congress: string; number: string; chamber: "H" | "S" }): string {
  return `https://www.govinfo.gov/link/crpt/${encodeURIComponent(r.congress)}/${r.chamber === "H" ? "hrpt" : "srpt"}/${encodeURIComponent(r.number)}?link-type=mods`;
}

function volumeModsUrl(packageId: string): string {
  return `https://www.govinfo.gov/metadata/pkg/${encodeURIComponent(packageId)}/mods.xml`;
}

async function readIndex(ctx: LibraryAdapterContext): Promise<SitemapEntry[]> {
  const index = await readSitemap(ctx, INDEX_URL);
  const years = index.entries.filter((e) => {
    const m = SITEMAP_RE.exec(e.loc);
    return m && Number(m[1]) >= FIRST_YEAR && Number(m[1]) <= LAST_YEAR;
  });
  if (index.kind !== "index" || years.length === 0) throw new LibraryLayoutError(INDEX_URL, `no STATUTE_<year>_sitemap.xml entries for ${FIRST_YEAR} to ${LAST_YEAR}`);
  return years.sort((a, b) => Number(SITEMAP_RE.exec(b.loc)![1]) - Number(SITEMAP_RE.exec(a.loc)![1]));
}

async function readYear(ctx: LibraryAdapterContext, url: string): Promise<{ packageId: string; lastmod: string | null }[]> {
  const sitemap = await readSitemap(ctx, url);
  const packages: { packageId: string; lastmod: string | null }[] = [];
  for (const e of sitemap.entries) {
    const m = PACKAGE_RE.exec(e.loc);
    if (m) packages.push({ packageId: m[1], lastmod: e.lastmod });
  }
  if (sitemap.kind !== "urlset" || packages.length === 0) throw new LibraryLayoutError(url, "no STATUTE volume details links");
  return packages.filter((p) => {
    const volume = Number(p.packageId.replace(/^STATUTE-/, ""));
    return volume >= FIRST_VOLUME && volume <= LAST_VOLUME;
  });
}

/** The refs of one Statutes at Large volume: its immigration public laws and the reports named for the immigration laws among them. */
async function readVolume(ctx: LibraryAdapterContext, packageId: string, reports: Map<string, DocumentRef>): Promise<DocumentRef[]> {
  const url = volumeModsUrl(packageId);
  const { text } = await ctx.http.getText(url, { expect: "xml", timeoutMs: 120_000 });
  const parsed = parseStatuteVolumeMods(text);
  if (!parsed.recognized) throw new LibraryLayoutError(url, "not a STATUTE package MODS record");
  const publicLaws = parsed.granules.filter((g) => g.granuleClass === "PUBLICLAW");
  if (publicLaws.length === 0) throw new LibraryLayoutError(url, "no PUBLICLAW granules in the volume record");
  const refs: DocumentRef[] = [];
  for (const g of publicLaws) {
    const law = classifyStatuteLaw(g);
    if (!law) continue;
    if (!g.links.pdf) {
      ctx.note(`${g.accessId} (${g.title}): the volume record links no PDF; left out.`);
      continue;
    }
    // Reports only for a law that is itself on immigration (see the file comment).
    const lawReports = law.ownTitle ? g.reports : [];
    const listing: ActListing = { kind: "act", packageId, granule: g, matchedTerms: law.terms, reportIds: lawReports.map(reportId) };
    refs.push({
      externalId: g.accessId,
      url: g.links.pdf,
      title: `${g.citation ?? g.accessId} ${g.title}`,
      fingerprint: fingerprintOf(g.title, g.citation, g.publicLaw, g.approvedDate, g.links.pdf, g.shortTitles.join("|"), g.longTitles.join("|"), listing.reportIds.join("|")),
      listing,
    });
    for (const r of lawReports) {
      const id = reportId(r);
      const act = { accessId: g.accessId, title: g.title, citation: g.citation, publicLaw: g.publicLaw };
      const existing = reports.get(id);
      if (existing) {
        (existing.listing as ReportListing).acts.push(act);
        existing.fingerprint = fingerprintOf(id, (existing.listing as ReportListing).acts.map((a) => a.accessId).join("|"));
        continue;
      }
      const reportListing: ReportListing = { kind: "report", congress: r.congress, number: r.number, chamber: r.chamber, acts: [act] };
      const ref: DocumentRef = { externalId: id, url: reportLinkUrl(r), title: `${id} (on ${g.citation ?? g.accessId})`, fingerprint: fingerprintOf(id, g.accessId), listing: reportListing };
      reports.set(id, ref);
      refs.push(ref);
    }
  }
  return refs;
}

async function fetchAct(ctx: LibraryAdapterContext, ref: DocumentRef, listing: ActListing): Promise<FetchDocumentResult> {
  const g = listing.granule;
  let pdf: Awaited<ReturnType<typeof fetchPdf>>;
  try {
    // The Statutes at Large are page scans with a text layer; an omnibus law runs to hundreds of pages.
    pdf = await fetchPdf(ctx, ref.url, ref.known, { label: ref.externalId, maxBytes: SCAN_MAX_BYTES, timeoutMs: 300_000 });
  } catch (err) {
    if (!isTooLarge(err)) throw err;
    return { kind: "skip", reason: `${ref.externalId}: the Statutes at Large PDF is larger than ${SCAN_MAX_BYTES / 1024 / 1024} MB; not read.` };
  }
  if (pdf === "not_modified") return { kind: "not_modified" };
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "legislative_history",
      title: g.title,
      citations: [g.citation, g.publicLaw].filter((c): c is string => Boolean(c)),
      agency: "United States Congress",
      // The date the law was approved, as the Statutes at Large record states it.
      decisionDate: g.approvedDate,
      precedentialStatus: "not_applicable",
      officialUrl: g.links.details ?? pdf.response.url,
      originalUrl: pdf.response.url,
      text: pdf.text,
      textKind: pdf.textKind,
      metadata: {
        historyKind: "enacted law (United States Statutes at Large)",
        packageId: listing.packageId,
        granuleId: g.accessId,
        ...(g.publicLaw ? { publicLaw: g.publicLaw } : {}),
        ...(g.citation ? { statutesAtLarge: g.citation } : {}),
        ...(g.congress ? { congress: g.congress } : {}),
        ...(g.volume ? { volume: g.volume } : {}),
        ...(g.pageStart ? { pages: g.pageEnd && g.pageEnd !== g.pageStart ? `${g.pageStart}-${g.pageEnd}` : g.pageStart } : {}),
        longTitles: g.longTitles,
        shortTitles: g.shortTitles,
        nameIndexTitles: g.indexTitles,
        committeeReports: g.reports.map(reportId),
        committeeReportsCollected: listing.reportIds,
        bills: g.bills.map((b) => `${b.type} ${b.number}, ${ordinal(b.congress)} Congress${b.priority ? ` (${b.priority})` : ""}`),
        committees: g.committees,
        matchedTerms: listing.matchedTerms,
        statedDates: g.approvedDate ? { approved: g.approvedDate } : {},
        pageCount: pdf.pageCount,
        ...(pdf.noTextLayer ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}),
      },
      original: pdf.original,
      fetch: pdf.fetch,
    },
  };
}

async function fetchReport(ctx: LibraryAdapterContext, ref: DocumentRef, listing: ReportListing): Promise<FetchDocumentResult> {
  let xml: string;
  let modsResponseUrl: string;
  try {
    const { text, response } = await ctx.http.getText(ref.url, { expect: "xml" });
    xml = text;
    modsResponseUrl = response.url;
  } catch (err) {
    if (!isMissing(err)) throw err;
    return { kind: "skip", reason: `${ref.externalId}: GovInfo holds no copy of this report (its link service answered ${(err as { code?: string }).code}).` };
  }
  const mods = parseCommitteeReportMods(xml);
  if (!mods) throw new LibraryLayoutError(modsResponseUrl, "not a CRPT or Serial Set MODS record");
  const metadata: Record<string, unknown> = {
    historyKind: "committee report",
    collection: mods.collection,
    packageId: mods.accessId,
    ...(mods.docClass ? { reportClass: mods.docClass } : {}),
    ...(mods.congress ? { congress: mods.congress } : {}),
    ...(mods.session ? { session: mods.session } : {}),
    ...(mods.serialSetNumber ? { serialSetNumber: mods.serialSetNumber } : {}),
    ...(mods.subtitle ? { subtitle: mods.subtitle } : {}),
    committees: mods.committees,
    accompanies: listing.acts,
    modsUrl: modsResponseUrl,
    statedDates: mods.dateIssued ? { issued: mods.dateIssued } : mods.year ? { year: String(mods.year) } : {},
  };
  const base = {
    externalId: ref.externalId,
    docType: "legislative_history" as const,
    title: mods.title,
    citations: [ref.externalId],
    agency: "United States Congress",
    publishedDate: mods.dateIssued,
    documentYear: mods.year,
    precedentialStatus: "not_applicable" as const,
  };
  const known = ref.known ?? null;
  if (mods.links.html) {
    const { text: html, response } = await ctx.http.getText(mods.links.html, { expect: "html", conditional: known });
    if (response.notModified) return { kind: "not_modified" };
    const text = govinfoHtmlText(html);
    return {
      kind: "document",
      document: { ...base, officialUrl: mods.links.details ?? response.url, originalUrl: response.url, text, textKind: text ? "full" : "none", metadata, fetch: { response } },
    };
  }
  if (!mods.links.pdf) return { kind: "skip", reason: `${ref.externalId}: GovInfo's record (${mods.accessId}) links no HTML or PDF rendition.` };
  let pdf: Awaited<ReturnType<typeof fetchPdf>>;
  try {
    // Serial Set reports are page scans with a text layer, often over the default 60 MB PDF cap.
    pdf = await fetchPdf(ctx, mods.links.pdf, known, { label: ref.externalId, maxBytes: SCAN_MAX_BYTES, timeoutMs: 300_000 });
  } catch (err) {
    if (!isTooLarge(err)) throw err;
    return { kind: "skip", reason: `${ref.externalId}: GovInfo's PDF (${mods.accessId}) is larger than ${SCAN_MAX_BYTES / 1024 / 1024} MB; not read.` };
  }
  if (pdf === "not_modified") return { kind: "not_modified" };
  return {
    kind: "document",
    document: {
      ...base,
      officialUrl: mods.links.details ?? pdf.response.url,
      originalUrl: pdf.response.url,
      text: pdf.text,
      textKind: pdf.textKind,
      metadata: { ...metadata, pageCount: pdf.pageCount, ...(pdf.noTextLayer ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}) },
      original: pdf.original,
      fetch: pdf.fetch,
    },
  };
}

export const govinfoInaLegislativeHistoryAdapter: LibrarySourceAdapter = {
  code: "govinfo_ina_legislative_history",
  group: "ina-legislative-history",
  name: "INA legislative history, 1952 to 2007 (GovInfo)",
  description:
    "The immigration laws enacted from the Immigration and Nationality Act of 1952 through 2007 as printed in the United States Statutes at Large, with the House and Senate committee reports their legislative-history notes name, from GovInfo's official copies.",
  coverage:
    "Public laws on immigration in Statutes at Large volumes 66 to 121 (1952 to 2007), chosen by their titles, and the committee reports named for them that GovInfo holds (the Congressional Reports collection from the 104th Congress, and the digitized Serial Set for some earlier Congresses). Hearings, floor debates and reports on the bills of omnibus laws are not collected.",
  cadence: "Static; checked daily for GovInfo corrections",
  officialUrl: "https://www.govinfo.gov/app/collection/statute",
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 24 * 8,
  recheckAfterDays: 365,

  async listUpdates(ctx, since) {
    const years = await readIndex(ctx);
    if (!since) {
      // The first daily run would otherwise read every volume record (56 large MODS files) and
      // fetch hundreds of scanned laws: that is the backfill's work, paced in chunks.
      ctx.note("The volumes are read by the backfill; the daily run follows the volumes GovInfo changes after it.");
      return { refs: [] };
    }
    const reports = new Map<string, DocumentRef>();
    const refs: DocumentRef[] = [];
    for (const year of years) {
      if (year.lastmod && new Date(year.lastmod) <= since) continue;
      for (const p of await readYear(ctx, year.loc)) {
        if (p.lastmod && new Date(p.lastmod) <= since) continue;
        refs.push(...(await readVolume(ctx, p.packageId, reports)));
      }
    }
    return { refs };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const state: Cursor = isCursor(cursor) ? cursor : { sitemaps: (await readIndex(ctx)).map((y) => y.loc) };
    if (state.sitemaps.length === 0) return { refs: [], nextCursor: null, progress: "every volume is done" };
    const now = state.sitemaps.slice(0, VOLUMES_PER_CHUNK);
    const reports = new Map<string, DocumentRef>();
    const refs: DocumentRef[] = [];
    const done: string[] = [];
    for (const sitemap of now) {
      const year = SITEMAP_RE.exec(sitemap)![1];
      let packages: { packageId: string }[];
      try {
        packages = await readYear(ctx, sitemap);
      } catch (err) {
        if (!isMissing(err)) throw err;
        ctx.note(`${sitemap} is gone (the index no longer lists ${year}); skipped.`);
        continue;
      }
      for (const p of packages) refs.push(...(await readVolume(ctx, p.packageId, reports)));
      done.push(year);
    }
    const rest = state.sitemaps.slice(now.length);
    return { refs, nextCursor: rest.length ? { sitemaps: rest } : null, progress: `years ${done.join(", ") || "(none)"}: ${refs.length} law(s) and report(s); ${rest.length} more year(s) after this chunk` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as ActListing | ReportListing | undefined;
    if (listing?.kind === "act" && listing.granule) return fetchAct(ctx, ref, listing);
    if (listing?.kind === "report") return fetchReport(ctx, ref, listing);
    return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
  },
};
