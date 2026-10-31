import type { BackfillChunk, LibrarySourceAdapter } from "../../types";
import {
  ALL_STATUSES,
  CL_HOST,
  CL_LIMITS_ENV,
  CL_TOKEN_ENV,
  dayBefore,
  fetchCluster,
  recentRefs,
  walkChunk,
  type ClCourtTable,
  type ClWindow,
} from "./courtlistener";

// Immigration opinions of the U.S. courts of appeals that GovInfo does not
// hold (./govinfo-uscourts-appeals.ts holds the rest), found through
// CourtListener's search API (see ./courtlistener.ts for the query, the
// text and the API allowance):
//
// - each circuit's history before its first year on GovInfo (1920s
//   onward, as CourtListener has it: the Federal Reporter through the
//   Caselaw Access Project and Public.Resource.Org, then the courts' own
//   sites);
// - the unpublished dispositions of the First, Second and Ninth Circuits
//   (summary orders, memoranda, judgments), which those courts do not send
//   GovInfo, from that first year on.
//
// The first year on GovInfo is read from GovInfo's own sitemaps (the first
// year each court's sitemap lists a full year of opinions, checked when
// this collector was written): an opinion filed before it comes from here,
// one filed after it from GovInfo, so the two collectors do not hold the
// same opinion twice (a few at the boundary may be in both).
//
// - Daily: the three unpublished windows, opinions filed in the last
//   DAILY_LOOKBACK_DAYS (CourtListener adds a court's opinions within a day
//   or two). The history windows are closed: nothing new is filed in them.
// - Backfill: the unpublished windows first (the newest material), then
//   each circuit's history, one 20-case search page a chunk, newest first.
// - Text: the court's own file when CourtListener records an https link to
//   it on the court's site (the Ninth and Second Circuits' recent
//   dispositions), else CourtListener's text of the opinion.
// - Precedential status from CourtListener's status field; a case reported
//   only in the Federal Appendix is non-precedential.
// - Court opinions are public domain.

/** The year each court's opinions start on GovInfo, and the court's own file hosts. */
const CIRCUITS: { court: string; name: string; govinfoFrom: string; unpublishedOnlyHere: boolean; hosts: string[] }[] = [
  { court: "ca9", name: "United States Court of Appeals for the Ninth Circuit", govinfoFrom: "2009-01-01", unpublishedOnlyHere: true, hosts: ["cdn.ca9.uscourts.gov", "www.ca9.uscourts.gov"] },
  { court: "ca2", name: "United States Court of Appeals for the Second Circuit", govinfoFrom: "2011-01-01", unpublishedOnlyHere: true, hosts: ["ww3.ca2.uscourts.gov", "www.ca2.uscourts.gov"] },
  { court: "ca1", name: "United States Court of Appeals for the First Circuit", govinfoFrom: "2008-01-01", unpublishedOnlyHere: true, hosts: ["www.ca1.uscourts.gov", "media.ca1.uscourts.gov"] },
  { court: "ca3", name: "United States Court of Appeals for the Third Circuit", govinfoFrom: "2008-01-01", unpublishedOnlyHere: false, hosts: ["www2.ca3.uscourts.gov", "www.ca3.uscourts.gov"] },
  { court: "ca4", name: "United States Court of Appeals for the Fourth Circuit", govinfoFrom: "2008-01-01", unpublishedOnlyHere: false, hosts: ["www.ca4.uscourts.gov"] },
  { court: "ca5", name: "United States Court of Appeals for the Fifth Circuit", govinfoFrom: "2004-01-01", unpublishedOnlyHere: false, hosts: ["www.ca5.uscourts.gov"] },
  { court: "ca6", name: "United States Court of Appeals for the Sixth Circuit", govinfoFrom: "2008-01-01", unpublishedOnlyHere: false, hosts: ["www.opn.ca6.uscourts.gov", "www.ca6.uscourts.gov"] },
  { court: "ca7", name: "United States Court of Appeals for the Seventh Circuit", govinfoFrom: "2009-01-01", unpublishedOnlyHere: false, hosts: ["media.ca7.uscourts.gov", "www.ca7.uscourts.gov"] },
  { court: "ca8", name: "United States Court of Appeals for the Eighth Circuit", govinfoFrom: "2005-01-01", unpublishedOnlyHere: false, hosts: ["media.ca8.uscourts.gov", "ecf.ca8.uscourts.gov", "www.ca8.uscourts.gov"] },
  { court: "ca10", name: "United States Court of Appeals for the Tenth Circuit", govinfoFrom: "2008-01-01", unpublishedOnlyHere: false, hosts: ["www.ca10.uscourts.gov"] },
  { court: "ca11", name: "United States Court of Appeals for the Eleventh Circuit", govinfoFrom: "2011-01-01", unpublishedOnlyHere: false, hosts: ["media.ca11.uscourts.gov", "www.ca11.uscourts.gov"] },
  { court: "cadc", name: "United States Court of Appeals for the District of Columbia Circuit", govinfoFrom: "1997-01-01", unpublishedOnlyHere: false, hosts: ["media.cadc.uscourts.gov", "www.cadc.uscourts.gov"] },
];

