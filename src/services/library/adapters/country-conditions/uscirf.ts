import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText, resolveUrl } from "../../extract/html";
import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryHttpResponse,
  type LibrarySourceAdapter,
} from "../../types";
import { countryFields } from "./country";
import { countriesInTitle } from "./country-names";
import { parseUscirfList, parseUscirfPublication, statedYear, type UscirfListItem, type UscirfListPage, type UscirfPublication } from "./parse";

// The U.S. Commission on International Religious Freedom's publications:
// its annual reports and their country chapters, country updates,
// factsheets, policy briefs and hearing summaries, read from
// https://www.uscirf.gov/publications (newest first, ten a page, the pager's
// "next" link to the following page) and each publication's page, whose
// text is the PDF it links ("View PDF", or the one PDF its description
// links); a publication with no PDF keeps the description its page prints.
//
// - Daily: the first list page, and following pages while every
//   publication on a page is newer than the last run. Backfill:
//   PAGES_PER_CHUNK list pages per chunk, following the "next" links (the
//   cursor is the next page's URL as the pager gave it).
// - Older publications have no "View PDF" link in the list and link their
//   files from the page's description instead: one PDF, which is then the
//   publication's text, or several (the country pages titled "<Country>
//   Chapters and Summaries" link a run of annual report chapters, 2005 to
//   2015; the 2005 Report on Asylum Seekers in Expedited Removal links its
//   volumes and studies). When a listing names such a page, the page is
//   read then, and when it links several PDFs each becomes a document of its
//   own (kind "linked_pdf", keyed by the file's path, titled by its link
//   text, "Burma Chapter - 2012 Annual Report"); the page itself is kept
//   with its description and the list of its files.
// - Country: USCIRF states no country field for a publication, only in
//   its title ("Iraq Country Update", "Burma Chapter - 2019 Annual Report",
//   "Religious Freedom in Somalia"). The country names a title contains
//   (./country-names.ts, with the names the list's own country filter
//   offers) are kept as metadata.country, or metadata.countries for more
//   than one, exactly as the title writes them, with metadata.countrySource
//   "title". Publications whose title names no country (thematic reports,
//   the annual report as a whole) have none.
// - www.uscirf.gov answered the test machine with HTTP 403 for a while
//   (every client, not only the collector) and served the collector again
//   later the same day (October 2026). The collector does not try to get
//   around a refusal: the run fails with the site's answer, and /library
//   shows the source as failing until the site answers again. No Crawl-delay
//   in its robots.txt, so requests go at the library's default pace.
//
// USCIRF is an independent U.S. federal government commission (22 U.S.C.
// 6431); its publications are U.S. government works: public domain, stored
// in full.

const LIST_URL = "https://www.uscirf.gov/publications";
const HOSTS = ["www.uscirf.gov", "uscirf.gov"] as const;
const AGENCY = "U.S. Commission on International Religious Freedom";
const PAGES_PER_CHUNK = 4;
const DAILY_MAX_PAGES = 5;

type PublicationListing = {
  kind?: "publication";
  title: string;
  dateText: string | null;
  datetime: string | null;
  pdfUrl: string | null;
  countries: string[];
  listedOn: string;
};
type LinkedPdfListing = {
  kind: "linked_pdf";
  /** The link's text on the publication page ("Venezuela Chapter - 2012 Annual Report"). */
  linkText: string;
  countries: string[];
  publicationUrl: string;
  publicationTitle: string;
};
type Listing = PublicationListing | LinkedPdfListing;
type Cursor = { url: string; page: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && typeof c.url === "string" && Number.isInteger(c.page);
}

function onHosts(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (HOSTS as readonly string[]).includes(u.hostname);
  } catch {
    return false;
  }
}

async function readListPage(ctx: LibraryAdapterContext, url: string, first: boolean): Promise<UscirfListPage> {
  const { text, response } = await ctx.http.getText(url, { expect: "html" });
  const page = parseUscirfList(text, response.url);
  if (!page) throw new LibraryLayoutError(url, "no publications view");
  if (first && page.items.length === 0) throw new LibraryLayoutError(url, "the publications list shows no publications");
  return page;
}

async function readPublication(ctx: LibraryAdapterContext, url: string): Promise<{ pub: UscirfPublication; response: LibraryHttpResponse }> {
  const { text, response } = await ctx.http.getText(url, { expect: "html" });
  const pub = parseUscirfPublication(text);
  if (!pub) throw new LibraryLayoutError(url, "no main content block");
  return { pub, response };
}

