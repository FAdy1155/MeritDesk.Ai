import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fetchGranule, granuleRefs, GOVINFO_HOST, readPackageMods } from "./govinfo";
import { parseGovinfoPackageList, type GovinfoPackageEntry } from "./parse";

// Immigration decisions of the federal district courts from GovInfo's
// United States Courts Opinions collection (USCOURTS;
// https://www.govinfo.gov/app/collection/uscourts), found with the GovInfo
// API (api.govinfo.gov, an api.data.gov key in API_DATA_GOV_KEY, sent as the
// X-Api-Key header) by the civil nature-of-suit code the court gave the case
// on its civil cover sheet (JS 44), one stream per code:
//
//   463  Habeas Corpus - Alien Detainee   (immigration detention habeas)
//   462  Naturalization Application       (including 8 U.S.C. 1447(b) delay suits)
//   465  Other Immigration Actions         (mandamus and APA suits over
//                                           immigration benefits and visas)
//
// Each case's MODS record (www.govinfo.gov, see ./govinfo.ts) gives its
// orders and opinions, each read from its PDF. Suits filed under other
// codes (an APA suit coded 890 or 899, a detention habeas from before code
// 463 was used, coded 530) are not identified: the API offers no full-text
// filter by GET, and the framework's client makes GET requests only.
//
// - Daily: /collections/USCOURTS/<since> per code (cases GovInfo added or
//   changed), each case's MODS record.
// - Backfill: /collections/USCOURTS/1900-01-01T00:00:00Z/<walk start> per
//   code, one API page (PAGE_SIZE cases) a chunk; the API's own nextPage
//   link is the cursor. The API orders that list by the time GovInfo last
//   modified each case, newest first (checked live; /published, filtered by
//   issue date, is ordered the same way, so an issue date cannot mark a
//   place in it). A cursor the API no longer accepts restarts that code
//   with the oldest modification time reached as the window's end, which
//   leaves no gap; a case GovInfo changes after the walk began is the daily
//   run's.
// - District court decisions bind no other court: stored non-precedential.
// - US government work: public domain. No legal-update feed (the feed does
//   not follow the district courts).

const API = "https://api.govinfo.gov";
const COLLECTION_URL = "https://www.govinfo.gov/app/collection/uscourts";
const KEY_ENV = "API_DATA_GOV_KEY";
const NATURES_OF_SUIT: { code: string; name: string }[] = [
  { code: "463", name: "Habeas Corpus - Alien Detainee" },
  { code: "462", name: "Naturalization Application" },
  { code: "465", name: "Other Immigration Actions" },
];
const PAGE_SIZE = 100;
const DAILY_MARGIN_DAYS = 2;
/** Daily: pages read per code at most (a GovInfo-wide reprocessing would list everything as changed). */
const DAILY_MAX_PAGES = 20;

/** endTime: when the walk began; lastModified: the oldest modification time reached in the current code. */
type Cursor = { codes: string[]; next: string | null; endTime: string; lastModified: string | null };

/** An instant as the API's path takes it ("2026-10-15T00:00:00Z"). */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function apiInstant(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && INSTANT_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return (
    Boolean(c) &&
    Array.isArray(c.codes) &&
    c.codes.every((s) => typeof s === "string") &&
    (c.next === null || typeof c.next === "string") &&
    isInstant(c.endTime) &&
    (c.lastModified === null || isInstant(c.lastModified))
  );
}

function apiHeaders(ctx: LibraryAdapterContext): Record<string, string> {
  const key = ctx.env(KEY_ENV);
  if (!key) throw new Error(`${KEY_ENV} is not set.`);
  return { "X-Api-Key": key };
}

async function readPackagePage(ctx: LibraryAdapterContext, url: string) {
  const { data } = await ctx.http.getJson(url, { headers: apiHeaders(ctx) });
  const page = parseGovinfoPackageList(data);
  if (!page) throw new LibraryLayoutError(url.replace(/[?&]api_key=[^&]*/i, ""), "not a GovInfo package list (no packages array)");
  return page;
}

/** Every opinion of these cases, as refs (the nature of suit confirmed from each case's record). */
async function refsForPackages(ctx: LibraryAdapterContext, packages: GovinfoPackageEntry[], code: string): Promise<DocumentRef[]> {
  const refs: DocumentRef[] = [];
  for (const p of packages) {
    const read = await readPackageMods(ctx, p.packageId);
    if (!read) continue;
    const nos = NATURES_OF_SUIT.find((n) => n.code === read.case.natureSuitCode);
    if (!nos) {
      ctx.note(`${p.packageId}: listed under nature of suit ${code} but its record says ${read.case.natureSuitCode ?? "none"}; left out.`);
      continue;
    }
    refs.push(...granuleRefs(read.case, read.modsUrl, [`nature of suit ${nos.code} ${nos.name}`], false, (m) => ctx.note(m)));
  }
  return refs;
}

