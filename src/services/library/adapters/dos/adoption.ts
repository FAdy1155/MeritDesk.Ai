import type { BackfillChunk, DocumentRef, FetchDocumentResult, LibraryAdapterContext, LibrarySourceAdapter } from "../../types";
import { chunkOf } from "./chunk";
import { importedTravelRef, readTravelPage, travelDocument, travelImportPaths, travelIndexRefs, TRAVEL_HOSTS, type TravelIndexSpec, type TravelListing } from "./travel";

// Intercountry adoption guidance from travel.state.gov: the State
// Department's adoption pages (the adoption process, adoption service
// providers, post-adoption, adoptions from the United States, guidance for
// adoption professionals, reference) and its country information pages
// (whether the country is a Hague Adoption Convention party, who may adopt
// and who may be adopted, the country's process, and the U.S. immigrant
// visa process for the child), each page a document.
//
// - Daily and backfill read the Intercountry Adoption page (its sections)
//   and the country information index (its countries). Country pages embed
//   the country's travel-advisory banner, a separate publication left out of
//   the text (./parse.ts travelDocumentHtml). The pages carry no date, so a
//   listed page is checked again (conditional GET) every RECHECK_DAYS days.
// - travel.state.gov's bot protection: see ./travel.ts. The source is kept
//   up to date by import from the official site (../../manual-import.ts):
//   a page saved as HTML, with its index page (the Intercountry Adoption
//   page, or the country information index) as the optional linked file.
//   Without the index, a country page's country is the one its own title
//   names ("Albania Intercountry Adoption Information").
//
// US government work: public domain, stored in full.

const HOME_URL = "https://travel.state.gov/content/travel/en/Intercountry-Adoption.html";
const COUNTRIES_URL = "https://travel.state.gov/content/travel/en/Intercountry-Adoption/Intercountry-Adoption-Country-Information.html";
const SECTION_PAGE = /^\/content\/travel\/en\/Intercountry-Adoption\/[^/]+\.html$/i;
const COUNTRY_PAGE = /^\/content\/travel\/en\/Intercountry-Adoption\/Intercountry-Adoption-Country-Information\/[^/]+\.html$/i;
const PAGE_SIZE = 100;
const RECHECK_DAYS = 14;

/** A country page's own title: "Albania Intercountry Adoption Information". */
const COUNTRY_TITLE = /^(.+?)\s+Intercountry Adoption Information$/i;

const INDEXES: readonly TravelIndexSpec[] = [
  {
    url: HOME_URL,
    pattern: SECTION_PAGE,
    minLinks: 3,
    self: (index) => ({ kind: "intercountry adoption", listedText: index.heading ?? "Intercountry Adoption", listedOn: index.url, indexHeading: index.heading }),
    linked: (link, index) => ({ kind: "intercountry adoption", listedText: link.text, listedOn: index.url, indexHeading: index.heading }),
  },
  {
    url: COUNTRIES_URL,
    pattern: COUNTRY_PAGE,
    minLinks: 50,
    linked: (link, index) => ({ kind: "country information", listedText: link.text, listedOn: index.url, indexHeading: index.heading, country: link.text }),
    fromPage: (page) => {
      const country = COUNTRY_TITLE.exec(page.title ?? "")?.[1];
      return country ? { country } : {};
    },
  },
];

async function listPages(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  return travelIndexRefs(ctx, INDEXES);
}

export const dosAdoptionAdapter: LibrarySourceAdapter = {
  code: "dos_intercountry_adoption",
  group: "other-agency-guidance",
  name: "Intercountry adoption guidance (State Department)",
  description:
    "The State Department's intercountry adoption guidance and its country information pages (Hague Convention status, eligibility, the country's process and the child's immigrant visa), from travel.state.gov.",
  coverage: "The sections the Intercountry Adoption page links and every country information page its country index links (about 200).",
  cadence: `Daily (each page checked again every ${RECHECK_DAYS} days)`,
  officialUrl: HOME_URL,
  hosts: TRAVEL_HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: RECHECK_DAYS,

  async listUpdates(ctx) {
    return { refs: await listPages(ctx) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    return chunkOf(await listPages(ctx), cursor, PAGE_SIZE);
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const page = await readTravelPage(ctx, ref);
    if (!page) return { kind: "not_modified" };
    const listing = ref.listing as TravelListing | undefined;
    const hague = /Hague Adoption Convention Country\?\s*\n+\s*(Yes|No)\b/i.exec(page.text)?.[1] ?? null;
    // Country pages are titled "Albania Intercountry Adoption Information" (their <title>); the others by their heading.
    const title = listing?.kind === "country information" && page.pageTitle ? page.pageTitle : (page.heading ?? page.pageTitle ?? listing?.listedText ?? ref.externalId);
    return travelDocument(ref, page, {
      docType: "web_guidance",
      title,
      metadata: {
        section: listing?.kind ?? null,
        ...(hague ? { hagueAdoptionConventionCountry: hague } : {}),
      },
    });
  },

  manualImportPaths: travelImportPaths(INDEXES, "An intercountry adoption page or country information page, saved as HTML,"),
  manualImportIntervalDays: 100,
  async parseImported(ctx, input) {
    const ref = await importedTravelRef(ctx, input, INDEXES);
    return "skip" in ref ? { kind: "skip", reason: ref.skip } : dosAdoptionAdapter.fetchDocument(ctx, ref);
  },
};
