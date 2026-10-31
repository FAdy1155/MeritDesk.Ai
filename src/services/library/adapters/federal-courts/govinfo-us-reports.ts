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
import { isGone } from "./govinfo";
import {
  immigrationTermsIn,
  modsLinkFromDetailsPage,
  opinionParts,
  packageIdFromDetailsUrl,
  parseSitemap,
  parseUsReportsVolumeMods,
  pdfPages,
  syllabusText,
  usReportsHasSubjectData,
  usReportsImmigrationReasons,
  usReportsVolumeOf,
  type SitemapEntry,
  type UsReportsCase,
} from "./parse";

// The United States Reports as GovInfo publishes them (collection
// USREPORTS: the official bound volumes, 1 U.S. onward, digitized with the
// Library of Congress; https://www.govinfo.gov/app/collection/usreports),
// read without an API key from GovInfo's public sitemaps:
//
//   sitemap index → one sitemap per year → the volumes (packages) issued
//   that year → each volume's details page → its MODS record (the link the
//   page prints) → the cases in the volume, each with its own PDF.
//
// The MODS record carries, for each case, the Law Library of Congress and
// Supreme Court Database subject headings, parties, agency and statutes.
// The collector keeps the immigration cases among them
// (parse.ts, usReportsImmigrationReasons: an alien or the INS as a party,
// the INS or the Board of Immigration Appeals as the agency below, the
// immigration acts, subjects such as Immigration, Deportation, Aliens,
// Naturalization, the Chinese Exclusion Act). The newest volumes carry no
// subject data yet: their cases are listed and kept only when the syllabus
// (or, without one, the opening of the opinion) uses an immigration term.
//
// - Daily: the sitemaps whose lastmod moved since the last run, and in them
//   the volumes whose lastmod moved (a new volume is a few times a year).
// - Backfill: one sitemap (one year of volumes) per chunk, newest year first.
// - Text: the case's PDF (OCR text layer on the older volumes), with
//   [Page N] markers; the syllabus, opinion of the Court and separate
//   opinions told apart by the pages' running heads (metadata.parts).
// - US government work: public domain. robots.txt sets no crawl delay.
//
// Opinions since the 2018 Term also come from the Court's own site
// (./scotus-opinions.ts); volume 586 (the start of that term) is in both.

const INDEX_URL = "https://www.govinfo.gov/sitemap/USREPORTS_sitemap_index.xml";
const COLLECTION_URL = "https://www.govinfo.gov/app/collection/usreports";
const HOSTS = ["www.govinfo.gov"] as const;
const COURT = "Supreme Court of the United States";
/** First daily run (no earlier success): volumes changed in this many days. */
const FIRST_DAILY_DAYS = 45;
/** Daily: how far before the last run a sitemap or volume change is looked for (GovInfo's lastmod is the time it was processed). */
const DAILY_MARGIN_DAYS = 3;

type Listing = {
  packageId: string;
  volume: number | null;
  detailsUrl: string;
  modsUrl: string;
  case: UsReportsCase;
  reasons: string[];
  /** The record has no subject data: the case is kept only when its syllabus uses an immigration term. */
  needsTextCheck: boolean;
};

type Cursor = { sitemaps: string[] };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && Array.isArray(c.sitemaps) && c.sitemaps.every((s) => typeof s === "string");
}

function sitemapYear(loc: string): number {
  const m = /USREPORTS_(\d{4})_sitemap\.xml$/.exec(loc);
  return m ? Number(m[1]) : 0;
}

async function readXmlSitemap(ctx: LibraryAdapterContext, url: string): Promise<SitemapEntry[]> {
  const { text } = await ctx.http.getText(url, { expect: "xml" });
  const parsed = parseSitemap(text);
  if (!parsed.recognized) throw new LibraryLayoutError(url, "not a sitemap (no <sitemapindex> or <urlset>)");
  return parsed.entries;
}

async function readIndex(ctx: LibraryAdapterContext): Promise<SitemapEntry[]> {
  const entries = (await readXmlSitemap(ctx, INDEX_URL)).filter((e) => /\/USREPORTS_\d{4}_sitemap\.xml$/.test(e.loc));
  if (entries.length === 0) throw new LibraryLayoutError(INDEX_URL, "no USREPORTS_<year>_sitemap.xml entries");
  return entries.sort((a, b) => sitemapYear(b.loc) - sitemapYear(a.loc));
}

