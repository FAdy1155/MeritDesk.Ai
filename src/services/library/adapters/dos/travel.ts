import { htmlToDocumentText, pageTitle } from "../../extract/html";
import { sameAddress, sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryDocType,
  type LibraryHttpResponse,
  type ManualImportInput,
  type ManualImportPath,
} from "../../types";
import { collapse, decodeHtml, travelDocumentHtml, travelHeading, travelLinks, travelMainCopy, travelPageId, type PageLink } from "./parse";

// What the travel.state.gov collectors in this folder share (consular post
// and NVC instructions, reciprocity and civil documents, intercountry
// adoption): reading an index page's links and turning one of the site's
// guidance pages into a document. Every page of the site uses the same
// template, so the main copy is found the same way on each.
//
// travel.state.gov sits behind a bot-protection service that, when this
// collector was written, refused automated requests from the test machine
// (HTTP 403 with a challenge page), so the parsers were checked against
// archived copies of the pages instead. The collectors do not try to get
// around it: the request fails, the run fails with the site's answer, and
// /library shows the source as failing until the site lets the collector's
// declared User-Agent through.

export const TRAVEL_HOSTS = ["travel.state.gov"] as const;
export const CONSULAR_AFFAIRS = "U.S. Department of State, Bureau of Consular Affairs";

export type TravelIndex = { url: string; heading: string | null; links: PageLink[] };

/** An index page's heading and its links to pages whose path matches `pattern`; a page without the site's main copy fails the run. */
export async function readTravelIndex(ctx: LibraryAdapterContext, url: string, pattern: RegExp): Promise<TravelIndex> {
  const { text, response } = await ctx.http.getText(url, { expect: "html" });
  const main = travelMainCopy(text);
  if (!main) throw new LibraryLayoutError(url, "no main copy (tsg-rwd-main-copy-body-frame)");
  return { url: response.url, heading: travelHeading(text, main), links: travelLinks(main, response.url, pattern) };
}

/** What a travel.state.gov ref carries from its listing. */
export type TravelListing = {
  /** Which list it came from ("post instructions", "country information"). */
  kind: string;
  listedText: string;
  listedOn: string;
  indexHeading: string | null;
  /** Set for country pages: the country as the index names it. */
  country?: string;
};

export function travelRef(url: string, listing: TravelListing): DocumentRef {
  return {
    externalId: travelPageId(url),
    url,
    title: listing.listedText || travelPageId(url),
    fingerprint: sha256Hex([url, listing.listedText, listing.kind].join("\u0000")).slice(0, 32),
    listing,
  };
}

/** Refs from several lists, each page once (the first list that names it wins). */
export function uniqueRefs(refs: DocumentRef[]): DocumentRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true)));
}

export type TravelPage = { html: string; main: string; heading: string | null; pageTitle: string | null; text: string; response: LibraryHttpResponse };

/** Fetches one guidance page (conditional) and reads its main copy; null when it came back 304. */
export async function readTravelPage(ctx: LibraryAdapterContext, ref: DocumentRef): Promise<TravelPage | null> {
  const response = await ctx.http.get(ref.url, { expect: "html", conditional: ref.known ?? null });
  if (response.notModified) return null;
  const html = decodeHtml(response.body, response.charset);
  const main = travelMainCopy(html);
  if (!main) throw new LibraryLayoutError(response.url, "no main copy (tsg-rwd-main-copy-body-frame)");
  return {
    html,
    main,
    heading: travelHeading(html, main),
    pageTitle: pageTitle(html),
    text: htmlToDocumentText(travelDocumentHtml(main)),
    response,
  };
}

/** A guidance page as a document, with the type, title and metadata one source knows; a page with no text is skipped. */
export function travelDocument(
  ref: DocumentRef,
  page: TravelPage,
  params: { docType: LibraryDocType; title: string; metadata?: Record<string, unknown> }
): FetchDocumentResult {
  const listing = ref.listing as TravelListing | undefined;
  if (!page.text) return { kind: "skip", reason: `${ref.externalId}: the page has no text in its main copy.` };
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: params.docType,
      title: collapse(params.title),
      citations: [],
      agency: CONSULAR_AFFAIRS,
      precedentialStatus: "not_applicable",
      officialUrl: page.response.url,
      text: page.text,
      metadata: {
        ...(page.heading ? { pageHeading: page.heading } : {}),
        ...(listing?.listedText ? { listedAs: listing.listedText } : {}),
        ...(listing?.listedOn ? { listedOn: listing.listedOn } : {}),
        ...(listing?.country ? { country: listing.country } : {}),
        ...params.metadata,
      },
      fetch: { response: page.response },
    },
  };
}

