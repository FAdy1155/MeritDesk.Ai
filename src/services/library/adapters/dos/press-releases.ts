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
import { decodeHtml, isVisaRelevant, parsePressArticle, parseRssFeed, type FeedItem } from "./parse";

// State Department press releases that concern visas and immigration, from
// the press-release feed on www.state.gov: visa restrictions and sanctions
// under INA 212(a)(3)(C) and presidential proclamations, visa policy and
// processing announcements, immigration and migration, refugees and asylum,
// deportation, exchange visitors. Each release is read from its own page
// (headline, document type such as "Press Statement" or "Media Note", the
// issuing office, the date the page states, the body).
//
// - The feed holds ten releases a page, newest first, and pages back with
//   ?paged=N. Daily: pages until one reaches releases older than the last
//   run (at most DAILY_PAGES). Backfill: BACKFILL_PAGES feed pages per
//   chunk, until the feed has no more pages.
// - Which releases are kept is decided by their own title and opening words
//   (isVisaRelevant in ./parse.ts); the rest are not fetched.
// - www.state.gov's robots.txt asks for 5 seconds between requests. When
//   this collector was written the site answered automated requests from
//   the test machine with HTTP 403 ("Technical Difficulties"); the
//   collector does not try to get around it, the run fails with that answer
//   and /library shows the source as failing.
// - The source is kept up to date by import from the official site
//   (../../manual-import.ts): a release's page saved as HTML. Its id is the
//   WordPress post number the page states (the feed's own key), and it is
//   kept only when its title and opening pass the same visa-and-immigration
//   test the feed's entries do. The feed's own date line, which only the
//   feed states, is left out.
//
// US government work: public domain, stored in full.

const FEED_URL = "https://www.state.gov/rss-feed/press-releases/feed/";
const HOSTS = ["www.state.gov"] as const;
const AGENCY = "U.S. Department of State";
const DAILY_PAGES = 15;
const FIRST_RUN_PAGES = 3;
const BACKFILL_PAGES = 30;

type Listing = { title: string; pubDate: string | null; creator: string | null; feedPage: number };

function feedPageUrl(page: number): string {
  return page === 1 ? FEED_URL : `${FEED_URL}?paged=${page}`;
}

/** One feed page's items; null when the feed has no such page (past its end). */
async function readFeedPage(ctx: LibraryAdapterContext, page: number): Promise<FeedItem[] | null> {
  const url = feedPageUrl(page);
  let text: string;
  try {
    ({ text } = await ctx.http.getText(url, { expect: "xml" }));
  } catch (err) {
    if (page > 1 && (err as { code?: unknown }).code === "http_404") return null;
    throw err;
  }
  const items = parseRssFeed(text);
  if (!items) throw new LibraryLayoutError(url, "not an RSS feed");
  if (page === 1 && items.length === 0) throw new LibraryLayoutError(url, "the feed lists no releases");
  return items;
}

