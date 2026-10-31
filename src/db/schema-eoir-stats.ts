import { pgTable, uuid, text, timestamp, jsonb, integer, boolean, date, smallint, bigint, real, uniqueIndex, index, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// EOIR court and judge statistics (src/services/library/adapters/
// eoir-statistics/, migration 0008): aggregate counts computed from EOIR's
// public case data release by the worker. GLOBAL like the library tables
// (0007): no tenant column, no client data, and no record of any person or
// case: only counts by judge, court, fiscal year, nationality, custody,
// representation, case type, decision and application. Every context may
// SELECT; only service context (withServiceContext) may write, so app users
// read them and only the worker's statistics job writes them.
//
// Every row belongs to one snapshot (one load of one release). Readers use
// the snapshot whose status is 'current' (at most one, by a unique partial
// index); a new load is written as 'loading', made current in one
// transaction, and the superseded snapshot's rows are deleted (cascade).

/** One load of one EOIR case data release. */
export const eoirStatsSnapshots = pgTable("eoir_stats_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  // "EOIR Case Data 2026-0901": the release's top folder, as the archive names it.
  releaseFolder: text("release_folder"),
  // The date that folder name states (the data extract's date); null when it states none.
  dataDate: date("data_date", { mode: "string" }),
  // "August 2026": the label beside the link on EOIR's FOIA library page.
  listedLabel: text("listed_label"),
  pageUrl: text("page_url").notNull(),
  officialUrl: text("official_url").notNull(),
  codeKeyUrl: text("code_key_url"),
  archiveEtag: text("archive_etag"),
  archiveLastModified: text("archive_last_modified"),
  archiveBytes: bigint("archive_bytes", { mode: "number" }),
  // loading, current, superseded, failed
  status: text("status").notNull().default("loading"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  loadedAt: timestamp("loaded_at", { withTimezone: true }),
  // Per table read: rows, malformed rows, rows used, rows skipped by reason.
  tableCounts: jsonb("table_counts").notNull().default(sql`'{}'::jsonb`),
  // Rows written per aggregate table.
  rowCounts: jsonb("row_counts").notNull().default(sql`'{}'::jsonb`),
  // The definitions the counts follow (stated with every result).
  definitions: jsonb("definitions").notNull().default(sql`'{}'::jsonb`),
  notes: jsonb("notes").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  oneCurrentIdx: uniqueIndex("eoir_stats_snapshots_one_current_idx").on(t.status).where(sql`status = 'current'`),
}));

const snapshotId = () => uuid("snapshot_id").notNull().references(() => eoirStatsSnapshots.id, { onDelete: "cascade" });

/** Immigration judges: EOIR's code and name (tblLookupJudge), with their completions in the release. */
export const eoirStatsJudges = pgTable("eoir_stats_judges", {
  snapshotId: snapshotId(),
  judgeCode: text("judge_code").notNull(),
  name: text("name"),
  lookupActive: boolean("lookup_active"),
  completions: integer("completions").notNull().default(0),
  firstFy: smallint("first_fy"),
  lastFy: smallint("last_fy"),
  // [{ court, completions, firstFy, lastFy }], most completions first.
  courts: jsonb("courts").notNull().default(sql`'[]'::jsonb`),
}, (t) => ({
  pk: primaryKey({ columns: [t.snapshotId, t.judgeCode] }),
}));

/** Immigration courts (base cities, tblLookupBaseCity), with their completions in the release. */
export const eoirStatsCourts = pgTable("eoir_stats_courts", {
  snapshotId: snapshotId(),
  courtCode: text("court_code").notNull(),
  city: text("city"),
  state: text("state"),
  region: text("region"),
  lookupActive: boolean("lookup_active"),
  completions: integer("completions").notNull().default(0),
  firstFy: smallint("first_fy"),
  lastFy: smallint("last_fy"),
}, (t) => ({
  pk: primaryKey({ columns: [t.snapshotId, t.courtCode] }),
}));

/** EOIR's codes and descriptions from the release's lookup tables; grouping is the app's (stated with results). */
export const eoirStatsCodes = pgTable("eoir_stats_codes", {
  snapshotId: snapshotId(),
  // ij_decision, other_completion, application, application_decision, bia_decision, appeal_type, case_type, custody, filed_by, nationality
  codeSet: text("code_set").notNull(),
  caseType: text("case_type").notNull().default(""),
  code: text("code").notNull(),
  description: text("description"),
  active: boolean("active"),
  grouping: text("grouping"),
}, (t) => ({
  pk: primaryKey({ columns: [t.snapshotId, t.codeSet, t.caseType, t.code] }),
}));

