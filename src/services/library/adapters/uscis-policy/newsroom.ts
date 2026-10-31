import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryDocType,
  type LibrarySourceAdapter,
} from "../../types";
import { fetchUscisFile, fingerprintOf, pdfExtraction, pdfOriginal, permanentFetchProblem, sinceFilter, USCIS_AGENCY, USCIS_HOSTS } from "./common";
import { httpsForUscis, parseListingPage, parseRss, parseUscisPage, rssDate, urlPath } from "./parse";

// USCIS news and alerts: the newsroom's "All News" listing
// (https://www.uscis.gov/newsroom/all-news): news releases, alerts and
// stakeholder messages, each read from its own page.
//
// - Daily: the listing's RSS feed (its newest entries), those dated since
//   the last run with a margin.
// - Backfill: the listing's pages, newest first, following its "next" link
//   (10 entries a page); the cursor is the next page's link.
// - Legal updates: alerts only ("USCIS policy alert"); news releases are
//   announcements, not policy.
// Older news USCIS has moved to its archive (/archive/...) is collected
// with the archived web pages (uscis_web_guidance).

const ALL_NEWS_URL = "https://www.uscis.gov/newsroom/all-news";
const RSS_URL = "https://www.uscis.gov/news/rss-feed/59144";
const PAGES_PER_CHUNK = 5;

type Listing = { title: string; dateText: string | null; date: string | null; teaser: string; listedOn: string };

type Cursor = { next: string; page: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && typeof c.next === "string" && c.next.startsWith(ALL_NEWS_URL) && Number.isInteger(c.page);
}

function onUscis(url: string): boolean {
  try {
    return new URL(url).hostname === "www.uscis.gov";
  } catch {
    return false;
  }
}

function refOf(url: string, listing: Listing): DocumentRef {
  return {
    externalId: urlPath(url),
    url,
    title: listing.title,
    // The parsed date, not the text: the feed and the listing pages write the same date differently.
    fingerprint: fingerprintOf(listing.title, url, listing.date),
    listing,
  };
}

/** The kind of item, from the newsroom section its address is in. */
function newsTypeOf(url: string): string {
  const section = /^\/newsroom\/([^/]+)\//.exec(urlPath(url))?.[1] ?? "";
  const known: Record<string, string> = {
    "news-releases": "News release",
    alerts: "Alert",
    "stakeholder-messages": "Stakeholder message",
    "fact-sheets": "Fact sheet",
    "speeches-statements-testimony": "Speech, statement or testimony",
  };
  return known[section] ?? (section ? section.replace(/-/g, " ") : "News item");
}

function docTypeOf(newsType: string): LibraryDocType {
  if (newsType === "Alert" || newsType === "Stakeholder message") return "notice";
  if (newsType === "Fact sheet") return "web_guidance";
  return "other";
}

