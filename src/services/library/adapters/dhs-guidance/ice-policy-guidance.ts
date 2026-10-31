import { parseStatedDate } from "@/services/monitoring/parse/dates";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { fetchFileText, fileFields, fileMetadata, fingerprintOf } from "./files";
import { directiveDesignation, isFileUrl, isPdfUrl, parseFoiaCategories, parseFoiaListing, trailingTitleDate, type FoiaItem } from "./parse";

// ICE's policy guidance as ICE publishes it in its FOIA Library: the
// "Policies, Procedures and Manuals" category (ICE, ERO and HSI directives,
// policy memoranda, handbooks and the legacy DRO policy memoranda),
// "Prosecutorial Discretion" and "Bond Processing". The library is a
// filterable list, newest added first, 25 items a page; the category ids are
// read from the page's own Category select each run, so a renumbered
// category is followed and a removed one fails the run.
//
// - Daily: the first pages of each category, walking on while the items are
//   newer than the last successful run (fingerprints skip what is unchanged).
// - Backfill: every page of each category, PAGES_PER_CHUNK pages per chunk.
// - Each item is one document: its PDF (most are scans of signed memoranda
//   with a text layer; those without one are kept with their listing data
//   and link) or, rarely, an ICE page.
//
// The other FOIA Library categories (contracts, audits, inspection and
// death reports, FOIA logs, statistics) are not guidance and are left out.
// US government work: public domain, stored in full.

const LIBRARY_URL = "https://www.ice.gov/foia/library";
const HOSTS = ["www.ice.gov", "ice.gov"] as const;
const AGENCY = "U.S. Immigration and Customs Enforcement";
/** The FOIA Library categories this collector reads, by their label on the page. */
const CATEGORIES = ["Policies, Procedures and Manuals", "Prosecutorial Discretion", "Bond Processing"] as const;
const PAGES_PER_CHUNK = 4;
const DAILY_MAX_PAGES = 4;
/** A daily run also re-reads items added this long before the last success (late indexing). */
const DAILY_OVERLAP_MS = 14 * 24 * 60 * 60 * 1000;

type Category = { label: string; id: string };
type Cursor = { categories: Category[]; index: number; page: number };

type Listing = {
  title: string;
  category: string;
  trailing: string[];
  description: string | null;
  postedDateTime: string | null;
  listedOn: string;
};

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return (
    Boolean(c) &&
    Array.isArray(c.categories) &&
    c.categories.every((x) => typeof x?.label === "string" && typeof x?.id === "string") &&
    Number.isInteger(c.index) &&
    Number.isInteger(c.page)
  );
}

async function readCategories(ctx: LibraryAdapterContext): Promise<Category[]> {
  const { text } = await ctx.http.getText(LIBRARY_URL, { expect: "html" });
  const options = parseFoiaCategories(text);
  if (options.size === 0) throw new LibraryLayoutError(LIBRARY_URL, "no Category select");
  return CATEGORIES.map((label) => {
    const id = options.get(label);
    if (!id) throw new LibraryLayoutError(LIBRARY_URL, `no "${label}" category in the Category select`);
    return { label, id };
  });
}

/** The listing page of one category: the page's own filter form parameters, newest first. */
function categoryPageUrl(category: Category, page: number): string {
  const url = new URL(LIBRARY_URL);
  url.searchParams.set("field_foia_category_target_id", category.id);
  if (page > 0) url.searchParams.set("page", String(page));
  return url.toString();
}

async function readCategoryPage(ctx: LibraryAdapterContext, category: Category, page: number) {
  const url = categoryPageUrl(category, page);
  const { text, response } = await ctx.http.getText(url, { expect: "html" });
  const parsed = parseFoiaListing(text, response.url, HOSTS);
  if (!parsed.recognized) throw new LibraryLayoutError(url, "no results list");
  if (page === 0 && parsed.items.length === 0) throw new LibraryLayoutError(url, `the "${category.label}" category lists nothing`);
  for (const off of parsed.offHost) ctx.note(`${category.label}: an item links off ICE's site (${off}); it was left out.`);
  return { url, ...parsed };
}

function refFor(item: FoiaItem, category: Category, listedOn: string): DocumentRef | null {
  // Spreadsheets and word-processing files are not read; PDFs and ICE pages are.
  if (isFileUrl(item.url) && !isPdfUrl(item.url)) return null;
  const listing: Listing = {
    title: item.title,
    category: category.label,
    trailing: item.trailing.filter((t) => t !== category.label),
    description: item.description,
    postedDateTime: item.postedDateTime,
    listedOn,
  };
  return {
    externalId: new URL(item.url).pathname,
    url: item.url,
    title: item.title,
    fingerprint: fingerprintOf(item.title, item.url, item.trailing.join("|"), item.description),
    listing,
  };
}