/** The volumes a year's sitemap lists, highest first. */
async function readYear(ctx: LibraryAdapterContext, loc: string): Promise<{ packageId: string; detailsUrl: string; lastmod: string | null }[]> {
  const entries = await readXmlSitemap(ctx, loc);
  const volumes = entries
    .map((e) => ({ packageId: packageIdFromDetailsUrl(e.loc), detailsUrl: e.loc, lastmod: e.lastmod }))
    .filter((v): v is { packageId: string; detailsUrl: string; lastmod: string | null } => Boolean(v.packageId && usReportsVolumeOf(v.packageId) !== null));
  if (entries.length > 0 && volumes.length === 0) throw new LibraryLayoutError(loc, "no USREPORTS-<volume> details links");
  return volumes.sort((a, b) => (usReportsVolumeOf(b.packageId) ?? 0) - (usReportsVolumeOf(a.packageId) ?? 0));
}

/** One volume's immigration cases, as refs. */
async function readVolume(ctx: LibraryAdapterContext, packageId: string, detailsUrl: string): Promise<DocumentRef[]> {
  const page = await ctx.http.getText(detailsUrl, { expect: "html" });
  const modsUrl = modsLinkFromDetailsPage(page.text, page.response.url);
  if (!modsUrl) throw new LibraryLayoutError(detailsUrl, "no MODS link among the page's downloads");
  const { text } = await ctx.http.getText(modsUrl, { expect: "xml" });
  const volume = parseUsReportsVolumeMods(text);
  if (!volume) throw new LibraryLayoutError(modsUrl, "not a USREPORTS MODS record");
  if (volume.cases.length === 0) {
    ctx.note(`${packageId}: the MODS record lists no cases (${volume.otherGranules} other part(s)).`);
    return [];
  }
  const refs: DocumentRef[] = [];
  for (const c of volume.cases) {
    if (!c.pdfUrl) {
      ctx.note(`${c.granuleId}: no PDF link in the MODS record; left out.`);
      continue;
    }
    const reasons = usReportsImmigrationReasons(c);
    // A party code alone is not enough: GovInfo's records carry a few
    // miscoded parties (an INS respondent on a tax case), so such a case is
    // kept only when its syllabus agrees; so is a case with no subject data.
    const strong = reasons.some((r) => !/^(?:petitioner|respondent): /.test(r));
    const needsTextCheck = !strong && (reasons.length > 0 || !usReportsHasSubjectData(c));
    if (!strong && !needsTextCheck) continue;
    const listing: Listing = { packageId, volume: volume.volume, detailsUrl, modsUrl, case: c, reasons, needsTextCheck };
    refs.push({
      externalId: c.granuleId,
      url: c.pdfUrl,
      title: c.title,
      fingerprint: sha256Hex([c.title, c.usCitation ?? "", c.pdfUrl, c.decisionDateText ?? "", reasons.join("|"), String(needsTextCheck)].join("\u0000")).slice(0, 32),
      listing,
    });
  }
  return refs;
}

function titleWithoutCitation(title: string, fullCitation: string | null): string {
  return fullCitation && title.endsWith(`, ${fullCitation}`) ? title.slice(0, -(fullCitation.length + 2)) : title;
}

