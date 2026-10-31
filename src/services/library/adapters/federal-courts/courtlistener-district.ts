import type { BackfillChunk, LibrarySourceAdapter } from "../../types";
import { ALL_STATUSES, CL_HOST, CL_LIMITS_ENV, CL_TOKEN_ENV, fetchCluster, walkChunk, type ClCourtTable, type ClWindow } from "./courtlistener";

// Immigration decisions of the federal district courts from before GovInfo
// (./govinfo-uscourts-district.ts holds the district courts' opinions from
// about 2004 on), found through CourtListener's search API with the
// immigration query (see ./courtlistener.ts): habeas, mandamus,
// naturalization and APA suits, and criminal cases that turn on an
// immigration question, as CourtListener holds them (mostly the Federal
// Supplement through the Caselaw Access Project).
//
// - Daily: nothing to read. The window closes at the end of 2003 and no new
//   opinions are filed in it; the run records that it read nothing.
// - Backfill: one 20-case search page a chunk, newest first, every federal
//   district court (CourtListener's court IDs for the 94 districts).
// - Text: CourtListener's text of the opinion (the opinions API); the court
//   is named as CourtListener names it.
// - District court decisions bind no other court: stored non-precedential.
// - Court opinions are public domain.

/** CourtListener's IDs of the federal district courts (jurisdiction FD). */
const DISTRICT_COURTS = (
  "almd alnd alsd akd azd ared arwd cacd caed cand casd cod ctd ded dcd flmd flnd flsd gamd gand gasd hid idd ilcd ilnd ilsd " +
  "innd insd iand iasd ksd kyed kywd laed lamd lawd med mdd mad mied miwd mnd msnd mssd moed mowd mtd ned nvd nhd njd nmd nyed " +
  "nynd nysd nywd nced ncmd ncwd ndd ohnd ohsd oked oknd okwd ord paed pamd pawd rid scd sdd tned tnmd tnwd txed txnd txsd txwd " +
  "utd vtd vaed vawd waed wawd wvnd wvsd wied wiwd wyd gud nmid prd vid"
).split(" ");

const WINDOWS: ClWindow[] = [
  {
    id: "history-district",
    label: "district courts, before 2004",
    search: { courts: DISTRICT_COURTS, statuses: ALL_STATUSES, filedBefore: "2003-12-31" },
    daily: false,
    apiCostPerPage: 20,
  },
];

const COURTS: ClCourtTable = {
  name: (courtId, cluster) => cluster.court ?? courtId,
  hosts: () => [],
};

export const courtlistenerDistrictAdapter: LibrarySourceAdapter = {
  code: "courtlistener_district_immigration",
  group: "district-courts",
  name: "District court immigration decisions before 2004 (CourtListener)",
  description:
    "Immigration decisions of the federal district courts filed before 2004, the years before GovInfo, found through CourtListener's search API with the immigration query and read from CourtListener's text of each opinion.",
  coverage:
    "District court opinions matching the immigration query (the Board, immigration judges, the INS, the Act, USCIS, deportation, naturalization) filed before 2004, as CourtListener holds them. Fills at the pace CourtListener's API allowance permits.",
  cadence: "History only; filled as the API allowance permits",
  officialUrl: `https://${CL_HOST}/`,
  hosts: [CL_HOST],
  license: "public_domain",
  requiredEnv: [CL_TOKEN_ENV],
  optionalEnv: [CL_LIMITS_ENV],
  staleAfterHours: 24 * 8,
  recheckAfterDays: 365,

  async listUpdates(ctx) {
    ctx.note("This collector holds the district courts' history before 2004; no new opinions are filed in it, so the daily run reads nothing.");
    return { refs: [] };
  },

  backfill(ctx, cursor): Promise<BackfillChunk> {
    return walkChunk(ctx, WINDOWS, COURTS, cursor);
  },

  fetchDocument(ctx, ref) {
    return fetchCluster(ctx, ref, "district");
  },
};