function firstPageUrl(code: string, endTime: string): string {
  return `${API}/collections/USCOURTS/1900-01-01T00:00:00Z/${endTime}?natureSuitCode=${code}&pageSize=${PAGE_SIZE}&offsetMark=*`;
}

export const govinfoUscourtsDistrictAdapter: LibrarySourceAdapter = {
  code: "govinfo_uscourts_district_immigration",
  group: "district-courts",
  name: "District court immigration decisions (GovInfo)",
  description:
    "Orders and opinions of the federal district courts in immigration detention habeas, naturalization and other immigration suits (mandamus, APA), found on GovInfo's United States Courts Opinions collection by the case's nature of suit, each from its official PDF.",
  coverage:
    "Every opinion GovInfo holds in district court cases with nature of suit 463 (habeas corpus, alien detainee), 462 (naturalization) or 465 (other immigration actions), for the district courts that send GovInfo their opinions, from about 2004. Suits coded otherwise are not included.",
  cadence: "Daily",
  officialUrl: COLLECTION_URL,
  hosts: ["api.govinfo.gov", GOVINFO_HOST],
  license: "public_domain",
  requiredEnv: [KEY_ENV],
  staleAfterHours: 48,
  recheckAfterDays: 90,

  async listUpdates(ctx, since) {
    const from = apiInstant(new Date((since ?? ctx.now).getTime() - DAILY_MARGIN_DAYS * 86_400_000));
    const refs: DocumentRef[] = [];
    for (const nos of NATURES_OF_SUIT) {
      let url: string | null = `${API}/collections/USCOURTS/${from}?natureSuitCode=${nos.code}&pageSize=${PAGE_SIZE}&offsetMark=*`;
      for (let pages = 0; url && pages < DAILY_MAX_PAGES; pages++) {
        const page = await readPackagePage(ctx, url);
        refs.push(...(await refsForPackages(ctx, page.packages, nos.code)));
        url = page.nextPage;
        if (url && pages + 1 === DAILY_MAX_PAGES) ctx.note(`Nature of suit ${nos.code}: more than ${DAILY_MAX_PAGES * PAGE_SIZE} changed cases; the rest waits for backfill.`);
      }
    }
    return { refs };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const state: Cursor = isCursor(cursor) ? cursor : { codes: NATURES_OF_SUIT.map((n) => n.code), next: null, endTime: apiInstant(ctx.now), lastModified: null };
    const code = state.codes[0];
    if (code === undefined) return { refs: [], nextCursor: null, progress: "every nature of suit is done" };
    let page;
    try {
      page = await readPackagePage(ctx, state.next ?? firstPageUrl(code, state.endTime));
    } catch (err) {
      // The API's deep-paging cursor is no longer accepted (a stale cursor):
      // this code starts again at the oldest modification time reached. The
      // API answers an offsetMark it cannot read with HTTP 500 (seen live),
      // so a saved page still failing with 500 after the client's retries
      // counts too; the restart costs one request and leaves no gap.
      const status = (err as { code?: unknown }).code;
      if (!state.next || !["http_400", "http_404", "http_500"].includes(String(status))) throw err;
      const end = state.lastModified ?? state.endTime;
      ctx.note(`The saved GovInfo page for nature of suit ${code} was refused; the walk restarts at cases last modified ${end}.`);
      page = await readPackagePage(ctx, firstPageUrl(code, end));
    }
    const refs = await refsForPackages(ctx, page.packages, code);
    const modified = page.packages.map((p) => p.lastModified).filter(isInstant).sort();
    const issued = page.packages.map((p) => p.dateIssued).filter((d): d is string => Boolean(d)).sort();
    const lastModified = modified[0] ?? state.lastModified;
    const rest = state.codes.slice(1);
    const nextCursor: Cursor | null = page.nextPage
      ? { codes: state.codes, next: page.nextPage, endTime: state.endTime, lastModified }
      : rest.length
        ? { codes: rest, next: null, endTime: state.endTime, lastModified: null }
        : null;
    return {
      refs,
      nextCursor,
      progress: `nature of suit ${code}: ${page.packages.length} case(s) last modified ${modified[0] ?? "?"} to ${modified[modified.length - 1] ?? "?"} (issued ${issued[0] ?? "?"} to ${issued[issued.length - 1] ?? "?"})${page.count !== null ? `, ${page.count} in all` : ""}, ${refs.length} opinion(s); ${rest.length} more code(s) after this one`,
    };
  },

  fetchDocument(ctx, ref) {
    return fetchGranule(ctx, ref, "district");
  },
};