const DAILY_LOOKBACK_DAYS = 14;
const DAILY_MAX_PAGES = 10;

const WINDOWS: ClWindow[] = [
  ...CIRCUITS.filter((c) => c.unpublishedOnlyHere).map(
    (c): ClWindow => ({
      id: `unpublished-${c.court}`,
      label: `${c.name.replace("United States Court of Appeals for the ", "")}, unpublished, ${c.govinfoFrom.slice(0, 4)} on`,
      search: { courts: [c.court], statuses: ["Unpublished"], filedAfter: c.govinfoFrom },
      daily: true,
      apiCostPerPage: 2,
    })
  ),
  ...CIRCUITS.map(
    (c): ClWindow => ({
      id: `history-${c.court}`,
      label: `${c.name.replace("United States Court of Appeals for the ", "")}, before ${c.govinfoFrom.slice(0, 4)}`,
      search: { courts: [c.court], statuses: ALL_STATUSES, filedBefore: dayBefore(c.govinfoFrom) },
      daily: false,
      apiCostPerPage: 20,
    })
  ),
];

const COURTS: ClCourtTable = {
  name: (courtId, cluster) => CIRCUITS.find((c) => c.court === courtId)?.name ?? cluster.court ?? courtId,
  hosts: (courtId) => CIRCUITS.find((c) => c.court === courtId)?.hosts ?? [],
};

export const courtlistenerAppealsAdapter: LibrarySourceAdapter = {
  code: "courtlistener_appeals_immigration",
  group: "circuit-courts",
  name: "Courts of appeals immigration opinions not on GovInfo (CourtListener)",
  description:
    "Immigration opinions of the First through Eleventh and D.C. Circuits that GovInfo does not hold: each circuit's history before its first year on GovInfo, and the First, Second and Ninth Circuits' unpublished dispositions, found through CourtListener's search API and read from the court's own file where CourtListener links one.",
  coverage:
    "Opinions matching the immigration query (the Board, immigration judges, the INS, the Act, USCIS, deportation, naturalization) filed before each circuit's first year on GovInfo (1920s onward, as CourtListener holds them), and the First, Second and Ninth Circuits' unpublished ones since. Fills at the pace CourtListener's API allowance permits.",
  cadence: "Daily (unpublished dispositions); history as the API allowance permits",
  officialUrl: `https://${CL_HOST}/`,
  hosts: [CL_HOST, ...new Set(CIRCUITS.flatMap((c) => c.hosts))],
  license: "public_domain",
  requiredEnv: [CL_TOKEN_ENV],
  optionalEnv: [CL_LIMITS_ENV],
  staleAfterHours: 48,
  recheckAfterDays: 180,
  maxDocumentsPerDailyRun: 200,

  async listUpdates(ctx, since) {
    const from = new Date((since ?? ctx.now).getTime() - DAILY_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    return { refs: await recentRefs(ctx, WINDOWS, COURTS, from, DAILY_MAX_PAGES) };
  },

  backfill(ctx, cursor): Promise<BackfillChunk> {
    return walkChunk(ctx, WINDOWS, COURTS, cursor);
  },

  fetchDocument(ctx, ref) {
    return fetchCluster(ctx, ref, "appeals");
  },
};