/** Completed proceedings by judge, court, fiscal year, case type, custody, representation and outcome. */
export const eoirStatsProceedings = pgTable("eoir_stats_proceedings", {
  snapshotId: snapshotId(),
  judgeCode: text("judge_code").notNull(),
  courtCode: text("court_code").notNull(),
  fy: smallint("fy").notNull(),
  caseType: text("case_type").notNull(),
  custody: text("custody").notNull(),
  represented: boolean("represented").notNull(),
  // decision (DEC_CODE), other (OTHER_COMP) or none
  outcomeKind: text("outcome_kind").notNull(),
  outcomeCode: text("outcome_code").notNull(),
  completions: integer("completions").notNull(),
  absentia: integer("absentia").notNull(),
  daysN: integer("days_n").notNull(),
  daysSum: bigint("days_sum", { mode: "number" }).notNull(),
}, (t) => ({
  judgeIdx: index("eoir_stats_proceedings_judge_idx").on(t.snapshotId, t.judgeCode, t.fy),
  courtIdx: index("eoir_stats_proceedings_court_idx").on(t.snapshotId, t.courtCode, t.fy),
}));

/** Completed proceedings by court, fiscal year and nationality (no judge), with case type, custody, representation and outcome. */
export const eoirStatsProceedingsNat = pgTable("eoir_stats_proceedings_nat", {
  snapshotId: snapshotId(),
  courtCode: text("court_code").notNull(),
  fy: smallint("fy").notNull(),
  nationality: text("nationality").notNull(),
  caseType: text("case_type").notNull(),
  custody: text("custody").notNull(),
  represented: boolean("represented").notNull(),
  outcomeKind: text("outcome_kind").notNull(),
  outcomeCode: text("outcome_code").notNull(),
  completions: integer("completions").notNull(),
  absentia: integer("absentia").notNull(),
}, (t) => ({
  natIdx: index("eoir_stats_proceedings_nat_nat_idx").on(t.snapshotId, t.nationality, t.fy),
  courtIdx: index("eoir_stats_proceedings_nat_court_idx").on(t.snapshotId, t.courtCode, t.fy),
}));

/** Applications for relief on completed proceedings, by the judge's decision on them. */
export const eoirStatsApplications = pgTable("eoir_stats_applications", {
  snapshotId: snapshotId(),
  judgeCode: text("judge_code").notNull(),
  courtCode: text("court_code").notNull(),
  fy: smallint("fy").notNull(),
  applCode: text("appl_code").notNull(),
  decision: text("decision").notNull(),
  custody: text("custody").notNull(),
  represented: boolean("represented").notNull(),
  n: integer("n").notNull(),
}, (t) => ({
  judgeIdx: index("eoir_stats_applications_judge_idx").on(t.snapshotId, t.judgeCode, t.applCode),
  courtIdx: index("eoir_stats_applications_court_idx").on(t.snapshotId, t.courtCode, t.applCode),
  applIdx: index("eoir_stats_applications_appl_idx").on(t.snapshotId, t.applCode, t.fy),
}));

/** Asylum, withholding and CAT applications on completed proceedings, by nationality. */
export const eoirStatsApplicationsNat = pgTable("eoir_stats_applications_nat", {
  snapshotId: snapshotId(),
  judgeCode: text("judge_code").notNull(),
  courtCode: text("court_code").notNull(),
  fy: smallint("fy").notNull(),
  nationality: text("nationality").notNull(),
  applCode: text("appl_code").notNull(),
  decision: text("decision").notNull(),
  n: integer("n").notNull(),
}, (t) => ({
  judgeIdx: index("eoir_stats_applications_nat_judge_idx").on(t.snapshotId, t.judgeCode, t.nationality),
  natIdx: index("eoir_stats_applications_nat_nat_idx").on(t.snapshotId, t.nationality, t.applCode, t.fy),
  courtIdx: index("eoir_stats_applications_nat_court_idx").on(t.snapshotId, t.courtCode, t.nationality),
}));

/** Appeals to the Board from immigration judges' decisions in completed proceedings, by the Board's decision (or none yet). */
export const eoirStatsAppeals = pgTable("eoir_stats_appeals", {
  snapshotId: snapshotId(),
  judgeCode: text("judge_code").notNull(),
  courtCode: text("court_code").notNull(),
  // The fiscal year of the immigration court completion, not of the appeal.
  fy: smallint("fy").notNull(),
  appealType: text("appeal_type").notNull(),
  filedBy: text("filed_by").notNull(),
  biaDecision: text("bia_decision").notNull(),
  // The appeal has a Board decision date.
  decided: boolean("decided").notNull(),
  n: integer("n").notNull(),
}, (t) => ({
  judgeIdx: index("eoir_stats_appeals_judge_idx").on(t.snapshotId, t.judgeCode),
  courtIdx: index("eoir_stats_appeals_court_idx").on(t.snapshotId, t.courtCode, t.fy),
}));

/** Days from INPUT_DATE to COMP_DATE of completed proceedings: by judge, court (and custody) and nationally, per fiscal year. */
export const eoirStatsProcessing = pgTable("eoir_stats_processing", {
  snapshotId: snapshotId(),
  // judge, court or national
  scope: text("scope").notNull(),
  scopeCode: text("scope_code").notNull(),
  fy: smallint("fy").notNull(),
  // all, or a custody code
  custody: text("custody").notNull(),
  n: integer("n").notNull(),
  meanDays: real("mean_days").notNull(),
  p25: integer("p25").notNull(),
  p50: integer("p50").notNull(),
  p75: integer("p75").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.snapshotId, t.scope, t.scopeCode, t.fy, t.custody] }),
}));
