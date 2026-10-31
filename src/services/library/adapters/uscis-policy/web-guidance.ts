import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { fetchUscisFile, fingerprintOf, permanentFetchProblem, readSitemap, sinceFilter, SITEMAP_URL, USCIS_AGENCY, USCIS_HOSTS } from "./common";
import { parseUscisPage, urlPath, type SitemapUrl } from "./parse";

// USCIS's standing web guidance: the English pages of uscis.gov that
// explain the benefits and how USCIS administers them (green cards,
// humanitarian programs, working in the United States, family,
// citizenship, adoption, military, laws and policy, administrative appeals,
// Form I-9 and employment verification, scams), and the pages USCIS keeps
// in its archive, read from the site map.
//
// - The site map lists every page with its lastmod; a page's fingerprint is
//   its address and lastmod, so it is read again when USCIS changes it.
// - Daily: pages whose lastmod is since the last run (with a margin).
//   Backfill: every page in scope, current sections first, then the
//   archive, each newest first, PAGE_SIZE a chunk.
// - A page USCIS marks "Archived Content" is stored flagged withdrawn with
//   USCIS's own notice as the reason.
// - Left to other collectors: the Policy Manual, the newsroom, the Policy
//   Memoranda listing, the TRIG pages, the Electronic Reading Room, form
//   pages and the forms archive (USCIS forms), the Handbook for Employers
//   (M-274) and the AAO Practice Manual (other agency manuals and
//   guidance), the TPS pages (TPS), the monthly adjustment of status filing
//   charts (Visa Bulletin), and Spanish pages (/es/,
//   translations of these). Agency pages (about us, offices, outreach
//   events, tools, the citizenship resource center's teaching material,
//   genealogy, SAVE for agencies) are not guidance and are not collected.

const PAGE_SIZE = 100;
const SECTIONS = new Set([
  "green-card",
  "humanitarian",
  "working-in-the-united-states",
  "family",
  "citizenship",
  "adoption",
  "military",
  "laws-and-policy",
  "administrative-appeals",
  "i-9-central",
  "scams-fraud-and-misconduct",
  "visit-the-united-states",
  "archive",
  "archive-alerts",
  "archive-laws",
]);
const ARCHIVE_SECTIONS = new Set(["archive", "archive-alerts", "archive-laws"]);
const OWNED_ELSEWHERE = [
  /^\/laws-and-policy\/policy-memoranda(\/|$)/,
  /^\/laws-and-policy\/other-resources\/terrorism-related-inadmissibility-grounds-trig(\/|$)/,
  /^\/archive\/archive-memos$/,
  // USCIS's manuals are collected with the other agency manuals (group other-agency-guidance).
  /^\/i-9-central\/form-i-9-resources\/handbook-for-employers-m-274(\/|$)/,
  /^\/administrative-appeals\/aao-practice-manual(\/|$)/,
  // The TPS overview and country pages (uscis_tps, group tps) and the
  // monthly adjustment of status filing charts (uscis_aos_filing_charts,
  // group visa-bulletin) have collectors of their own.
  /^\/humanitarian\/temporary-protected-status(\/|$)/,
  /^\/green-card\/green-card-processes-and-procedures\/visa-availability-priority-dates\/(?:adjustment-of-status-filing-charts-from-the-visa-bulletin|when-to-file-your-adjustment-of-status-application)/,
];

type Listing = { section: string; lastmod: string | null };
type Cursor = { offset: number };

function isCursor(value: unknown): value is Cursor {
  return Boolean(value) && Number.isInteger((value as Cursor).offset) && (value as Cursor).offset >= 0;
}

function inScope(u: SitemapUrl): string | null {
  let url: URL;
  try {
    url = new URL(u.loc);
  } catch {
    return null;
  }
  if (url.hostname !== "www.uscis.gov" || url.search) return null;
  const path = url.pathname;
  const section = path.split("/")[1] ?? "";
  if (!SECTIONS.has(section)) return null;
  if (OWNED_ELSEWHERE.some((re) => re.test(path))) return null;
  return section;
}