function collect(ctx: LibraryAdapterContext, items: FoiaItem[], category: Category, listedOn: string, into: Map<string, DocumentRef>): void {
  for (const item of items) {
    const ref = refFor(item, category, listedOn);
    if (!ref) {
      ctx.note(`${category.label}: "${item.title}" is not a PDF or a page (${item.url}); it was left out.`);
      continue;
    }
    if (!into.has(ref.externalId)) into.set(ref.externalId, ref);
  }
}

export const icePolicyGuidanceAdapter: LibrarySourceAdapter = {
  code: "ice_policy_guidance",
  group: "other-agency-guidance",
  name: "ICE policies, directives and guidance (ICE FOIA Library)",
  description:
    "ICE, ERO and HSI directives, policy memoranda, handbooks and procedures, ICE's prosecutorial discretion guidance and its bond processing guidance, as ICE posts them in its FOIA Library.",
  coverage:
    "Every item in the FOIA Library's Policies, Procedures and Manuals, Prosecutorial Discretion and Bond Processing categories (2009 to the present as ICE has posted them), each read from its PDF; scans without a text layer are held with their listing data and link.",
  cadence: "Daily",
  officialUrl: LIBRARY_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 60,

  async listUpdates(ctx, since) {
    const categories = await readCategories(ctx);
    const refs = new Map<string, DocumentRef>();
    const cutoff = since ? since.getTime() - DAILY_OVERLAP_MS : null;
    for (const category of categories) {
      for (let page = 0; page < DAILY_MAX_PAGES; page++) {
        const listed = await readCategoryPage(ctx, category, page);
        collect(ctx, listed.items, category, listed.url, refs);
        const oldest = listed.items
          .map((i) => (i.postedDateTime ? Date.parse(i.postedDateTime) : NaN))
          .filter((t) => Number.isFinite(t))
          .reduce((a, b) => Math.min(a, b), Infinity);
        // Before the first success, the first page of each category; after it, walk on until older than the last run.
        if (!listed.hasNext || cutoff === null || !(oldest > cutoff)) break;
      }
    }
    return { refs: [...refs.values()] };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const state: Cursor = isCursor(cursor) ? cursor : { categories: await readCategories(ctx), index: 0, page: 0 };
    const refs = new Map<string, DocumentRef>();
    let { index, page } = state;
    let pagesRead = 0;
    const startedAt = `${state.categories[index]?.label ?? "done"}, page ${page + 1}`;
    while (index < state.categories.length && pagesRead < PAGES_PER_CHUNK) {
      const category = state.categories[index];
      const listed = await readCategoryPage(ctx, category, page).catch((err) => {
        // A stale cursor (a category renumbered since the walk began) fails only past its first page.
        if (page > 0 && err instanceof LibraryLayoutError) return null;
        throw err;
      });
      pagesRead++;
      if (listed) collect(ctx, listed.items, category, listed.url, refs);
      if (!listed || !listed.hasNext || listed.items.length === 0) {
        index++;
        page = 0;
      } else page++;
    }
    const nextCursor: Cursor | null = index < state.categories.length ? { categories: state.categories, index, page } : null;
    return {
      refs: [...refs.values()],
      nextCursor,
      progress: `from ${startedAt}: ${pagesRead} listing page(s), ${refs.size} item(s)${nextCursor ? `; next ${state.categories[index].label}, page ${page + 1}` : "; every category done"}`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.title) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const file = await fetchFileText(ctx, ref.url, ref.known);
    if (file === "not_modified") return { kind: "not_modified" };
    const statedDate = trailingTitleDate(listing.title.split("|")[0].trim());
    const designation = directiveDesignation(listing.title);
    // ICE marks a rescinded item in its listing line ("... (Apr. 20, 2010) | Rescinded August 2017").
    const rescinded = [...listing.title.split("|"), ...listing.trailing].map((t) => t.trim()).find((t) => /^Rescinded\b/i.test(t)) ?? null;
    const posted = listing.postedDateTime ? parseStatedDate(listing.postedDateTime) : null;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: /^Handbook\b/i.test(listing.title) ? "manual_section" : "policy_memorandum",
        title: listing.title,
        citations: designation ? [designation] : [],
        agency: AGENCY,
        publishedDate: parseStatedDate(statedDate),
        precedentialStatus: "not_applicable",
        ...fileFields(file),
        withdrawn: rescinded ? { reason: `ICE's FOIA Library lists it as "${rescinded}".` } : null,
        metadata: {
          foiaLibraryCategory: listing.category,
          ...(listing.trailing.length ? { listingNotes: listing.trailing } : {}),
          ...(listing.description ? { summary: listing.description, summaryKind: "listing description" } : {}),
          ...(designation ? { designation } : {}),
          listedOn: listing.listedOn,
          ...(posted ? { addedToFoiaLibrary: posted } : {}),
          statedDates: {
            ...(statedDate ? { inTitle: statedDate } : {}),
            ...(listing.postedDateTime ? { addedToFoiaLibrary: listing.postedDateTime } : {}),
          },
          ...fileMetadata(file),
        },
      },
    };
  },
};
