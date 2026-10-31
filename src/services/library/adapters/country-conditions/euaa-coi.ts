import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { countryFields } from "./country";
import { parseEuaaList, parseEuaaPublication, type EuaaListItem, type EuaaListPage } from "./parse";

// The European Union Agency for Asylum's Country of Origin Information
// publications (COI reports, COI queries, country focus and security
// situation reports), read from EUAA's publications list filtered to the
// "Country of Origin Information" category and each publication's page.
//
// - The list shows ten publications a page, newest first; its pager's
//   "next" link leads to the following page. Daily: the first page, and
//   following pages while every publication on a page is newer than the
//   last run. Backfill: PAGES_PER_CHUNK pages per chunk following the
//   "next" links, the cursor being the next page's URL as the pager gave
//   it. A publication added while the walk runs pushes the others down a
//   place, so a page may repeat an entry (skipped by its fingerprint) but
//   none is missed.
// - Each publication's page states its title, date, geographical coverage
//   (the countries, kept as metadata.country or metadata.countries), keywords,
//   author, a short description and the PDF.
// - www.euaa.europa.eu's robots.txt sets no crawl delay, so requests go at
//   the library's default pace (about one a second).
//
// Licence: EUAA's legal notice (https://www.euaa.europa.eu/legal-notice)
// authorises reproduction "provided the source is acknowledged, save
// otherwise stated"; the COI reports quote material from other publishers,
// which EUAA does not license, and the library cannot show an
// acknowledgement beside a stored text. So the source is link_only: the
// pipeline keeps the metadata, an excerpt of the page's description and the
// link, never the report itself (docs/LIBRARY.md, section 5). The PDF is not
// downloaded.

const LIST_URL = "https://www.euaa.europa.eu/publications?field_category_target_id=15181&language=en";
const HOSTS = ["www.euaa.europa.eu", "euaa.europa.eu"] as const;
const AGENCY = "European Union Agency for Asylum";
const PAGES_PER_CHUNK = 5;
const DAILY_MAX_PAGES = 5;

type Listing = { title: string; dateText: string | null; datetime: string | null; pdfUrl: string | null; listedOn: string };
type Cursor = { url: string; page: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && typeof c.url === "string" && Number.isInteger(c.page);
}

async function readListPage(ctx: LibraryAdapterContext, url: string, first: boolean): Promise<EuaaListPage> {
  const { text, response } = await ctx.http.getText(url, { expect: "html" });
  const page = parseEuaaList(text, response.url);
  if (!page) throw new LibraryLayoutError(url, "no publications view");
  if (first && page.items.length === 0) throw new LibraryLayoutError(url, "the Country of Origin Information list shows no publications");
  return page;
}

function refFor(item: EuaaListItem, listedOn: string): DocumentRef {
  const listing: Listing = { title: item.title, dateText: item.dateText, datetime: item.datetime, pdfUrl: item.pdfUrl, listedOn };
  return {
    externalId: new URL(item.url).pathname,
    url: item.url,
    title: item.title,
    fingerprint: sha256Hex([item.url, item.title, item.datetime ?? item.dateText ?? "", item.pdfUrl ?? ""].join("\u0000")).slice(0, 32),
    listing,
  };
}

function itemTime(item: EuaaListItem): number {
  const t = new Date(item.datetime ?? parseStatedDate(item.dateText) ?? "").getTime();
  return Number.isNaN(t) ? NaN : t;
}

export const euaaCoiAdapter: LibrarySourceAdapter = {
  code: "euaa_coi_reports",
  group: "country-conditions",
  name: "EUAA Country of Origin Information reports",
  description:
    "The European Union Agency for Asylum's Country of Origin Information publications (COI reports, COI queries, country focus and security situation reports), by country. Stored as metadata, a short excerpt of the description and the link.",
  coverage:
    "Every publication EUAA's publications list shows under the Country of Origin Information category, as far back as the list's pages go.",
  cadence: "Daily",
  officialUrl: LIST_URL,
  hosts: HOSTS,
  license: "link_only",
  licenseNote:
    "EUAA authorises reproduction with acknowledgement save where otherwise stated, and its COI reports quote other publishers' material it does not license; only metadata, a short excerpt and the link are kept.",
  staleAfterHours: 48,
  recheckAfterDays: 60,

  async listUpdates(ctx, since) {
    const cutoff = since ? since.getTime() - 2 * 24 * 60 * 60 * 1000 : null;
    const refs: DocumentRef[] = [];
    let url: string | null = LIST_URL;
    for (let n = 0; url && n < (cutoff ? DAILY_MAX_PAGES : 1); n++) {
      const page = await readListPage(ctx, url, n === 0);
      refs.push(...page.items.map((i) => refFor(i, url!)));
      const times = page.items.map(itemTime).filter((t) => !Number.isNaN(t));
      if (!cutoff || times.length === 0 || Math.min(...times) < cutoff) break;
      url = page.nextUrl;
    }
    const seen = new Set<string>();
    return { refs: refs.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true))) };
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
      refs.push(...list.items.map((i) => refFor(i, url!)));
      url = list.nextUrl;
      page++;
    }
    const seen = new Set<string>();
    return {
      refs: refs.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true))),
      nextCursor: url ? { url, page } : null,
      progress: `list pages ${start.page + 1} to ${page}${lastPage ? ` of about ${lastPage + 1}` : ""}`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const { text, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const pub = parseEuaaPublication(text, response.url);
    if (!pub || !pub.title) throw new LibraryLayoutError(ref.url, "no publication title");
    const dateText = pub.dateText ?? listing?.dateText ?? null;
    const published = parseStatedDate(dateText) ?? parseStatedDate(pub.datetime ?? listing?.datetime ?? null);
    const description = pub.bodyHtml ? htmlToDocumentText(pub.bodyHtml) : "";
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "report",
        title: pub.title,
        citations: [],
        agency: AGENCY,
        publishedDate: published,
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text: description,
        textKind: description ? "excerpt" : "none",
        metadata: {
          ...countryFields(pub.geoCoverage),
          ...(pub.geoCoverage.length ? { geographicalCoverage: pub.geoCoverage } : {}),
          ...(pub.keywords.length ? { keywords: pub.keywords } : {}),
          ...(pub.author ? { author: pub.author } : {}),
          ...(pub.category ? { category: pub.category } : {}),
          ...(pub.pdfUrl ?? listing?.pdfUrl ? { pdfUrl: pub.pdfUrl ?? listing?.pdfUrl } : {}),
          ...(listing?.listedOn ? { listedOn: listing.listedOn } : {}),
          statedDates: dateText ? { published: dateText } : {},
        },
        fetch: { response },
      },
    };
  },
};