async function listAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const urls = await readSitemap(ctx);
  const seen = new Set<string>();
  const current: DocumentRef[] = [];
  const archived: DocumentRef[] = [];
  for (const u of urls) {
    const section = inScope(u);
    if (!section) continue;
    const path = urlPath(u.loc);
    if (seen.has(path)) continue;
    seen.add(path);
    const listing: Listing = { section, lastmod: u.lastmod };
    const ref: DocumentRef = { externalId: path, url: u.loc, title: path, fingerprint: fingerprintOf(u.loc, u.lastmod), listing };
    (ARCHIVE_SECTIONS.has(section) ? archived : current).push(ref);
  }
  if (current.length < 100) throw new LibraryLayoutError(SITEMAP_URL, `only ${current.length} guidance pages in the site map`);
  const newest = (refs: DocumentRef[]) =>
    refs.sort((x, y) => ((y.listing as Listing).lastmod ?? "").localeCompare((x.listing as Listing).lastmod ?? "") || x.externalId.localeCompare(y.externalId));
  return [...newest(current), ...newest(archived)];
}

export const uscisWebGuidanceAdapter: LibrarySourceAdapter = {
  code: "uscis_web_guidance",
  group: "uscis-policy-guidance",
  name: "USCIS web guidance",
  description:
    "USCIS's standing guidance on uscis.gov (green cards, humanitarian programs, work, family, citizenship, adoption, military, laws and policy, appeals, Form I-9) and the pages it keeps in its archive, each read from its page.",
  coverage:
    "Every English page the uscis.gov site map lists in those sections and in the archive (about 1,000 current and 2,500 archived pages in October 2026); archived pages are flagged withdrawn with USCIS's archive notice.",
  cadence: "Daily",
  officialUrl: "https://www.uscis.gov/",
  hosts: USCIS_HOSTS,
  license: "public_domain",
  staleAfterHours: 72,
  // The site map's lastmod catches edits; the conditional re-check is a backstop.
  recheckAfterDays: 120,
  maxDocumentsPerDailyRun: 150,

  async listUpdates(ctx, since) {
    const all = await listAll(ctx);
    return { refs: sinceFilter(all, (r) => ((r.listing as Listing).lastmod ?? "").slice(0, 10) || null, since, 2, 30) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const all = await listAll(ctx);
    const offset = isCursor(cursor) ? cursor.offset : 0;
    if (offset >= all.length) return { refs: [], nextCursor: null, progress: "every page is done" };
    const refs = all.slice(offset, offset + PAGE_SIZE);
    const next = offset + refs.length;
    return { refs, nextCursor: next < all.length ? { offset: next } : null, progress: `pages ${offset + 1} to ${next} of ${all.length} (current sections first, then the archive)` };
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
    if (file.kind !== "html") return { kind: "skip", reason: `${file.response.url} is not a web page.` };
    const page = parseUscisPage(file.html);
    if (!page) return { kind: "skip", reason: `${file.response.url} has no article (a listing or a landing page).` };
    const text = htmlToDocumentText(page.articleHtml);
    if (!page.title || !text) return { kind: "skip", reason: `${file.response.url} has no title or text.` };
    const moved = urlPath(file.response.url) !== ref.externalId;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "web_guidance",
        title: page.title,
        citations: [],
        agency: USCIS_AGENCY,
        // "Last Reviewed/Updated" is the date USCIS states for the page's current content.
        publishedDate: parseStatedDate(page.reviewedDateText) ?? parseStatedDate(page.releaseDateText),
        precedentialStatus: "not_applicable",
        officialUrl: file.response.url,
        text,
        metadata: {
          section: listing?.section ?? urlPath(ref.url).split("/")[1],
          nodeType: page.nodeType,
          ...(page.alerts.length ? { alerts: page.alerts } : {}),
          ...(moved ? { listedAt: ref.url } : {}),
          statedDates: {
            ...(page.reviewedDateText ? { lastReviewedUpdated: page.reviewedDateText } : {}),
            ...(page.releaseDateText ? { released: page.releaseDateText } : {}),
          },
          ...(listing?.lastmod ? { sitemapLastmod: listing.lastmod } : {}),
        },
        withdrawn: page.archivedNotice ? { reason: `USCIS marks this page: ${page.archivedNotice}` } : null,
        fetch: { response: file.response },
      },
    };
  },
};
