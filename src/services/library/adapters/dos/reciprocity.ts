import type { BackfillChunk, DocumentRef, FetchDocumentResult, LibraryAdapterContext, LibrarySourceAdapter } from "../../types";
import { htmlTables, parseReciprocityRows } from "./parse";
import { chunkOf } from "./chunk";
import { importedTravelRef, readTravelPage, travelDocument, travelImportPaths, travelIndexRefs, TRAVEL_HOSTS, type TravelIndexSpec, type TravelListing } from "./travel";

// Visa reciprocity and civil documents by country, from travel.state.gov:
// one page per country or area of authority with its nonimmigrant visa
// reciprocity schedule (visa issuance fee, number of entries and validity
// period by visa classification, with the footnotes) and the civil
// documents an immigrant visa applicant from there can obtain (birth,
// marriage, police and court records, military records, and so on: where
// and how, and what is unavailable), which 9 FAM tells consular officers
// to follow. The reciprocity table is also kept as rows in
// metadata.reciprocity, each value as stated.
//
// - Daily and backfill read the country list on the index page. The pages
//   carry no date, so a listed page is checked again (conditional GET) every
//   RECHECK_DAYS days.
// - travel.state.gov's bot protection: see ./travel.ts. The source is kept
//   up to date by import from the official site (../../manual-import.ts):
//   a country page saved as HTML, with the index page as the optional
//   linked file. With it the country and title are the index's, as in the
//   daily run; without it the page's own heading names the country and the
//   title is that heading alone.
//
// US government work: public domain, stored in full.

const INDEX_URL = "https://travel.state.gov/content/travel/en/us-visas/Visa-Reciprocity-and-Civil-Documents-by-Country.html";
const COUNTRY_PAGE = /^\/content\/travel\/en\/us-visas\/Visa-Reciprocity-and-Civil-Documents-by-Country\/[^/]+\.html$/i;
const PAGE_SIZE = 100;
const RECHECK_DAYS = 7;

const INDEXES: readonly TravelIndexSpec[] = [
  {
    url: INDEX_URL,
    pattern: COUNTRY_PAGE,
    minLinks: 50,
    linked: (link, index) => ({ kind: "country reciprocity and civil documents", listedText: link.text, listedOn: index.url, indexHeading: index.heading, country: link.text }),
    fromPage: (page) => (page.heading ? { country: page.heading } : {}),
  },
];

async function listCountries(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  return travelIndexRefs(ctx, INDEXES);
}

export const dosReciprocityAdapter: LibrarySourceAdapter = {
  code: "dos_reciprocity_civil_documents",
  group: "other-agency-guidance",
  name: "Visa reciprocity and civil documents by country (State Department)",
  description:
    "The State Department's country pages on nonimmigrant visa reciprocity (issuance fees, entries and validity by visa class) and on the civil documents immigrant visa applicants can obtain in each country, with the reciprocity schedule kept as rows.",
  coverage: "Every country and area of authority page the travel.state.gov reciprocity index links (about 200).",
  cadence: `Daily (each page checked again every ${RECHECK_DAYS} days)`,
  officialUrl: INDEX_URL,
  hosts: TRAVEL_HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: RECHECK_DAYS,

  async listUpdates(ctx) {
    return { refs: await listCountries(ctx) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    return chunkOf(await listCountries(ctx), cursor, PAGE_SIZE);
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const page = await readTravelPage(ctx, ref);
    if (!page) return { kind: "not_modified" };
    const listing = ref.listing as TravelListing | undefined;
    const rows = parseReciprocityRows(page.main, htmlTables(page.main));
    if (!rows.length) ctx.note(`${ref.externalId}: no reciprocity schedule table was recognized; the page text was stored without rows.`);
    const officialName = /class=["']tsg-rwd-csi-official-contry-name["'][^>]*>([^<]*)</i.exec(page.main)?.[1]?.trim() || null;
    const heading = page.heading ?? listing?.listedText ?? ref.externalId;
    return travelDocument(ref, page, {
      docType: "web_guidance",
      title: listing?.indexHeading ? `${heading} (${listing.indexHeading})` : heading,
      metadata: {
        ...(officialName ? { officialCountryName: officialName } : {}),
        ...(rows.length ? { reciprocity: rows } : {}),
      },
    });
  },

  manualImportPaths: travelImportPaths(INDEXES, "A country's reciprocity and civil documents page, saved as HTML,"),
  manualImportIntervalDays: 100,
  async parseImported(ctx, input) {
    const ref = await importedTravelRef(ctx, input, INDEXES);
    return "skip" in ref ? { kind: "skip", reason: ref.skip } : dosReciprocityAdapter.fetchDocument(ctx, ref);
  },
};
