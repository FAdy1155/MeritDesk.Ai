import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { attrValue, htmlToDocumentText, resolveUrl } from "../../extract/html";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { cachedPage, chunkOf, decodeText, fetchFileText, fileMetadata, fingerprintOf } from "./common";
import { elementContent, firstH1, parseSitemap, pathId, usdaUpdatedLine } from "./parse";

// USDA's guidance on noncitizens' eligibility for its nutrition programs
// (SNAP above all: qualified alien categories, sponsor deeming, the
// One Big Beautiful Bill Act's alien eligibility changes, and the
// "Protecting American Citizenship" program guidance), from the Food and
// Nutrition Service's site (now the Food and Nutrition Administration,
// www.fna.usda.gov; www.fns.usda.gov redirects there).
//
// The site has no guidance listing by subject, so the listing is its
// sitemap: every page whose address names aliens, noncitizens,
// citizenship, immigrants, refugees or asylees (research and contact pages
// left out). The sitemap's lastmod is the listing fingerprint. A guidance
// page that shows its memorandum in a frame (a PDF on www.usda.gov's
// guidance portal) is stored with the memorandum's text; the page is the
// official URL and the PDF the original.
//
// The site's robots.txt sets no Crawl-delay. usda.gov's edge blocks
// requests whose User-Agent mentions robots or crawling: see the hand-off
// note on the library's User-Agent. US government work: public domain,
// stored in full.
//
// Until the site lets the collector through, the source is kept up to date
// by import from the official site (../../manual-import.ts): a guidance page
// saved as HTML, whose address must pass the same test the sitemap's
// entries do, and, for a page that frames a memorandum, that PDF as the
// linked file (the collector reads both; the import says which PDF). The
// sitemap's lastmod, which only the sitemap states, is left out.

const HOSTS = ["www.fna.usda.gov", "www.fns.usda.gov", "www.usda.gov"] as const;
const SITEMAP_URL = "https://www.fna.usda.gov/sitemap.xml";
const WANTED = /alien|non-?citizen|citizenship|immigra|refugee|asylee/i;
const UNWANTED = /^\/(?:contact|research)\//i;

type Listing = { lastmod: string | null };

async function readAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text } = await cachedPage(ctx, SITEMAP_URL, { expect: "xml" });
  const index = parseSitemap(text);
  if (index.kind === null) throw new LibraryLayoutError(SITEMAP_URL, "not a sitemap or sitemap index");
  const pages = index.kind === "index" ? [] : index.entries;
  for (const child of index.kind === "index" ? index.entries : []) {
    const childUrl = resolveUrl(child.loc, SITEMAP_URL);
    if (!childUrl) continue;
    const { text: childXml } = await cachedPage(ctx, childUrl, { expect: "xml" });
    const parsed = parseSitemap(childXml);
    if (parsed.kind !== "urlset") throw new LibraryLayoutError(childUrl, "the child sitemap is not a urlset");
    pages.push(...parsed.entries);
  }
  if (pages.length < 100) throw new LibraryLayoutError(SITEMAP_URL, "the sitemap lists too few pages");
  const refs: DocumentRef[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    let u: URL;
    try {
      u = new URL(p.loc);
    } catch {
      continue;
    }
    if (!WANTED.test(u.pathname) || UNWANTED.test(u.pathname) || seen.has(u.pathname)) continue;
    seen.add(u.pathname);
    refs.push({ externalId: pathId(p.loc), url: p.loc, title: u.pathname, fingerprint: fingerprintOf(p.loc, p.lastmod), listing: { lastmod: p.lastmod } satisfies Listing });
  }
  if (refs.length === 0) throw new LibraryLayoutError(SITEMAP_URL, "no noncitizen eligibility pages among the sitemap's pages");
  return refs;
}

