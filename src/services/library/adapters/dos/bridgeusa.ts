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
import { chunkOf } from "./chunk";
import { decodeHtml, parseBridgeUsaPage, parseSitemap, type SitemapEntry } from "./parse";

// BridgeUSA, the State Department's Exchange Visitor (J-1) Program site
// (j1visa.state.gov): its guidance pages for participants, sponsors and
// hosts (eligibility and fees, the DS-2019, program categories, sponsor
// regulations and compliance, SEVIS guidance, common questions, program
// resource pages) and its news posts, each page or post a document.
//
// - Daily and backfill read the site's sitemaps (pages and posts) with
//   their last-modified dates; a page's fingerprint includes its date, so
//   only pages the site changed are fetched again. Backfill walks the most
//   recently changed first.
// - The site's robots.txt disallows every /wp- path (uploads included), so
//   the PDFs it links (rules, Federal Register reprints, guidance
//   directives) are not read; the pages that link them are.
// - Video, search and test pages are left out (SKIP_PATHS), and a page
//   whose content column has no text is skipped.
//
// US government work: public domain, stored in full.

const SITEMAP_INDEX_URL = "https://j1visa.state.gov/sitemap_index.xml";
const HOME_URL = "https://j1visa.state.gov/";
const HOSTS = ["j1visa.state.gov"] as const;
const AGENCY = "U.S. Department of State, Bureau of Educational and Cultural Affairs";
const PAGE_SIZE = 100;
/** The sitemaps of the site's pages and posts (the others list events, categories and authors). */
const WANTED_SITEMAP = /\/(page|post)-sitemap\d*\.xml$/i;
const SKIP_PATHS = [/^\/search\/?$/i, /^\/participants\/videos\//i, /(^|[-/])test([-/]|$)/i, /^\/routej1\/shareyourj1story\/?$/i];

type Listing = { kind: "page" | "post"; lastmod: string | null; sitemap: string };

async function listEntries(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text: indexXml } = await ctx.http.getText(SITEMAP_INDEX_URL, { expect: "xml" });
  const index = parseSitemap(indexXml);
  if (!index || index.kind !== "index") throw new LibraryLayoutError(SITEMAP_INDEX_URL, "not a sitemap index");
  const sitemaps = index.entries.filter((e) => WANTED_SITEMAP.test(new URL(e.loc).pathname));
  if (!sitemaps.length) throw new LibraryLayoutError(SITEMAP_INDEX_URL, "no page or post sitemap listed");
  const refs: DocumentRef[] = [];
  const seen = new Set<string>();
  for (const sitemap of sitemaps) {
    const { text } = await ctx.http.getText(sitemap.loc, { expect: "xml" });
    const parsed = parseSitemap(text);
    if (!parsed || parsed.kind !== "urlset" || !parsed.entries.length) throw new LibraryLayoutError(sitemap.loc, "no URLs in the sitemap");
    const kind: Listing["kind"] = /post-sitemap/i.test(sitemap.loc) ? "post" : "page";
    for (const entry of parsed.entries as SitemapEntry[]) {
      let url: URL;
      try {
        url = new URL(entry.loc);
      } catch {
        continue;
      }
      if (url.protocol !== "https:" || url.hostname !== "j1visa.state.gov" || url.pathname === "/" || SKIP_PATHS.some((p) => p.test(url.pathname))) continue;
      if (seen.has(url.pathname)) continue;
      seen.add(url.pathname);
      const listing: Listing = { kind, lastmod: entry.lastmod, sitemap: sitemap.loc };
      refs.push({
        externalId: url.pathname,
        url: url.toString(),
        title: url.pathname,
        fingerprint: sha256Hex([url.toString(), entry.lastmod ?? ""].join("\u0000")).slice(0, 32),
        listing,
      });
    }
  }
  // Most recently changed first.
  return refs.sort((a, b) => ((b.listing as Listing).lastmod ?? "").localeCompare((a.listing as Listing).lastmod ?? ""));
}

export const dosBridgeUsaAdapter: LibrarySourceAdapter = {
  code: "dos_bridgeusa_j1",
  group: "other-agency-guidance",
  name: "BridgeUSA Exchange Visitor (J-1) guidance (State Department)",
  description:
    "The State Department's Exchange Visitor Program guidance on j1visa.state.gov for participants, sponsors and hosts (program categories, the DS-2019, sponsor rules and compliance, SEVIS), and its news posts.",
  coverage: "Every page and post in j1visa.state.gov's sitemaps (about 290), except video, search and test pages; the PDFs the site links are disallowed by its robots.txt and not read.",
  cadence: "Daily",
  officialUrl: HOME_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 60,

  async listUpdates(ctx) {
    return { refs: await listEntries(ctx) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    return chunkOf(await listEntries(ctx), cursor, PAGE_SIZE);
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const response = await ctx.http.get(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const html = decodeHtml(response.body, response.charset);
    const page = parseBridgeUsaPage(html);
    if (!page) throw new LibraryLayoutError(response.url, "no page heading (#page-title)");
    const text = htmlToDocumentText(page.bodyHtml);
    if (text.replace(page.title ?? "", "").trim().length < 40) return { kind: "skip", reason: `${ref.externalId}: the page has no guidance text (only links or media).` };
    const modified = parseStatedDate(page.modifiedIso);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: listing?.kind === "post" ? "notice" : "web_guidance",
        // A blog post's page heading is the blog's name; the post's own title is its heading.
        title: page.postTitle ?? page.title ?? ref.externalId,
        citations: [],
        agency: AGENCY,
        publishedDate: parseStatedDate(page.publishedIso),
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text,
        metadata: {
          program: "BridgeUSA (Exchange Visitor Program, J-1)",
          kind: listing?.kind ?? null,
          ...(page.postTitle && page.title ? { blog: page.title } : {}),
          ...(page.categories.length ? { categories: page.categories } : {}),
          ...(modified ? { pageModified: modified } : {}),
          statedDates: {
            ...(page.publishedIso ? { published: page.publishedIso } : {}),
            ...(page.modifiedIso ? { modified: page.modifiedIso } : {}),
            ...(listing?.lastmod ? { sitemapLastmod: listing.lastmod } : {}),
          },
        },
        fetch: { response },
      },
    };
  },
};