export const uscisNewsroomAdapter: LibrarySourceAdapter = {
  code: "uscis_news_alerts",
  group: "uscis-policy-guidance",
  name: "USCIS news and alerts",
  description: "The USCIS newsroom's news releases, alerts and stakeholder messages, each read from its page.",
  coverage: "Every item the newsroom's All News listing holds (about 320 in October 2026, from 2023 on); older news is in USCIS's archive, collected with the archived web pages.",
  cadence: "Daily",
  officialUrl: ALL_NEWS_URL,
  hosts: USCIS_HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 60,
  maxDocumentsPerDailyRun: 80,

  async listUpdates(ctx, since) {
    // A conditional GET: an unchanged feed (HTTP 304) has nothing new.
    const { text, unchanged } = await ctx.http.getListing(RSS_URL, { expect: "xml" });
    if (unchanged) return { refs: [] };
    const feed = parseRss(text);
    if (!feed.recognized || feed.items.length === 0) throw new LibraryLayoutError(RSS_URL, "no <item> entries in the All News feed");
    const refs: DocumentRef[] = [];
    for (const item of feed.items) {
      const url = httpsForUscis(item.link);
      if (!onUscis(url)) {
        ctx.note(`The All News feed links "${item.title}" off www.uscis.gov (${url}); it was not collected.`);
        continue;
      }
      refs.push(refOf(url, { title: item.title, dateText: item.pubDate, date: rssDate(item.pubDate), teaser: item.description, listedOn: ALL_NEWS_URL }));
    }
    return { refs: sinceFilter(refs, (r) => (r.listing as Listing).date, since, 14, 40) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const state: Cursor = isCursor(cursor) ? cursor : { next: ALL_NEWS_URL, page: 0 };
    const refs: DocumentRef[] = [];
    let next: string | null = state.next;
    let page = state.page;
    let total: number | null = null;
    for (let i = 0; i < PAGES_PER_CHUNK && next; i++) {
      const { text, response } = await ctx.http.getText(next, { expect: "html" });
      const parsed = parseListingPage(text, response.url);
      if (!parsed.recognized) throw new LibraryLayoutError(next, "not the All News listing (no listing view)");
      if (parsed.rows.length === 0 && page === 0) throw new LibraryLayoutError(next, "the first page of the listing has no entries");
      for (const note of parsed.notes) ctx.note(note);
      total = parsed.total ?? total;
      for (const row of parsed.rows) {
        if (!onUscis(row.url)) continue;
        refs.push(refOf(row.url, { title: row.title, dateText: row.dateText, date: parseStatedDate(row.dateText), teaser: row.teaser, listedOn: ALL_NEWS_URL }));
      }
      page++;
      next = parsed.rows.length && parsed.nextUrl?.startsWith(ALL_NEWS_URL) ? parsed.nextUrl : null;
    }
    return {
      refs,
      nextCursor: next ? { next, page } : null,
      progress: `listing pages ${state.page + 1} to ${page}${total ? ` (${total} items in all)` : ""}`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    let file;
    try {
      file = await fetchUscisFile(ctx, ref.url, ref.known);
    } catch (err) {
      const problem = permanentFetchProblem(err);
      if (problem) return { kind: "skip", reason: problem };
      throw err;
    }
    if (file.kind === "not_modified") return { kind: "not_modified" };
    if (file.kind === "other") return { kind: "skip", reason: `${file.response.url} is ${file.response.contentType || "an unknown file type"}, which the library does not read.` };
    const newsType = newsTypeOf(ref.url);
    if (file.kind === "pdf") {
      return {
        kind: "document",
        document: {
          externalId: ref.externalId,
          docType: docTypeOf(newsType),
          title: listing?.title ?? ref.title ?? ref.externalId,
          citations: [],
          agency: USCIS_AGENCY,
          publishedDate: listing?.date ?? null,
          precedentialStatus: "not_applicable",
          officialUrl: file.response.url,
          text: file.pdf.pagesWithText > 0 ? file.pdf.text : "",
          textKind: file.pdf.pagesWithText > 0 ? "full" : "none",
          metadata: { newsType, statedDates: listing?.dateText ? { listed: listing.dateText } : {}, listedOn: ALL_NEWS_URL },
          original: pdfOriginal(file.response),
          fetch: { response: file.response, extraction: pdfExtraction(file.pdf) },
        },
      };
    }
    const page = parseUscisPage(file.html);
    if (!page) throw new LibraryLayoutError(file.response.url, "no article on the news page");
    const released = parseStatedDate(page.releaseDateText);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: docTypeOf(newsType),
        title: page.title ?? listing?.title ?? ref.externalId,
        citations: [],
        agency: USCIS_AGENCY,
        publishedDate: released ?? listing?.date ?? null,
        precedentialStatus: "not_applicable",
        officialUrl: file.response.url,
        text: htmlToDocumentText(page.articleHtml),
        metadata: {
          newsType,
          statedDates: {
            ...(page.releaseDateText ? { released: page.releaseDateText } : {}),
            ...(page.reviewedDateText ? { lastReviewedUpdated: page.reviewedDateText } : {}),
            ...(listing?.dateText ? { listed: listing.dateText } : {}),
          },
          ...(page.alerts.length ? { alerts: page.alerts } : {}),
          listedOn: ALL_NEWS_URL,
        },
        withdrawn: page.archivedNotice ? { reason: `USCIS marks this page: ${page.archivedNotice}` } : null,
        fetch: { response: file.response },
      },
    };
  },

  legalUpdateItem(document) {
    if (document.metadata?.newsType !== "Alert") return null;
    const dates = document.metadata?.statedDates as { released?: string; listed?: string } | undefined;
    return { itemType: "USCIS policy alert", publishedDateText: dates?.released ?? dates?.listed ?? null, listedOnUrl: ALL_NEWS_URL };
  },
};