export const usdaFnsNoncitizenAdapter: LibrarySourceAdapter = {
  code: "usda_fns_noncitizen_eligibility",
  group: "other-agency-guidance",
  name: "USDA nutrition programs: noncitizen eligibility guidance",
  description:
    "The Food and Nutrition Service's (now Food and Nutrition Administration's) pages and policy memoranda on noncitizens' eligibility for SNAP and the other nutrition programs: qualified alien categories, sponsor deeming and the 2025 changes to alien eligibility.",
  coverage: "Every page in the site's sitemap whose address concerns aliens, noncitizens, citizenship, immigrants, refugees or asylees, with the memorandum each guidance page frames.",
  cadence: "Daily",
  officialUrl: "https://www.fna.usda.gov/snap/recipient/eligibility/non-citizen",
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 30,

  async listUpdates(ctx) {
    return { refs: await readAll(ctx) };
  },
  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const { items, nextCursor, progress } = chunkOf(await readAll(ctx), cursor, 200);
    return { refs: items, nextCursor, progress };
  },
  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const response = await ctx.http.get(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const html = decodeText(response);
    const main = elementContent(html, /<main\b[^>]*>/i);
    if (!main) return { kind: "skip", reason: `${ref.url} has no <main>.` };
    const title = (firstH1(main) ?? firstH1(html) ?? ref.externalId).replace(/\s+/g, " ");
    const updated = usdaUpdatedLine(main);
    // The body fields (the sidebar's resource type and related links are left out).
    const bodies = [...main.matchAll(/<div class="field field--name-(?:field-)?body\b[^"]*"[^>]*>/gi)].map((m) => elementContent(main.slice(m.index ?? 0), /<div\b[^>]*>/i) ?? "");
    const frame = bodies.map((b) => /<iframe\b([^>]*)>/i.exec(b)?.[1]).find(Boolean);
    const framed = frame ? resolveUrl(attrValue(frame, "src") ?? "", response.url) : null;
    let text = htmlToDocumentText(bodies.join("\n"));
    let fileMeta: Record<string, unknown> = {};
    let original = null;
    let originalUrl: string | null = null;
    if (framed && /\.pdf(?:$|\?)/i.test(framed) && HOSTS.includes(new URL(framed).hostname as (typeof HOSTS)[number])) {
      const file = await fetchFileText(ctx, framed, null);
      if (file !== "not_modified") {
        text = [text, file.text].filter(Boolean).join("\n\n");
        fileMeta = fileMetadata(file);
        original = file.original;
        originalUrl = file.response.url;
      }
    }
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: framed ? "policy_memorandum" : "web_guidance",
        title,
        citations: [],
        agency: "U.S. Department of Agriculture, Food and Nutrition Service",
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        originalUrl,
        text,
        textKind: text ? "full" : "none",
        metadata: {
          // "Page updated" is when the page last changed, not when the guidance issued.
          ...(parseStatedDate(updated) ? { updatedDate: parseStatedDate(updated) } : {}),
          ...(updated ? { statedDates: { pageUpdated: updated } } : {}),
          ...(listing?.lastmod ? { sitemapLastmod: listing.lastmod } : {}),
          ...(framed ? { framedDocument: framed } : {}),
          ...fileMeta,
        },
        original,
        fetch: { response },
      },
    };
  },

  manualImportPaths: [
    {
      // The sitemap test (WANTED, not UNWANTED) as one pattern.
      path: /^(?!\/(?:contact|research)\/)(?=[^?#]*(?:alien|non-?citizen|citizenship|immigra|refugee|asylee))\/[^?#]+$/i,
      hosts: ["www.fna.usda.gov", "www.fns.usda.gov"],
      file: "html",
      role: "document",
      label: "A guidance page on www.fna.usda.gov whose address names aliens, noncitizens, citizenship, immigrants, refugees or asylees, saved as HTML",
    },
    {
      path: /\.pdf$/i,
      file: "pdf",
      role: "linked",
      label: "For a page that shows a memorandum in a frame: that memorandum's PDF (often on www.usda.gov), downloaded as it is",
    },
  ],
  manualImportIntervalDays: 100,
  async parseImported(ctx, input) {
    const path = new URL(input.url).pathname;
    if (!WANTED.test(path) || UNWANTED.test(path)) return { kind: "skip", reason: `${input.url} is not a page this source collects.` };
    const ref: DocumentRef = { externalId: pathId(input.url), url: input.url, title: path };
    return usdaFnsNoncitizenAdapter.fetchDocument(ctx, ref);
  },
};
