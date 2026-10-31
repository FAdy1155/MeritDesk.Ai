import type { BackfillChunk, DocumentRef, FetchDocumentResult, LibraryAdapterContext, LibrarySourceAdapter } from "../../types";
import { chunkOf } from "./chunk";
import { importedTravelRef, readTravelPage, travelDocument, travelImportPaths, travelIndexRefs, TRAVEL_HOSTS, type TravelIndexSpec, type TravelListing } from "./travel";

// Immigrant visa instructions from travel.state.gov: each consular post's
// own instructions for immigrant visa applicants (the "Supplements by Post"
// pages the list of embassies and consulates that process immigrant visas
// links: registration, medical examination and panel physicians, the
// documents to bring, interview guidelines), the National Visa Center's
// pages, and the immigrant visa process pages (petition, NVC processing,
// fees, forms and documents, interview), each page a document.
//
// - Daily and backfill read the three index pages (the list of posts, the
//   National Visa Center page, the immigrant visa process page) and the
//   pages each links in its own part of the site; the index pages are
//   documents too. The pages carry no date, so a listed page is checked
//   again (conditional GET) every RECHECK_DAYS days.
// - Posts' own websites (*.usembassy.gov) are other hosts and not read.
// - travel.state.gov's bot protection: see ./travel.ts. The source is kept
//   up to date by import from the official site (../../manual-import.ts):
//   a page saved as HTML, with the index page that links it as the optional
//   linked file (the post's name as the list gives it, and its post code).
//
// US government work: public domain, stored in full.

const POSTS_URL = "https://travel.state.gov/content/travel/en/us-visas/visa-information-resources/list-of-posts.html";
const NVC_URL = "https://travel.state.gov/content/travel/en/us-visas/immigrate/national-visa-center.html";
const PROCESS_URL = "https://travel.state.gov/content/travel/en/us-visas/immigrate/the-immigrant-visa-process.html";
const POST_PAGE = /^\/content\/travel\/en\/us-visas\/Supplements\/Supplements_by_Post\/[^/]+\.html$/i;
const NVC_PAGE = /^\/content\/travel\/en\/us-visas\/immigrate\/national-visa-center(?:\/[^?#]+)?\.html$/i;
const PROCESS_PAGE = /^\/content\/travel\/en\/us-visas\/immigrate\/the-immigrant-visa-process(?:\/[^?#]+)?\.html$/i;
const PAGE_SIZE = 100;
const RECHECK_DAYS = 7;

/** The three index pages, each a document too, and the pages each links in its own part of the site. */
const INDEXES: readonly TravelIndexSpec[] = [
  {
    url: POSTS_URL,
    pattern: POST_PAGE,
    minLinks: 20,
    self: (index) => ({ kind: "list of posts", listedText: index.heading ?? "List of posts", listedOn: index.url, indexHeading: index.heading }),
    linked: (link, index) => ({ kind: "post instructions", listedText: link.text, listedOn: index.url, indexHeading: index.heading }),
  },
  ...([
    [NVC_URL, NVC_PAGE, "National Visa Center"],
    [PROCESS_URL, PROCESS_PAGE, "immigrant visa process"],
  ] as const).map(
    ([url, pattern, kind]): TravelIndexSpec => ({
      url,
      pattern,
      self: (index) => ({ kind, listedText: index.heading ?? kind, listedOn: index.url, indexHeading: index.heading }),
      linked: (link, index) => ({ kind, listedText: link.text, listedOn: index.url, indexHeading: index.heading }),
    })
  ),
];

async function listPages(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  return travelIndexRefs(ctx, INDEXES);
}

export const dosConsularPostsAdapter: LibrarySourceAdapter = {
  code: "dos_consular_post_nvc",
  group: "other-agency-guidance",
  name: "Consular post and National Visa Center instructions (State Department)",
  description:
    "Each U.S. embassy and consulate's instructions for immigrant visa applicants, the National Visa Center's pages and the immigrant visa process pages, from travel.state.gov.",
  coverage:
    "The post instruction pages the list of posts that process immigrant visas links (about 120), and the National Visa Center and immigrant visa process pages with the pages they link in their own part of the site.",
  cadence: `Daily (each page checked again every ${RECHECK_DAYS} days)`,
  officialUrl: POSTS_URL,
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
    // A post page is titled "U.S. Embassy Islamabad, Pakistan - ISL"; the list names it "Pakistan - Islamabad (ISL)".
    const postCode = listing?.kind === "post instructions" ? (/\(([A-Z]{3})\)\s*$/.exec(listing.listedText)?.[1] ?? /\s-\s([A-Z]{3})$/.exec(page.heading ?? "")?.[1] ?? null) : null;
    return travelDocument(ref, page, {
      docType: "web_guidance",
      title: page.heading ?? page.pageTitle ?? listing?.listedText ?? ref.externalId,
      metadata: {
        section: listing?.kind ?? null,
        ...(postCode ? { postCode } : {}),
      },
    });
  },

  manualImportPaths: travelImportPaths(INDEXES, "A post instruction, National Visa Center or immigrant visa process page, saved as HTML,"),
  manualImportIntervalDays: 100,
  async parseImported(ctx, input) {
    const ref = await importedTravelRef(ctx, input, INDEXES);
    return "skip" in ref ? { kind: "skip", reason: ref.skip } : dosConsularPostsAdapter.fetchDocument(ctx, ref);
  },
};
