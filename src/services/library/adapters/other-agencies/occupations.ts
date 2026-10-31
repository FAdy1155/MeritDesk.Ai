import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { cachedPage, chunkOf, fingerprintOf } from "./common";
import { parseOnetAll, parseOnetSummary, parseOohIndex, parseOohProfile, pathId } from "./parse";

// Occupational sources used in labor certification and specialty
// occupation work (the duties, education and training of an occupation,
// its SOC code and job zone):
//
// - The Bureau of Labor Statistics' Occupational Outlook Handbook: every
//   occupation profile its A-Z index links, with all of the profile's tabs
//   (summary, duties, work environment, how to become one, pay, outlook,
//   similar occupations). BLS's suggested citation and the profile's "Last
//   modified date" are kept. US government work: public domain, stored in
//   full. bls.gov's robots.txt sets no Crawl-delay.
//
// - O*NET OnLine, the Department of Labor's occupational database run for
//   ETA by the National Center for O*NET Development: every occupation on
//   its "All Occupations" page, from the occupation's summary page. O*NET
//   content is licensed under Creative Commons Attribution 4.0
//   (https://www.onetcenter.org/license_db.html), which permits reuse with
//   attribution but is not a public domain dedication, so this collector is
//   link_only: the code, title, description, sample job titles and job zone
//   in metadata, an excerpt, and the link. onetonline.org's robots.txt sets
//   no Crawl-delay.

const BLS_HOSTS = ["www.bls.gov"] as const;
const OOH_INDEX_URL = "https://www.bls.gov/ooh/a-z-index.htm";

type OohListing = { label: string };

async function oohRefs(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await cachedPage(ctx, OOH_INDEX_URL);
  const pages = parseOohIndex(text, response.url);
  if (pages.length < 200) throw new LibraryLayoutError(OOH_INDEX_URL, "the A-Z index links too few occupation profiles");
  return pages.map((p) => ({ externalId: pathId(p.url), url: p.url, title: p.label, fingerprint: fingerprintOf(p.url), listing: { label: p.label } satisfies OohListing }));
}

export const blsOohAdapter: LibrarySourceAdapter = {
  code: "bls_occupational_outlook_handbook",
  group: "other-agency-guidance",
  name: "BLS Occupational Outlook Handbook",
  description:
    "The Bureau of Labor Statistics' profiles of occupations: duties, work environment, the education and training required, pay, job outlook and similar occupations, as used in labor certification and specialty occupation cases.",
  coverage: "Every occupation profile linked from the Handbook's A-Z index, current edition.",
  cadence: "Daily (BLS revises the Handbook each year and updates pay data in between)",
  officialUrl: "https://www.bls.gov/ooh/",
  hosts: BLS_HOSTS,
  license: "public_domain",
  staleAfterHours: 24 * 8,
  recheckAfterDays: 30,

  async listUpdates(ctx) {
    return { refs: await oohRefs(ctx) };
  },
  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const { items, nextCursor, progress } = chunkOf(await oohRefs(ctx), cursor, 200);
    return { refs: items, nextCursor, progress };
  },
  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const { text, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const profile = parseOohProfile(text);
    if (!profile.panes || !profile.title) return { kind: "skip", reason: `${ref.url} is not an Occupational Outlook Handbook profile in the layout this collector reads.` };
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "manual_section",
        title: `Occupational Outlook Handbook: ${profile.title}`,
        citations: [],
        agency: "U.S. Department of Labor, Bureau of Labor Statistics",
        editionDate: parseStatedDate(profile.lastModified),
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        // The video player's "enable javascript" prompt is page furniture, not the Handbook's text.
        text: htmlToDocumentText(profile.panes).replace(/^Please enable javascript to play this video\.\s*$/gim, ""),
        metadata: {
          occupation: profile.title,
          ...(profile.lastModified ? { statedDates: { lastModified: profile.lastModified } } : {}),
        },
        fetch: { response },
      },
    };
  },
};

const ONET_HOSTS = ["www.onetonline.org"] as const;
const ONET_ALL_URL = "https://www.onetonline.org/find/all";

type OnetListing = { code: string; title: string };

async function onetRefs(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await cachedPage(ctx, ONET_ALL_URL);
  const occupations = parseOnetAll(text, response.url);
  if (occupations.length < 500) throw new LibraryLayoutError(ONET_ALL_URL, "the All Occupations page links too few occupations");
  return occupations.map((o) => ({
    externalId: `O*NET-SOC ${o.code}`,
    url: o.url,
    title: `${o.code} ${o.title}`,
    fingerprint: fingerprintOf(o.code, o.title, o.url),
    listing: { code: o.code, title: o.title } satisfies OnetListing,
  }));
}

export const onetOccupationsAdapter: LibrarySourceAdapter = {
  code: "onet_occupations",
  group: "other-agency-guidance",
  name: "O*NET occupational information",
  description:
    "O*NET OnLine's occupation summaries (the Department of Labor's occupational database): each occupation's O*NET-SOC code, description, sample job titles and job zone, linked to the full summary on O*NET OnLine.",
  coverage: "Every occupation on O*NET OnLine's All Occupations page; metadata, a short excerpt and the link only (O*NET is licensed CC BY 4.0, not public domain).",
  cadence: "Daily (O*NET releases database updates a few times a year)",
  officialUrl: ONET_ALL_URL,
  hosts: ONET_HOSTS,
  license: "link_only",
  licenseNote: "O*NET content is licensed under Creative Commons Attribution 4.0, which allows reuse with attribution but is not public domain; the library keeps the occupation's facts, a short excerpt and the link.",
  staleAfterHours: 24 * 8,
  recheckAfterDays: 60,

  async listUpdates(ctx) {
    return { refs: await onetRefs(ctx) };
  },
  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const { items, nextCursor, progress } = chunkOf(await onetRefs(ctx), cursor, 300);
    return { refs: items, nextCursor, progress };
  },
  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as OnetListing | undefined;
    const { text, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const summary = parseOnetSummary(text);
    if (!summary.content || !summary.title) return { kind: "skip", reason: `${ref.url} is not an O*NET summary page in the layout this collector reads.` };
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "other",
        title: `${summary.code ?? listing?.code ?? ""} ${summary.title}`.trim(),
        citations: [],
        agency: "U.S. Department of Labor, Employment and Training Administration (O*NET)",
        documentYear: summary.updatedText ? Number(summary.updatedText) : null,
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        // link_only: the pipeline keeps only an excerpt of this text.
        text: htmlToDocumentText(summary.content),
        metadata: {
          onetSocCode: summary.code ?? listing?.code ?? null,
          occupation: summary.title,
          ...(summary.description ? { summary: summary.description, summaryKind: "O*NET occupation description" } : {}),
          ...(summary.sampleTitles ? { sampleJobTitles: summary.sampleTitles } : {}),
          ...(summary.jobZone ? { jobZone: summary.jobZone } : {}),
          ...(summary.updatedText ? { statedDates: { occupationDataUpdated: summary.updatedText } } : {}),
          license: "CC BY 4.0: includes information from O*NET OnLine by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA).",
        },
        fetch: { response },
      },
    };
  },
};
