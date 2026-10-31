import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import { LibraryLayoutError, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fetchPdf, fingerprintOf } from "./common";
import { gaoProductId, immigrationTerms, isImmigrationMatch, parseGaoProductPage, parseRss } from "./parse";

// New GAO reports on immigration, from the Government Accountability
// Office's own site (www.gao.gov):
//
// - The listing is GAO's "Reports" RSS feed (https://www.gao.gov/rss/reports.xml,
//   the newest 25 reports with their highlights). A report is kept when its
//   title or highlights use an immigration term (./parse.ts, immigrationTerms);
//   the terms found are recorded in metadata.matchedTerms.
// - Each kept report is read from its product page (title, GAO number, the
//   "Published ... Publicly Released ..." line, Fast Facts, Highlights,
//   topics and subject terms, and the "Full Report" PDF link) and the full
//   report PDF.
// - GAO's robots.txt asks for 420 seconds between requests; ctx.http caps a
//   Crawl-delay at 10 minutes (http/host-gate.ts), so the 420 seconds are
//   honored: a report costs about 14 minutes (product page and PDF). The
//   wait for the host's turn is not part of a request's timeout.
// - History: GAO's report listings (/reports-testimonies) answer automated
//   clients with HTTP 403 (Akamai), and the site has no XML sitemap, so this
//   collector cannot walk GAO's archive; the backfill is the current feed.
//   Reports from 1989 to 2008 come from GovInfo's GAO Reports collection
//   (./govinfo-gao-reports.ts).
//
// GAO's work is a US government work: public domain, stored in full (GAO's
// copyright notice, https://www.gao.gov/copyright, notes that GAO products may
// contain third-party images, which are not stored: only the text is).

const FEED_URL = "https://www.gao.gov/rss/reports.xml";
const HOSTS = ["www.gao.gov", "gao.gov"] as const;
const AGENCY = "U.S. Government Accountability Office";
/** A full report PDF can be slow to come from gao.gov. */
const GAO_TIMEOUT_MS = 240_000;

type Listing = { productId: string; feedTitle: string; pubDate: string | null; matchedTerms: string[] };

async function readFeed(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text } = await ctx.http.getText(FEED_URL, { expect: "xml", timeoutMs: GAO_TIMEOUT_MS });
  const feed = parseRss(text);
  if (!feed.recognized) throw new LibraryLayoutError(FEED_URL, "not an RSS feed (no <rss><channel>)");
  if (feed.items.length === 0) throw new LibraryLayoutError(FEED_URL, "the feed lists no reports");
  const refs: DocumentRef[] = [];
  let other = 0;
  for (const item of feed.items) {
    const productId = gaoProductId(item.link);
    if (!productId) {
      ctx.note(`A feed item links ${item.link}, not a GAO product page; left out.`);
      continue;
    }
    const terms = immigrationTerms(`${item.title}\n${item.description ?? ""}`);
    if (!isImmigrationMatch(terms)) {
      other++;
      continue;
    }
    const listing: Listing = { productId, feedTitle: item.title, pubDate: item.pubDate, matchedTerms: terms };
    refs.push({
      externalId: productId,
      url: item.link,
      title: `${productId} ${item.title}`,
      fingerprint: fingerprintOf(item.title, item.link, item.description),
      listing,
    });
  }
  ctx.note(`GAO's feed lists ${feed.items.length} reports; ${refs.length} concern immigration, ${other} do not.`);
  return refs;
}

export const gaoReportsAdapter: LibrarySourceAdapter = {
  code: "gao_immigration_reports",
  group: "oversight-reports",
  name: "GAO reports on immigration (gao.gov)",
  description:
    "Reports of the Government Accountability Office on immigration, border and immigration-agency matters, found through GAO's reports feed and read from each report's product page and full-report PDF.",
  coverage:
    "Immigration reports among those GAO's reports feed has listed since this collector started (the feed shows the newest 25). GAO's site refuses automated access to its report archive, so earlier gao.gov reports are not collected here; 1989 to 2008 are in the GovInfo GAO collector.",
  cadence: "Daily",
  officialUrl: "https://www.gao.gov/reports-testimonies",
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 120,
  maxDocumentsPerDailyRun: 25,

  async listUpdates(ctx) {
    return { refs: await readFeed(ctx) };
  },

  async backfill(ctx) {
    // The feed is the only listing gao.gov serves to an automated client (see the file comment).
    return { refs: await readFeed(ctx), nextCursor: null, progress: "GAO's reports feed (its newest 25 reports)" };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.productId) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const { text: html, response: pageResponse } = await ctx.http.getText(ref.url, { expect: "html", timeoutMs: GAO_TIMEOUT_MS });
    const page = parseGaoProductPage(html, pageResponse.url);
    if (!page) throw new LibraryLayoutError(ref.url, "no GAO product title (h1 on a product node)");
    const fullReport = page.files.find((f) => /^full report$/i.test(f.label)) ?? page.files.find((f) => /accessible pdf/i.test(f.label)) ?? null;
    const statedDates: Record<string, string> = {};
    if (page.publishedText) statedDates.published = page.publishedText;
    if (page.releasedText) statedDates.publiclyReleased = page.releasedText;
    if (listing.pubDate) statedDates.feedPubDate = listing.pubDate;
    const reportNumber = page.reportNumber ?? listing.productId;
    const summary = page.highlights ?? page.fastFacts;
    const metadata: Record<string, unknown> = {
      reportNumber,
      ...(page.dateLine ? { dateLine: page.dateLine } : {}),
      ...(summary ? { summary, summaryKind: page.highlights ? "highlights" : "fast facts" } : {}),
      ...(page.fastFacts && page.highlights ? { fastFacts: page.fastFacts } : {}),
      topics: page.topics,
      subjectTerms: page.subjectTerms,
      files: page.files,
      matchedTerms: listing.matchedTerms,
      listedOn: FEED_URL,
      statedDates,
    };
    const base = {
      externalId: ref.externalId,
      docType: "report" as const,
      title: page.title,
      citations: [reportNumber],
      agency: AGENCY,
      publishedDate: parseStatedDate(page.publishedText),
      precedentialStatus: "not_applicable" as const,
      officialUrl: pageResponse.url,
    };

    if (!fullReport || !/\.pdf(?:$|\?)/i.test(fullReport.url)) {
      // A product with no report file (some products are published as a page only): the page's own text.
      const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html)?.[1] ?? "";
      const text = [page.fastFacts, page.highlights].filter(Boolean).join("\n\n") || htmlToDocumentText(main);
      ctx.note(`${ref.externalId}: the product page links no full-report PDF; its Fast Facts and Highlights were kept.`);
      return {
        kind: "document",
        document: { ...base, text, textKind: text ? "excerpt" : "none", metadata: { ...metadata, textNote: "GAO's page links no full-report PDF; the text is the page's Fast Facts and Highlights." }, fetch: { response: pageResponse } },
      };
    }
    const pdf = await fetchPdf(ctx, fullReport.url, ref.known, { label: ref.externalId, timeoutMs: GAO_TIMEOUT_MS });
    if (pdf === "not_modified") return { kind: "not_modified" };
    return {
      kind: "document",
      document: {
        ...base,
        originalUrl: pdf.response.url,
        text: pdf.text,
        textKind: pdf.textKind,
        metadata: { ...metadata, pageCount: pdf.pageCount, ...(pdf.noTextLayer ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}) },
        original: pdf.original,
        fetch: pdf.fetch,
      },
    };
  },
};
