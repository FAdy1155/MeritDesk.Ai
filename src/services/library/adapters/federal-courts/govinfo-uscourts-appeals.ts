import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fetchGranule, granuleRefs, GOVINFO_HOST, isGone, readPackageMods, readSitemapEntries } from "./govinfo";
import { appellateImmigrationVerdict, packageIdFromDetailsUrl } from "./parse";

// Immigration opinions of the U.S. courts of appeals from GovInfo's United
// States Courts Opinions collection (USCOURTS: the opinions the courts send
// GPO through the Administrative Office, with digital signatures;
// https://www.govinfo.gov/app/collection/uscourts), read without an API key
// from GovInfo's public sitemaps:
//
//   sitemap index → one sitemap per court and year (USCOURTS_ca5_2026) →
//   each case (package) → its MODS record → its opinions (granules) → each
//   opinion's PDF.
//
// The immigration filter reads each case's MODS record (parse.ts,
// appellateImmigrationVerdict): a petition for review naming the Attorney
// General as respondent (how every petition for review of a Board of
// Immigration Appeals decision is captioned, INA 242(b)(3)(A)), or a party
// or caption naming an immigration agency (INS, DHS, ICE, USCIS, CBP...),
// or an appeal in a case filed under an immigration nature of suit (462,
// 463, 465). An appeal in which the Attorney General is a party but none of
// that holds (habeas and APA appeals, but also firearms or FOIA cases) is
// kept only when the opinion uses at least two decisive immigration terms
// (the Board, removal, deportation, asylum, the Act...).
//
// Courts: the First through Eleventh Circuits and the D.C. Circuit (the
// Federal Circuit has no immigration jurisdiction). What GovInfo holds
// differs by court: published and unpublished opinions for most circuits
// from about 2004 to 2011 (the court's first year there) onward, but only
// published opinions from the First, Second and Ninth Circuits (their
// unpublished dispositions come from CourtListener, ./courtlistener-appeals.ts).
//
// - Daily: the sitemap index, the court sitemaps whose lastmod moved, and in
//   them the cases whose lastmod moved; each such case's MODS record.
// - Backfill: sitemap by sitemap, newest year first, PACKAGES_PER_CHUNK
//   cases a chunk. Every case's MODS record is read once (several hundred
//   thousand over the whole history, at GovInfo's pace of about one request
//   a second), since the sitemaps carry no caption to filter on.
// - Precedential status from the docket text GovInfo prints ("PUBLISHED
//   OPINION FILED", "UNPUBLISHED OPINION FILED"), else from the opinion's
//   own first-page legend ("NOT RECOMMENDED FOR PUBLICATION"...).
// - No legal-update feed: the legal-update monitor already follows the
//   circuits' published opinions on the courts' own sites, and the same
//   opinion here has another URL and no shared key, so it would be listed
//   twice.
// - US government work: public domain.

const INDEX_URL = "https://www.govinfo.gov/sitemap/USCOURTS_sitemap_index.xml";
const COLLECTION_URL = "https://www.govinfo.gov/app/collection/uscourts";
const COURT_ORDER = ["ca1", "ca2", "ca3", "ca4", "ca5", "ca6", "ca7", "ca8", "ca9", "ca10", "ca11", "caDC"];
const SITEMAP_RE = /\/USCOURTS_(ca\d{1,2}|caDC)_(\d{4})_sitemap\.xml$/;
const PACKAGES_PER_CHUNK = 300;
/** Daily: how far before the last run a change is looked for (GovInfo's lastmod is when it processed the package). */
const DAILY_MARGIN_DAYS = 3;
/** Daily: at most this many changed cases are read (a GovInfo-wide reprocessing moves every lastmod; backfill already holds those). */
const DAILY_MAX_PACKAGES = 2000;

type Cursor = { sitemaps: string[]; offset: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && Array.isArray(c.sitemaps) && c.sitemaps.every((s) => typeof s === "string") && Number.isInteger(c.offset) && c.offset >= 0;
}

function sitemapKey(loc: string): { court: string; year: number } | null {
  const m = SITEMAP_RE.exec(loc);
  return m && COURT_ORDER.includes(m[1]) ? { court: m[1], year: Number(m[2]) } : null;
}

/** The courts of appeals' sitemaps, newest year first, then by circuit. */
async function readAppellateSitemaps(ctx: LibraryAdapterContext) {
  const all = await readSitemapEntries(ctx, INDEX_URL);
  const appellate = all
    .map((e) => ({ ...e, key: sitemapKey(e.loc) }))
    .filter((e): e is typeof e & { key: { court: string; year: number } } => e.key !== null)
    .sort((a, b) => b.key.year - a.key.year || COURT_ORDER.indexOf(a.key.court) - COURT_ORDER.indexOf(b.key.court));
  if (appellate.length === 0) throw new LibraryLayoutError(INDEX_URL, "no USCOURTS_ca<N>_<year>_sitemap.xml entries for the courts of appeals");
  return appellate;
}