function refFor(item: FeedItem, page: number): DocumentRef | null {
  let url: URL;
  try {
    url = new URL(item.link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !HOSTS.includes(url.hostname as (typeof HOSTS)[number])) return null;
  const listing: Listing = { title: item.title, pubDate: item.pubDate, creator: item.creator, feedPage: page };
  return {
    externalId: item.postId ? `post-${item.postId}` : url.pathname,
    url: url.toString(),
    title: item.title,
    fingerprint: sha256Hex([url.toString(), item.title, item.pubDate ?? ""].join("\u0000")).slice(0, 32),
    listing,
  };
}

function relevantRefs(items: FeedItem[], page: number): DocumentRef[] {
  return items
    .filter((item) => isVisaRelevant(item.title, item.descriptionText))
    .map((item) => refFor(item, page))
    .filter((r): r is DocumentRef => r !== null);
}

/** The item's date as YYYY-MM-DD (the feed's RFC 822 date, calendar date as written). */
function itemDay(item: FeedItem): string | null {
  return parseStatedDate(item.pubDate);
}

export const dosPressReleasesAdapter: LibrarySourceAdapter = {
  code: "dos_press_releases_visas",
  group: "other-agency-guidance",
  name: "State Department press releases on visas and immigration",
  description:
    "State Department press statements and media notes on visas, visa restrictions, immigration, migration, refugees and exchange visitors, read from www.state.gov's press-release feed and each release's page.",
  coverage:
    "The releases in www.state.gov's press-release feed whose title or opening concerns visas or immigration, as far back as the feed pages go; other releases are left out.",
  cadence: "Daily",
  officialUrl: FEED_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,

  async listUpdates(ctx, since) {
    const refs: DocumentRef[] = [];
    // A day of margin before the last run, since the feed's dates are calendar dates.
    const cutoff = since ? new Date(since.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;
    const pages = cutoff ? DAILY_PAGES : FIRST_RUN_PAGES;
    for (let page = 1; page <= pages; page++) {
      const items = await readFeedPage(ctx, page);
      if (!items || items.length === 0) break;
      refs.push(...relevantRefs(items, page));
      const oldest = items.map(itemDay).filter((d): d is string => Boolean(d)).sort()[0];
      if (cutoff && oldest && oldest < cutoff) break;
      if (cutoff && page === pages) ctx.note(`The feed's first ${pages} pages all postdate the last run; older releases are picked up by backfill.`);
    }
    const seen = new Set<string>();
    return { refs: refs.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true))) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const start = cursor && typeof cursor === "object" && Number.isInteger((cursor as { page?: unknown }).page) ? Math.max(1, (cursor as { page: number }).page) : 1;
    const refs: DocumentRef[] = [];
    let page = start;
    let ended = false;
    for (; page < start + BACKFILL_PAGES; page++) {
      const items = await readFeedPage(ctx, page);
      if (!items || items.length === 0) {
        ended = true;
        break;
      }
      refs.push(...relevantRefs(items, page));
    }
    const seen = new Set<string>();
    return {
      refs: refs.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true))),
      nextCursor: ended ? null : { page },
      progress: `feed pages ${start} to ${page - 1}${ended ? " (the end of the feed)" : ""}: ${refs.length} release(s) on visas or immigration`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const response = await ctx.http.get(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const html = decodeHtml(response.body, response.charset);
    const article = parsePressArticle(html);
    if (!article) throw new LibraryLayoutError(response.url, "no <article> on the release page");
    const text = htmlToDocumentText(article.bodyHtml);
    const dateText = article.publishDateText ?? listing?.pubDate ?? null;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "notice",
        title: article.title ?? listing?.title ?? ref.externalId,
        citations: [],
        agency: article.bureau ? `${AGENCY}, ${article.bureau}` : AGENCY,
        publishedDate: parseStatedDate(dateText),
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text,
        metadata: {
          ...(article.documentType ? { documentType: article.documentType } : {}),
          ...(article.bureau ? { issuedBy: article.bureau } : {}),
          ...(article.postId ? { postId: article.postId } : {}),
          ...(article.tags.length ? { tags: article.tags } : {}),
          statedDates: {
            ...(article.publishDateText ? { published: article.publishDateText } : {}),
            ...(listing?.pubDate ? { feedPubDate: listing.pubDate } : {}),
            ...(article.modifiedIso ? { modified: article.modifiedIso } : {}),
          },
        },
        fetch: { response },
      },
    };
  },

  manualImportPaths: [
    {
      // Releases are at /releases/<office>/<year>/<month>/<name>/ (and, before 2025, at /<name>/).
      path: /^\/(?:releases\/[\w-]+\/\d{4}\/\d{2}\/)?[\w-]+\/?$/,
      file: "html",
      role: "document",
      label: "A press release's page on www.state.gov (https://www.state.gov/releases/...), saved as HTML",
    },
  ],
  manualImportIntervalDays: 35,
  async parseImported(ctx, input) {
    const article = parsePressArticle(decodeHtml(input.bytes, null));
    if (!article) throw new LibraryLayoutError(input.url, "no <article> on the release page");
    if (!isVisaRelevant(article.title ?? "", htmlToDocumentText(article.bodyHtml))) {
      return { kind: "skip", reason: "This release is not about visas or immigration (its title and opening do not mention them), so this source does not hold it." };
    }
    const url = new URL(input.url);
    const ref: DocumentRef = { externalId: article.postId ? `post-${article.postId}` : url.pathname, url: input.url, title: article.title ?? undefined };
    return dosPressReleasesAdapter.fetchDocument(ctx, ref);
  },
};