function refFor(item: UscirfListItem, countries: readonly string[], listedOn: string): DocumentRef {
  const listing: PublicationListing = {
    title: item.title,
    dateText: item.dateText,
    datetime: item.datetime,
    pdfUrl: item.pdfUrl,
    countries: countriesInTitle(item.title, countries),
    listedOn,
  };
  return {
    // The list links most publications at /publications/<slug> and some at /publication/<slug>; the id is the same either way.
    externalId: new URL(item.url).pathname.replace(/^\/publication\//, "/publications/"),
    url: item.url,
    title: item.title,
    fingerprint: sha256Hex([item.url, item.title, item.dateText ?? "", item.pdfUrl ?? ""].join("\u0000")).slice(0, 32),
    listing,
  };
}

/** The PDFs a publication page links from its description, one ref each, when it links more than one. */
async function linkedPdfRefs(ctx: LibraryAdapterContext, page: DocumentRef, countries: readonly string[]): Promise<DocumentRef[]> {
  const { pub, response } = await readPublication(ctx, page.url);
  const publicationTitle = pub.title ?? page.title ?? "";
  const parentCountries = (page.listing as PublicationListing | undefined)?.countries ?? [];
  const refs: DocumentRef[] = [];
  for (const link of pub.descriptionPdfs) {
    const url = resolveUrl(link.href, response.url);
    if (!url || !onHosts(url) || !link.text) continue;
    const named = countriesInTitle(link.text, countries);
    const listing: LinkedPdfListing = {
      kind: "linked_pdf",
      linkText: link.text,
      // The link's own words name the country ("Iran Chapter - 2015 Annual Report"); else the publication's title does.
      countries: named.length ? named : parentCountries,
      publicationUrl: response.url,
      publicationTitle,
    };
    refs.push({
      externalId: new URL(url).pathname,
      url,
      title: link.text,
      fingerprint: sha256Hex([url, link.text].join("\u0000")).slice(0, 32),
      listing,
    });
  }
  // A single PDF is the publication's own text (fetchDocument reads it), not a document of its own.
  return refs.length > 1 ? refs : [];
}

/** The publications of a list page, with the files of each page that links several from its description. */
async function pageRefs(ctx: LibraryAdapterContext, page: UscirfListPage, listedOn: string): Promise<DocumentRef[]> {
  const refs: DocumentRef[] = [];
  for (const item of page.items) {
    const ref = refFor(item, page.countries, listedOn);
    refs.push(ref);
    if (!item.pdfUrl) refs.push(...(await linkedPdfRefs(ctx, ref, page.countries)));
  }
  return refs;
}

function itemTime(item: UscirfListItem): number {
  return new Date(item.datetime ?? parseStatedDate(item.dateText) ?? "").getTime();
}

function unique(refs: DocumentRef[]): DocumentRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true)));
}

async function fetchPdfDocument(
  ctx: LibraryAdapterContext,
  ref: DocumentRef,
  pdfUrl: string,
  base: { title: string; publishedDate: string | null; documentYear: number | null; officialUrl: string; metadata: Record<string, unknown> }
): Promise<FetchDocumentResult> {
  const response = await ctx.http.get(pdfUrl, { expect: "pdf", conditional: ref.known ?? null });
  if (response.notModified) return { kind: "not_modified" };
  const pdf = await extractPdfText(response.body);
  if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "report",
      title: base.title,
      citations: [],
      agency: AGENCY,
      publishedDate: base.publishedDate,
      documentYear: base.documentYear,
      precedentialStatus: "not_applicable",
      officialUrl: base.officialUrl,
      originalUrl: response.url === base.officialUrl ? null : response.url,
      text: pdf.pagesWithText > 0 ? pdf.text : "",
      textKind: pdf.pagesWithText > 0 ? "full" : "none",
      metadata: {
        ...base.metadata,
        pdfUrl: response.url,
        pageCount: pdf.pageCount,
        ...(pdf.pagesWithText === 0 ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}),
      },
      original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
      fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
    },
  };
}