async function packagesIn(ctx: LibraryAdapterContext, loc: string) {
  const entries = await readSitemapEntries(ctx, loc);
  const packages = entries
    .map((e) => ({ packageId: packageIdFromDetailsUrl(e.loc), lastmod: e.lastmod }))
    .filter((p): p is { packageId: string; lastmod: string | null } => Boolean(p.packageId && /^USCOURTS-ca/.test(p.packageId)));
  if (entries.length > 0 && packages.length === 0) throw new LibraryLayoutError(loc, "no USCOURTS-ca... details links");
  // A stable order, so a chunk's offset means the same cases next time.
  return packages.sort((a, b) => a.packageId.localeCompare(b.packageId));
}

/** The immigration opinions of these cases, as refs. */
async function refsForPackages(ctx: LibraryAdapterContext, packageIds: string[]): Promise<{ refs: DocumentRef[]; cases: number }> {
  const refs: DocumentRef[] = [];
  let cases = 0;
  for (const packageId of packageIds) {
    if (ctx.signal.aborted) break;
    const read = await readPackageMods(ctx, packageId);
    if (!read) continue;
    const verdict = appellateImmigrationVerdict(read.case);
    if (verdict.kind === "no") continue;
    cases++;
    refs.push(...granuleRefs(read.case, read.modsUrl, verdict.reasons, verdict.kind === "maybe", (m) => ctx.note(m)));
  }
  return { refs, cases };
}

export const govinfoUscourtsAppealsAdapter: LibrarySourceAdapter = {
  code: "govinfo_uscourts_appeals_immigration",
  group: "circuit-courts",
  name: "Courts of appeals immigration opinions (GovInfo)",
  description:
    "Immigration opinions of the First through Eleventh and D.C. Circuits from GovInfo's United States Courts Opinions collection: petitions for review of Board of Immigration Appeals decisions and appeals with an immigration agency as a party, each opinion from its official PDF.",
  coverage:
    "What GovInfo holds for each circuit, from its first year there (about 2004 to 2011, by court) to the present: published and unpublished opinions for most circuits, published opinions only for the First, Second and Ninth Circuits.",
  cadence: "Daily",
  officialUrl: COLLECTION_URL,
  hosts: [GOVINFO_HOST],
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,

  async listUpdates(ctx, since) {
    const threshold = (since ?? ctx.now).getTime() - DAILY_MARGIN_DAYS * 86_400_000;
    const changed = (lastmod: string | null) => !lastmod || new Date(lastmod).getTime() >= threshold;
    const packageIds: string[] = [];
    for (const sitemap of (await readAppellateSitemaps(ctx)).filter((s) => changed(s.lastmod))) {
      for (const p of await packagesIn(ctx, sitemap.loc)) if (changed(p.lastmod)) packageIds.push(p.packageId);
    }
    const unique = [...new Set(packageIds)];
    if (unique.length > DAILY_MAX_PACKAGES) {
      ctx.note(`${unique.length} cases changed on GovInfo since the last run; the first ${DAILY_MAX_PACKAGES} were read (a reprocessing; backfill holds the rest).`);
    }
    return { refs: (await refsForPackages(ctx, unique.slice(0, DAILY_MAX_PACKAGES))).refs };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const state: Cursor = isCursor(cursor) ? cursor : { sitemaps: (await readAppellateSitemaps(ctx)).map((s) => s.loc), offset: 0 };
    const loc = state.sitemaps[0];
    if (loc === undefined) return { refs: [], nextCursor: null, progress: "every court and year is done" };
    const rest = state.sitemaps.slice(1);
    let packages: { packageId: string }[];
    try {
      packages = await packagesIn(ctx, loc);
    } catch (err) {
      if (!isGone(err)) throw err;
      ctx.note(`${loc} is no longer on GovInfo; it was skipped.`);
      return { refs: [], nextCursor: rest.length ? { sitemaps: rest, offset: 0 } : null, progress: `${loc} skipped` };
    }
    const slice = packages.slice(state.offset, state.offset + PACKAGES_PER_CHUNK);
    const { refs, cases } = await refsForPackages(ctx, slice.map((p) => p.packageId));
    const nextOffset = state.offset + PACKAGES_PER_CHUNK;
    const key = sitemapKey(loc);
    return {
      refs,
      nextCursor: nextOffset < packages.length ? { sitemaps: state.sitemaps, offset: nextOffset } : rest.length ? { sitemaps: rest, offset: 0 } : null,
      progress: `${key?.court ?? loc} ${key?.year ?? ""}: cases ${state.offset + 1} to ${state.offset + slice.length} of ${packages.length}, ${cases} immigration case(s); ${rest.length} more court-year sitemap(s)`,
    };
  },

  fetchDocument(ctx, ref) {
    return fetchGranule(ctx, ref, "appeals");
  },
};