export const govinfoUsReportsAdapter: LibrarySourceAdapter = {
  code: "govinfo_us_reports_immigration",
  group: "supreme-court",
  name: "United States Reports: immigration cases (GovInfo)",
  description:
    "Supreme Court immigration cases from the official bound volumes of the United States Reports on GovInfo, chosen by the subject headings, parties and statutes in GovInfo's record of each case, with the syllabus, the opinion of the Court and separate opinions marked by page.",
  coverage:
    "Every volume GovInfo's United States Reports collection lists (volume 1 onward; through volume 586, the start of the 2018 Term, when this collector was written), immigration and related cases only. Volumes without subject data are screened by their syllabus.",
  cadence: "Daily check; GovInfo adds a volume a few times a year",
  officialUrl: COLLECTION_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 72,
  recheckAfterDays: 180,

  async listUpdates(ctx, since) {
    const threshold = new Date((since ?? new Date(ctx.now.getTime() - FIRST_DAILY_DAYS * 86_400_000)).getTime() - DAILY_MARGIN_DAYS * 86_400_000);
    const changed = (e: { lastmod: string | null }) => !e.lastmod || new Date(e.lastmod).getTime() >= threshold.getTime();
    const refs: DocumentRef[] = [];
    for (const sitemap of (await readIndex(ctx)).filter(changed)) {
      for (const v of (await readYear(ctx, sitemap.loc)).filter(changed)) refs.push(...(await readVolume(ctx, v.packageId, v.detailsUrl)));
    }
    return { refs };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const state: Cursor = isCursor(cursor) ? cursor : { sitemaps: (await readIndex(ctx)).map((e) => e.loc) };
    const loc = state.sitemaps[0];
    if (loc === undefined) return { refs: [], nextCursor: null, progress: "every year's sitemap is done" };
    const rest = state.sitemaps.slice(1);
    let volumes: { packageId: string; detailsUrl: string }[];
    try {
      volumes = await readYear(ctx, loc);
    } catch (err) {
      // A sitemap GovInfo has since removed (a stale cursor) is noted and
      // passed; anything else fails the chunk, which runs again later.
      if (!isGone(err)) throw err;
      ctx.note(`${loc} is no longer on GovInfo (${err instanceof Error ? err.message : String(err)}); it was skipped.`);
      return { refs: [], nextCursor: rest.length ? { sitemaps: rest } : null, progress: `${loc} skipped` };
    }
    const refs: DocumentRef[] = [];
    for (const v of volumes) refs.push(...(await readVolume(ctx, v.packageId, v.detailsUrl)));
    return {
      refs,
      nextCursor: rest.length ? { sitemaps: rest } : null,
      progress: `${sitemapYear(loc)}: volume(s) ${volumes.map((v) => usReportsVolumeOf(v.packageId)).join(", ") || "none"}, ${refs.length} immigration case(s) listed; ${rest.length} more year(s)`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const c = listing?.case;
    if (!listing || !c?.granuleId) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const pdf = await extractPdfText(response.body);
    const pages = pdfPages(pdf.text);
    const parts = opinionParts(pages);
    const syllabus = syllabusText(pages, parts);
    const terms = immigrationTermsIn(syllabus ?? pdf.text.slice(0, 30_000));
    if (listing.needsTextCheck && terms.length === 0) {
      return { kind: "skip", reason: `${ref.externalId} (${c.title}): GovInfo's record has no subject data and the syllabus uses no immigration term; not an immigration case.` };
    }
    if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    const hasText = pdf.pagesWithText > 0;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "opinion",
        title: titleWithoutCitation(c.title, c.fullCitation),
        citations: c.usCitation ? [c.usCitation] : [],
        court: COURT,
        decisionDate: c.decisionDate,
        documentYear: c.decisionYear,
        precedentialStatus: "precedential",
        officialUrl: response.url,
        originalUrl: null,
        text: hasText ? pdf.text : "",
        textKind: hasText ? "full" : "none",
        metadata: {
          volume: listing.volume,
          packageId: listing.packageId,
          listedTitle: c.title,
          ...(c.fullCitation ? { fullCitation: c.fullCitation } : {}),
          ...(c.courtTerm ? { courtTerm: c.courtTerm } : {}),
          ...(c.docketId ? { scdbDocketId: c.docketId } : {}),
          ...(syllabus ? { summary: syllabus, summaryKind: "syllabus" } : {}),
          parts: parts.map((p) => ({ label: p.label, pages: p.firstPage === p.lastPage ? `${p.firstPage}` : `${p.firstPage}-${p.lastPage}` })),
          subjects: c.topics,
          ...(c.scdbIssues.length ? { scdbIssues: c.scdbIssues } : {}),
          ...(c.adminAction ? { agencyBelow: c.adminAction } : {}),
          ...(c.petitioner ? { petitionerType: c.petitioner } : {}),
          ...(c.respondent ? { respondentType: c.respondent } : {}),
          ...(c.legalProvisions.length ? { legalProvisions: c.legalProvisions } : {}),
          ...(c.caseOrigin ? { caseOrigin: c.caseOrigin } : {}),
          ...(c.caseSource ? { caseSource: c.caseSource } : {}),
          ...(c.jurisdiction ? { jurisdiction: c.jurisdiction } : {}),
          ...(c.decisionType ? { decisionType: c.decisionType } : {}),
          ...(c.disposition ? { disposition: c.disposition } : {}),
          ...(c.majorityWriter ? { majorityOpinionWriter: c.majorityWriter } : {}),
          ...(c.votes ? { votes: c.votes } : {}),
          ...(c.dateArgument ? { dateArgued: c.dateArgument } : {}),
          ...(c.chiefJustice ? { chiefJustice: c.chiefJustice } : {}),
          immigrationReasons: listing.needsTextCheck ? terms.map((t) => `syllabus term: ${t}`) : listing.reasons,
          statedDates: c.decisionDateText ? { decided: c.decisionDateText } : {},
          detailsUrl: c.detailsUrl ?? listing.detailsUrl,
          modsUrl: listing.modsUrl,
          pageCount: pdf.pageCount,
          ...(hasText ? {} : { textNote: "The PDF has no text layer (a scan); no OCR is run." }),
        },
        original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
        fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
      },
    };
  },
};