export const uscirfReportsAdapter: LibrarySourceAdapter = {
  code: "uscirf_reports",
  group: "country-conditions",
  name: "USCIRF annual reports and country publications",
  description:
    "The U.S. Commission on International Religious Freedom's annual reports, country chapters, country updates, factsheets and other publications, read from its publications list and each publication's PDF.",
  coverage:
    "Every publication USCIRF's publications list shows, as far back as its pages go (2005 on), and each file its older publication pages link when they link several (the \"Chapters and Summaries\" pages' annual report chapters, the Expedited Removal study's volumes).",
  cadence: "Daily",
  officialUrl: LIST_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 72,
  recheckAfterDays: 90,

  async listUpdates(ctx, since) {
    const cutoff = since ? since.getTime() - 2 * 24 * 60 * 60 * 1000 : null;
    const refs: DocumentRef[] = [];
    let url: string | null = LIST_URL;
    for (let n = 0; url && n < (cutoff ? DAILY_MAX_PAGES : 1); n++) {
      const page = await readListPage(ctx, url, n === 0);
      refs.push(...(await pageRefs(ctx, page, url)));
      const times = page.items.map(itemTime).filter((t) => !Number.isNaN(t));
      if (!cutoff || times.length === 0 || Math.min(...times) < cutoff) break;
      url = page.nextUrl;
    }
    return { refs: unique(refs) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const start: Cursor = isCursor(cursor) ? cursor : { url: LIST_URL, page: 0 };
    const refs: DocumentRef[] = [];
    let url: string | null = start.url;
    let page = start.page;
    let lastPage = 0;
    for (let n = 0; url && n < PAGES_PER_CHUNK; n++) {
      const list = await readListPage(ctx, url, page === 0);
      lastPage = Math.max(lastPage, list.lastPage);
      if (list.items.length === 0) {
        ctx.note(`List page ${page + 1} shows no publications; the walk ends there.`);
        url = null;
        break;
      }
      refs.push(...(await pageRefs(ctx, list, url)));
      url = list.nextUrl;
      page++;
    }
    return {
      refs: unique(refs),
      nextCursor: url ? { url, page } : null,
      progress: `list pages ${start.page + 1} to ${page}${lastPage ? ` of about ${lastPage + 1}` : ""}`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;

    if (listing?.kind === "linked_pdf") {
      // A file an older publication page links among several (an annual report chapter, a study's volume): the file is the document.
      return fetchPdfDocument(ctx, ref, ref.url, {
        // A link that names its country or report reads alone ("Iran Chapter - 2015 Annual Report"); others ("Executive Summary") after the publication's title.
        title: countriesInTitle(listing.linkText).length || /annual report/i.test(listing.linkText) ? listing.linkText : `${listing.publicationTitle}: ${listing.linkText}`,
        publishedDate: null,
        documentYear: statedYear(listing.linkText),
        officialUrl: ref.url,
        metadata: {
          ...countryFields(listing.countries),
          ...(listing.countries.length ? { countrySource: "title" } : {}),
          linkText: listing.linkText,
          publicationTitle: listing.publicationTitle,
          publicationUrl: listing.publicationUrl,
        },
      });
    }

    const { pub, response: pageResponse } = await readPublication(ctx, ref.url);
    const title = pub.title ?? listing?.title;
    if (!title) throw new LibraryLayoutError(ref.url, "no publication title");
    // The page's "View PDF" button, else the list's "View PDF" link, else the PDF the description links when it
    // links only one (a page whose description links several is an index of them, kept with its description).
    const linked = pub.descriptionPdfs.map((l) => ({ url: resolveUrl(l.href, pageResponse.url), text: l.text })).filter((l): l is { url: string; text: string } => Boolean(l.url));
    const pdfUrl =
      (pub.pdfHref ? resolveUrl(pub.pdfHref, pageResponse.url) : null) ?? listing?.pdfUrl ?? (linked.length === 1 ? linked[0].url : null);
    const description = pub.descriptionHtml ? htmlToDocumentText(pub.descriptionHtml) : "";
    const countries = listing?.countries ?? countriesInTitle(title);
    const metadata = {
      ...countryFields(countries),
      ...(countries.length ? { countrySource: "title" } : {}),
      ...(description ? { summary: description } : {}),
      ...(listing?.listedOn ? { listedOn: listing.listedOn } : {}),
      statedDates: listing?.dateText ? { listed: listing.dateText } : {},
    };
    const publishedDate = parseStatedDate(listing?.dateText ?? null);

    if (!pdfUrl || !onHosts(pdfUrl)) {
      if (pdfUrl) ctx.note(`${ref.externalId}: the PDF is on another host (${new URL(pdfUrl).hostname}); the page's description is kept.`);
      return {
        kind: "document",
        document: {
          externalId: ref.externalId,
          docType: "report",
          title,
          citations: [],
          agency: AGENCY,
          publishedDate,
          documentYear: null,
          precedentialStatus: "not_applicable",
          officialUrl: pageResponse.url,
          text: description,
          textKind: description ? "full" : "none",
          metadata: {
            ...metadata,
            ...(pdfUrl ? { pdfUrl } : {}),
            ...(linked.length > 1 ? { linkedPdfs: linked.map((l) => ({ title: l.text, url: l.url })) } : {}),
          },
          fetch: { response: pageResponse },
        },
      };
    }
    return fetchPdfDocument(ctx, ref, pdfUrl, {
      title,
      publishedDate,
      documentYear: null,
      officialUrl: pageResponse.url,
      metadata,
    });
  },
};