// ---------------------------------------------------------------------------
// Import from the official site (../../manual-import.ts)

/** One index page a travel.state.gov collector reads, and the listing facts it gives its own ref and each page it links. */
export type TravelIndexSpec = {
  url: string;
  /** The pages it lists. */
  pattern: RegExp;
  /** At least this many links, or the layout changed (the daily run's check). */
  minLinks?: number;
  /** The index page's own listing, when the index page is a document too. */
  self?: (index: TravelIndex) => TravelListing;
  /** The listing of a page the index links. */
  linked: (link: PageLink, index: TravelIndex) => TravelListing;
  /**
   * Listing facts the page itself states, used when the page is imported
   * without its index page (the country a reciprocity page heads itself with).
   */
  fromPage?: (page: { heading: string | null; title: string | null }) => Partial<TravelListing>;
};

/** Every ref the indexes give, in their order, each page once (the daily run's and backfill's listing). */
export async function travelIndexRefs(ctx: LibraryAdapterContext, specs: readonly TravelIndexSpec[]): Promise<DocumentRef[]> {
  const refs: DocumentRef[] = [];
  for (const spec of specs) {
    const index = await readTravelIndex(ctx, spec.url, spec.pattern);
    if (spec.minLinks && index.links.length < spec.minLinks) throw new LibraryLayoutError(spec.url, `only ${index.links.length} links found`);
    if (spec.self) refs.push(travelRef(index.url, spec.self(index)));
    for (const link of index.links) refs.push(travelRef(link.url, spec.linked(link, index)));
  }
  return uniqueRefs(refs);
}

/** The pages an import may name for these indexes: the pages they list and the index pages that are documents, and the index pages as linked files. */
export function travelImportPaths(specs: readonly TravelIndexSpec[], what: string): ManualImportPath[] {
  const exact = (url: string) => new RegExp(`^${new URL(url).pathname.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "i");
  return [
    ...specs.map((s) => ({ path: s.pattern, file: "html" as const, role: "document" as const, label: `${what} one that ${s.url} links` })),
    ...specs.filter((s) => s.self).map((s) => ({ path: exact(s.url), file: "html" as const, role: "document" as const, label: `The index page ${s.url}` })),
    ...specs.map((s) => ({ path: exact(s.url), file: "html" as const, role: "linked" as const, label: `Optional: the index page ${s.url} that links the page` })),
  ];
}

/**
 * The ref for a travel.state.gov page imported by hand: the one the daily
 * run builds, from the index page when it was given as the linked file (or
 * when the page is itself an index page); otherwise a ref from the page's
 * address, with what the index alone states (the link's words, the index's
 * heading) left out and what the page itself states (fromPage) in its place.
 */
export async function importedTravelRef(
  ctx: LibraryAdapterContext,
  input: ManualImportInput,
  specs: readonly TravelIndexSpec[]
): Promise<DocumentRef | { skip: string }> {
  const own = specs.find((s) => s.self && sameAddress(s.url, input.url));
  if (own) {
    const index = await readTravelIndex(ctx, input.url, own.pattern);
    return travelRef(input.url, own.self!(index));
  }
  const path = new URL(input.url).pathname;
  const spec = specs.find((s) => s.pattern.test(path));
  if (!spec) return { skip: `${input.url} is not a page this source collects.` };
  if (input.linked) {
    if (!sameAddress(input.linked.url, spec.url)) return { skip: `The linked page must be the index page that lists this page, ${spec.url}.` };
    const index = await readTravelIndex(ctx, input.linked.url, spec.pattern);
    const link = index.links.find((l) => sameAddress(l.url, input.url));
    if (!link) return { skip: `The index page given (${index.url}) does not link ${input.url}, so the collector would not collect it.` };
    return travelRef(input.url, spec.linked(link, index));
  }
  const html = decodeHtml(input.bytes, null);
  const main = travelMainCopy(html);
  // Not read from the index: no listed words, no "listed on" (the page was not seen listed there).
  const listing = { ...spec.linked({ url: input.url, text: "", title: null }, { url: spec.url, heading: null, links: [] }), listedOn: "" };
  return travelRef(input.url, { ...listing, ...spec.fromPage?.({ heading: travelHeading(html, main), title: pageTitle(html) }) });
}
