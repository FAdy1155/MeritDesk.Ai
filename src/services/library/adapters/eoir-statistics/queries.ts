import { sql, type SQL } from "drizzle-orm";
import {
  eoirStatsAppeals,
  eoirStatsApplications,
  eoirStatsApplicationsNat,
  eoirStatsCodes,
  eoirStatsCourts,
  eoirStatsJudges,
  eoirStatsProceedings,
  eoirStatsProceedingsNat,
  eoirStatsProcessing,
  eoirStatsSnapshots,
} from "@/db/schema-eoir-stats";
import { resultRows, type LibraryDb } from "../../db";
import { BIA_DECISION_GROUPS } from "./aggregate";

// The reads of the EOIR statistics (migration 0008), always against the one
// 'current' snapshot. Every result carries the snapshot it came from, the
// filters it applied and its denominators, so the tools and the page can
// state them; the callers add the definitions and the caution that rates are
// historical (./model.ts). Read-only SQL: the callers run it in a READ ONLY
// global transaction (withGlobalReadContext).

export type SnapshotView = {
  id: string;
  releaseFolder: string | null;
  dataDate: string | null;
  listedLabel: string | null;
  officialUrl: string;
  pageUrl: string;
  codeKeyUrl: string | null;
  loadedAt: Date | null;
  definitions: Record<string, string>;
  rowCounts: Record<string, number>;
  tableCounts: Record<string, unknown>;
  /** What the load noted (a missing lookup table, a test load of a prefix). */
  notes: string[];
};

export type AttemptView = { status: string; releaseFolder: string | null; startedAt: Date; error: string | null };

type Raw = Record<string, unknown>;
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const date = (v: unknown): Date | null => (v ? new Date(String(v)) : null);

export async function currentSnapshot(tx: LibraryDb): Promise<SnapshotView | null> {
  const [r] = resultRows<Raw>(
    await tx.execute(sql`
      select id, release_folder, data_date::text as data_date, listed_label, official_url, page_url, code_key_url, loaded_at, definitions, row_counts, table_counts, notes
      from ${eoirStatsSnapshots} where status = 'current' limit 1`)
  );
  if (!r) return null;
  return {
    id: String(r.id),
    releaseFolder: str(r.release_folder),
    dataDate: str(r.data_date),
    listedLabel: str(r.listed_label),
    officialUrl: String(r.official_url),
    pageUrl: String(r.page_url),
    codeKeyUrl: str(r.code_key_url),
    loadedAt: date(r.loaded_at),
    definitions: (r.definitions ?? {}) as Record<string, string>,
    rowCounts: (r.row_counts ?? {}) as Record<string, number>,
    tableCounts: (r.table_counts ?? {}) as Record<string, unknown>,
    notes: Array.isArray(r.notes) ? (r.notes as unknown[]).map(String) : [],
  };
}

export async function latestAttempt(tx: LibraryDb): Promise<AttemptView | null> {
  const [r] = resultRows<Raw>(await tx.execute(sql`select status, release_folder, started_at, error from ${eoirStatsSnapshots} order by started_at desc limit 1`));
  return r ? { status: String(r.status), releaseFolder: str(r.release_folder), startedAt: date(r.started_at)!, error: str(r.error) } : null;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export type Labels = {
  judge(code: string): string | null;
  court(code: string): string | null;
  code(set: string, code: string, caseType?: string): string | null;
  grouping(set: string, code: string): string | null;
};

export async function loadLabels(tx: LibraryDb, snapshotId: string): Promise<Labels> {
  const judges = new Map(
    resultRows<Raw>(await tx.execute(sql`select judge_code, name from ${eoirStatsJudges} where snapshot_id = ${snapshotId}`)).map((r) => [String(r.judge_code), str(r.name)])
  );
  const courts = new Map(
    resultRows<Raw>(await tx.execute(sql`select court_code, city, state from ${eoirStatsCourts} where snapshot_id = ${snapshotId}`)).map((r) => [
      String(r.court_code),
      r.city ? `${r.city}${r.state ? `, ${r.state}` : ""}` : null,
    ])
  );
  const codes = new Map<string, { description: string | null; grouping: string | null }>();
  for (const r of resultRows<Raw>(await tx.execute(sql`select code_set, case_type, code, description, grouping from ${eoirStatsCodes} where snapshot_id = ${snapshotId}`))) {
    codes.set(`${r.code_set}|${r.case_type}|${r.code}`, { description: str(r.description), grouping: str(r.grouping) });
  }
  return {
    judge: (code) => judges.get(code) ?? null,
    court: (code) => courts.get(code) ?? null,
    code: (set, code, caseType = "") => codes.get(`${set}|${caseType}|${code}`)?.description ?? null,
    grouping: (set, code) => codes.get(`${set}||${code}`)?.grouping ?? null,
  };
}

/** SQL for "decision is in the granted / denied group", from the codes table (EOIR's own descriptions). */
function decisionGroupSql(snapshotId: string, column: SQL, group: "granted" | "denied"): SQL {
  return sql`${column} in (select code from ${eoirStatsCodes} where snapshot_id = ${snapshotId} and code_set = 'application_decision' and grouping = ${group})`;
}

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

export type JudgeSummary = {
  code: string;
  name: string | null;
  lookupActive: boolean | null;
  completions: number;
  firstFy: number | null;
  lastFy: number | null;
  courts: { court: string; courtName: string | null; completions: number; firstFy: number; lastFy: number }[];
};

/** One judge by EOIR's judge code. */
export async function getJudge(tx: LibraryDb, snapshot: SnapshotView, code: string): Promise<JudgeSummary | null> {
  const found = await searchJudges(tx, snapshot, { code, limit: 1 });
  return found.judges[0] ?? null;
}

export async function searchJudges(
  tx: LibraryDb,
  snapshot: SnapshotView,
  params: { query?: string | null; code?: string | null; court?: string | null; limit?: number; offset?: number }
): Promise<{ judges: JudgeSummary[]; total: number }> {
  const words = (params.query ?? "").trim().split(/[\s,.]+/).filter((w) => w.length > 0).slice(0, 6);
  // Proceedings with no judge code are counted in the court and national figures, never listed as a judge.
  const conds: SQL[] = [sql`j.snapshot_id = ${snapshot.id}`, sql`j.judge_code <> ''`];
  for (const w of words) conds.push(sql`(j.name ilike ${`%${w.replace(/[%_\\]/g, "\\$&")}%`} or j.judge_code = ${w.toUpperCase()})`);
  if (params.code) conds.push(sql`j.judge_code = ${params.code.trim().toUpperCase()}`);
  if (params.court) conds.push(sql`j.courts @> ${JSON.stringify([{ court: params.court.toUpperCase() }])}::jsonb`);
  const where = sql.join(conds, sql` and `);
  const [count] = resultRows<Raw>(await tx.execute(sql`select count(*)::int as n from ${eoirStatsJudges} j where ${where}`));
  const rows = resultRows<Raw>(
    await tx.execute(sql`
      select j.judge_code, j.name, j.lookup_active, j.completions, j.first_fy, j.last_fy, j.courts
      from ${eoirStatsJudges} j where ${where}
      order by ${
        params.court
          ? sql`(select max((e->>'lastFy')::int) from jsonb_array_elements(j.courts) e where e->>'court' = ${params.court.toUpperCase()}) desc nulls last,
                 (select sum((e->>'completions')::int) from jsonb_array_elements(j.courts) e where e->>'court' = ${params.court.toUpperCase()}) desc nulls last,`
          : sql``
      } j.last_fy desc nulls last, j.completions desc, j.name
      limit ${Math.min(params.limit ?? 20, 50)} offset ${params.offset ?? 0}`)
  );
  const labels = await loadLabels(tx, snapshot.id);
  return {
    total: num(count?.n),
    judges: rows.map((r) => ({
      code: String(r.judge_code),
      name: str(r.name),
      lookupActive: r.lookup_active === null ? null : Boolean(r.lookup_active),
      completions: num(r.completions),
      firstFy: r.first_fy === null ? null : num(r.first_fy),
      lastFy: r.last_fy === null ? null : num(r.last_fy),
      courts: ((r.courts ?? []) as { court: string; completions: number; firstFy: number; lastFy: number }[]).map((c) => ({ ...c, courtName: labels.court(c.court) })),
    })),
  };
}

export type CourtSummary = { code: string; name: string | null; region: string | null; lookupActive: boolean | null; completions: number; firstFy: number | null; lastFy: number | null };

export async function listCourts(tx: LibraryDb, snapshot: SnapshotView): Promise<CourtSummary[]> {
  return resultRows<Raw>(
    await tx.execute(sql`select court_code, city, state, region, lookup_active, completions, first_fy, last_fy from ${eoirStatsCourts} where snapshot_id = ${snapshot.id} order by completions desc`)
  ).map((r) => ({
    code: String(r.court_code),
    name: r.city ? `${r.city}${r.state ? `, ${r.state}` : ""}` : null,
    region: str(r.region),
    lookupActive: r.lookup_active === null ? null : Boolean(r.lookup_active),
    completions: num(r.completions),
    firstFy: r.first_fy === null ? null : num(r.first_fy),
    lastFy: r.last_fy === null ? null : num(r.last_fy),
  }));
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

export type DecisionCounts = { granted: number; denied: number; other: number; total: number };

/** Granted / (granted + denied), and granted / total; null when the denominator is zero. */
export function rates(c: DecisionCounts): { grantRateOfDecided: number | null; grantShareOfAll: number | null } {
  return {
    grantRateOfDecided: c.granted + c.denied > 0 ? c.granted / (c.granted + c.denied) : null,
    grantShareOfAll: c.total > 0 ? c.granted / c.total : null,
  };
}

type Period = { fyFrom: number | null; fyTo: number | null };

function fyConds(alias: string, p: Period): SQL[] {
  const col = sql.raw(`${alias}.fy`);
  const out: SQL[] = [];
  if (p.fyFrom !== null) out.push(sql`${col} >= ${p.fyFrom}`);
  if (p.fyTo !== null) out.push(sql`${col} <= ${p.fyTo}`);
  return out;
}

async function applicationCounts(tx: LibraryDb, snapshotId: string, conds: SQL[], table: "applications" | "applications_nat" = "applications"): Promise<DecisionCounts> {
  const t = table === "applications" ? eoirStatsApplications : eoirStatsApplicationsNat;
  const [r] = resultRows<Raw>(
    await tx.execute(sql`
      select coalesce(sum(a.n) filter (where ${decisionGroupSql(snapshotId, sql`a.decision`, "granted")}), 0)::bigint as granted,
             coalesce(sum(a.n) filter (where ${decisionGroupSql(snapshotId, sql`a.decision`, "denied")}), 0)::bigint as denied,
             coalesce(sum(a.n), 0)::bigint as total
      from ${t} a where ${sql.join([sql`a.snapshot_id = ${snapshotId}`, ...conds], sql` and `)}`)
  );
  const granted = num(r?.granted);
  const denied = num(r?.denied);
  const total = num(r?.total);
  return { granted, denied, other: total - granted - denied, total };
}

// ---------------------------------------------------------------------------
// Judge profile
// ---------------------------------------------------------------------------

export type JudgeProfile = {
  judge: JudgeSummary;
  period: Period & { applied: string };
  completionsByFy: { fy: number; completions: number; decisions: number; otherCompletions: number; absentia: number }[];
  totals: { completions: number; decisions: number; otherCompletions: number; noCode: number; absentia: number; represented: number; detained: number; released: number; neverDetained: number };
  outcomes: { kind: string; caseType: string; code: string; description: string | null; n: number }[];
  asylum: { scope: string; label: string; counts: DecisionCounts }[];
  asylumBy: { split: string; value: string; counts: DecisionCounts }[];
  relief: { appl: string; description: string | null; counts: DecisionCounts }[];
  asylumNationalities: { nationality: string; name: string | null; counts: DecisionCounts }[];
  processing: { fy: number; judge: { n: number; p50: number; mean: number } | null; national: { n: number; p50: number; mean: number } | null }[];
  appeals: { appealType: string; total: number; pending: number; groups: Record<string, number>; filedBy: Record<string, number> };
};

export async function judgeProfile(tx: LibraryDb, snapshot: SnapshotView, params: { judgeCode: string; fyFrom?: number | null; fyTo?: number | null }): Promise<JudgeProfile | null> {
  const code = params.judgeCode.trim().toUpperCase();
  const judge = await getJudge(tx, snapshot, code);
  if (!judge) return null;
  const labels = await loadLabels(tx, snapshot.id);
  const lastFy = judge.lastFy;
  // Default period: the judge's last five fiscal years with completions.
  const period: Period = {
    fyFrom: params.fyFrom ?? (lastFy !== null ? lastFy - 4 : null),
    fyTo: params.fyTo ?? lastFy,
  };
  const applied = params.fyFrom || params.fyTo ? "as asked" : "the judge's last five fiscal years with completions (default)";
  const s = snapshot.id;
  const pc = [sql`p.snapshot_id = ${s}`, sql`p.judge_code = ${code}`, ...fyConds("p", period)];
  const where = sql.join(pc, sql` and `);

  const byFy = resultRows<Raw>(
    await tx.execute(sql`
      select p.fy, sum(p.completions)::bigint as completions,
             coalesce(sum(p.completions) filter (where p.outcome_kind = 'decision'), 0)::bigint as decisions,
             coalesce(sum(p.completions) filter (where p.outcome_kind = 'other'), 0)::bigint as other,
             sum(p.absentia)::bigint as absentia
      from ${eoirStatsProceedings} p where ${where} group by p.fy order by p.fy`)
  ).map((r) => ({ fy: num(r.fy), completions: num(r.completions), decisions: num(r.decisions), otherCompletions: num(r.other), absentia: num(r.absentia) }));

  const [t] = resultRows<Raw>(
    await tx.execute(sql`
      select coalesce(sum(p.completions), 0)::bigint as completions,
             coalesce(sum(p.completions) filter (where p.outcome_kind = 'decision'), 0)::bigint as decisions,
             coalesce(sum(p.completions) filter (where p.outcome_kind = 'other'), 0)::bigint as other,
             coalesce(sum(p.completions) filter (where p.outcome_kind = 'none'), 0)::bigint as none,
             coalesce(sum(p.absentia), 0)::bigint as absentia,
             coalesce(sum(p.completions) filter (where p.represented), 0)::bigint as represented,
             coalesce(sum(p.completions) filter (where p.custody = 'D'), 0)::bigint as detained,
             coalesce(sum(p.completions) filter (where p.custody = 'R'), 0)::bigint as released,
             coalesce(sum(p.completions) filter (where p.custody = 'N'), 0)::bigint as never
      from ${eoirStatsProceedings} p where ${where}`)
  );

  const outcomes = resultRows<Raw>(
    await tx.execute(sql`
      select p.outcome_kind, p.case_type, p.outcome_code, sum(p.completions)::bigint as n
      from ${eoirStatsProceedings} p where ${where}
      group by 1, 2, 3 order by n desc limit 25`)
  ).map((r) => {
    const kind = String(r.outcome_kind);
    const caseType = String(r.case_type);
    const c = String(r.outcome_code);
    return { kind, caseType, code: c, description: kind === "none" ? "no decision or completion code" : labels.code(kind === "decision" ? "ij_decision" : "other_completion", c, caseType), n: num(r.n) };
  });

  // Asylum (ASYL) decisions: the judge, the courts the judge sat in during the period, and nationally.
  const ac = [sql`a.appl_code = 'ASYL'`, ...fyConds("a", period)];
  const courtsInPeriod = resultRows<Raw>(
    await tx.execute(sql`select distinct p.court_code from ${eoirStatsProceedings} p where ${where}`)
  ).map((r) => String(r.court_code));
  const asylum: JudgeProfile["asylum"] = [
    { scope: "judge", label: `${judge.name ?? code} (${code})`, counts: await applicationCounts(tx, s, [...ac, sql`a.judge_code = ${code}`]) },
  ];
  for (const court of courtsInPeriod.slice(0, 3)) {
    asylum.push({ scope: "court", label: `${labels.court(court) ?? court} immigration court (${court}), all judges`, counts: await applicationCounts(tx, s, [...ac, sql`a.court_code = ${court}`]) });
  }
  asylum.push({ scope: "national", label: "All immigration courts", counts: await applicationCounts(tx, s, ac) });

  const asylumBy: JudgeProfile["asylumBy"] = [];
  for (const [split, value, cond] of [
    ["representation", "represented", sql`a.represented`],
    ["representation", "not represented", sql`not a.represented`],
    ["custody", "detained (D)", sql`a.custody = 'D'`],
    ["custody", "released (R)", sql`a.custody = 'R'`],
    ["custody", "never detained (N)", sql`a.custody = 'N'`],
  ] as const) {
    asylumBy.push({ split, value, counts: await applicationCounts(tx, s, [...ac, sql`a.judge_code = ${code}`, cond]) });
  }

  const relief = resultRows<Raw>(
    await tx.execute(sql`
      select a.appl_code, sum(a.n)::bigint as total,
             coalesce(sum(a.n) filter (where ${decisionGroupSql(s, sql`a.decision`, "granted")}), 0)::bigint as granted,
             coalesce(sum(a.n) filter (where ${decisionGroupSql(s, sql`a.decision`, "denied")}), 0)::bigint as denied
      from ${eoirStatsApplications} a
      where ${sql.join([sql`a.snapshot_id = ${s}`, sql`a.judge_code = ${code}`, ...fyConds("a", period)], sql` and `)}
      group by a.appl_code order by total desc limit 12`)
  ).map((r) => {
    const granted = num(r.granted);
    const denied = num(r.denied);
    const total = num(r.total);
    return { appl: String(r.appl_code), description: labels.code("application", String(r.appl_code)), counts: { granted, denied, other: total - granted - denied, total } };
  });

  const nats = resultRows<Raw>(
    await tx.execute(sql`
      select a.nationality, sum(a.n)::bigint as total,
             coalesce(sum(a.n) filter (where ${decisionGroupSql(s, sql`a.decision`, "granted")}), 0)::bigint as granted,
             coalesce(sum(a.n) filter (where ${decisionGroupSql(s, sql`a.decision`, "denied")}), 0)::bigint as denied
      from ${eoirStatsApplicationsNat} a
      where ${sql.join([sql`a.snapshot_id = ${s}`, sql`a.judge_code = ${code}`, sql`a.appl_code = 'ASYL'`, ...fyConds("a", period)], sql` and `)}
      group by a.nationality order by total desc limit 10`)
  ).map((r) => {
    const granted = num(r.granted);
    const denied = num(r.denied);
    const total = num(r.total);
    return { nationality: String(r.nationality), name: labels.code("nationality", String(r.nationality)), counts: { granted, denied, other: total - granted - denied, total } };
  });

  const proc = resultRows<Raw>(
    await tx.execute(sql`
      select x.fy, x.scope, x.n, x.p50, x.mean_days from ${eoirStatsProcessing} x
      where ${sql.join([sql`x.snapshot_id = ${s}`, sql`x.custody = 'all'`, sql`((x.scope = 'judge' and x.scope_code = ${code}) or x.scope = 'national')`, ...fyConds("x", period)], sql` and `)}
      order by x.fy`)
  );
  const procByFy = new Map<number, JudgeProfile["processing"][number]>();
  for (const r of proc) {
    const fy = num(r.fy);
    const row = procByFy.get(fy) ?? { fy, judge: null, national: null };
    const v = { n: num(r.n), p50: num(r.p50), mean: num(r.mean_days) };
    if (r.scope === "judge") row.judge = v;
    else row.national = v;
    procByFy.set(fy, row);
  }

  const appealRows = resultRows<Raw>(
    await tx.execute(sql`
      select x.bia_decision, x.decided, x.filed_by, sum(x.n)::bigint as n from ${eoirStatsAppeals} x
      where ${sql.join([sql`x.snapshot_id = ${s}`, sql`x.judge_code = ${code}`, sql`x.appeal_type = 'CASE APPEAL'`, ...fyConds("x", period)], sql` and `)}
      group by 1, 2, 3`)
  );
  const appeals: JudgeProfile["appeals"] = { appealType: "CASE APPEAL", total: 0, pending: 0, groups: {}, filedBy: {} };
  for (const r of appealRows) {
    const n = num(r.n);
    appeals.total += n;
    if (!r.decided) appeals.pending += n;
    else {
      const g = labels.grouping("bia_decision", String(r.bia_decision)) ?? groupOf(String(r.bia_decision));
      appeals.groups[g] = (appeals.groups[g] ?? 0) + n;
    }
    const by = labels.code("filed_by", String(r.filed_by)) ?? (String(r.filed_by) || "not stated");
    appeals.filedBy[by] = (appeals.filedBy[by] ?? 0) + n;
  }

  return {
    judge,
    period: { ...period, applied },
    completionsByFy: byFy,
    totals: {
      completions: num(t?.completions),
      decisions: num(t?.decisions),
      otherCompletions: num(t?.other),
      noCode: num(t?.none),
      absentia: num(t?.absentia),
      represented: num(t?.represented),
      detained: num(t?.detained),
      released: num(t?.released),
      neverDetained: num(t?.never),
    },
    outcomes,
    asylum,
    asylumBy,
    relief,
    asylumNationalities: nats,
    processing: [...procByFy.values()],
    appeals,
  };
}

function groupOf(code: string): string {
  for (const [g, codes] of Object.entries(BIA_DECISION_GROUPS)) if (codes.includes(code)) return g;
  return "other";
}

// ---------------------------------------------------------------------------
// General query
// ---------------------------------------------------------------------------

export const STAT_MEASURES = ["completions", "applications", "appeals", "processing"] as const;
export const STAT_GROUPS = ["none", "fy", "judge", "court", "nationality", "custody", "represented", "case_type", "outcome", "application", "decision", "appeal_type", "filed_by"] as const;
export type StatMeasure = (typeof STAT_MEASURES)[number];
export type StatGroup = (typeof STAT_GROUPS)[number];

export type StatQuery = {
  measure: StatMeasure;
  judge?: string | null;
  court?: string | null;
  nationality?: string | null;
  caseType?: string | null;
  custody?: string | null;
  represented?: boolean | null;
  application?: string | null;
  appealType?: string | null;
  fyFrom?: number | null;
  fyTo?: number | null;
  groupBy?: StatGroup;
  limit?: number;
};

export type StatRow = { key: string; label: string | null; values: Record<string, number | null> };

export type StatResult = {
  measure: StatMeasure;
  table: string;
  filters: Record<string, string | number | boolean>;
  defaultsApplied: string[];
  groupBy: StatGroup;
  columns: string[];
  rows: StatRow[];
  totals: Record<string, number | null>;
  truncated: boolean;
};

export class StatQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatQueryError";
  }
}

const GROUP_COLUMNS: Record<StatGroup, string | null> = {
  none: null,
  fy: "fy",
  judge: "judge_code",
  court: "court_code",
  nationality: "nationality",
  custody: "custody",
  represented: "represented",
  case_type: "case_type",
  outcome: "outcome",
  application: "appl_code",
  decision: "decision",
  appeal_type: "appeal_type",
  filed_by: "filed_by",
};

/** Which columns each table has, to refuse a filter or grouping it cannot answer instead of ignoring it. */
const TABLE_COLUMNS: Record<string, readonly string[]> = {
  eoir_stats_proceedings: ["fy", "judge_code", "court_code", "case_type", "custody", "represented", "outcome"],
  eoir_stats_proceedings_nat: ["fy", "court_code", "nationality", "case_type", "custody", "represented", "outcome"],
  eoir_stats_applications: ["fy", "judge_code", "court_code", "custody", "represented", "appl_code", "decision"],
  eoir_stats_applications_nat: ["fy", "judge_code", "court_code", "nationality", "appl_code", "decision"],
  eoir_stats_appeals: ["fy", "judge_code", "court_code", "appeal_type", "filed_by", "decision"],
  eoir_stats_processing: ["fy"],
};

export async function queryStats(tx: LibraryDb, snapshot: SnapshotView, q: StatQuery): Promise<StatResult> {
  const s = snapshot.id;
  const groupBy = q.groupBy ?? "fy";
  const limit = Math.min(Math.max(q.limit ?? 40, 1), 200);
  const defaultsApplied: string[] = [];
  const filters: Record<string, string | number | boolean> = {};
  const up = (v: string | null | undefined) => (v ? v.trim().toUpperCase() : null);
  const judge = up(q.judge);
  const court = up(q.court);
  const nationality = up(q.nationality);
  const caseType = up(q.caseType);
  const custody = up(q.custody);
  let application = up(q.application);
  let appealType = up(q.appealType);
  const period: Period = { fyFrom: q.fyFrom ?? null, fyTo: q.fyTo ?? null };
  if (judge) filters.judge = judge;
  if (court) filters.court = court;
  if (nationality) filters.nationality = nationality;
  if (caseType) filters.case_type = caseType;
  if (custody) filters.custody = custody;
  if (q.represented !== null && q.represented !== undefined) filters.represented = q.represented;
  if (period.fyFrom !== null) filters.fy_from = period.fyFrom;
  if (period.fyTo !== null) filters.fy_to = period.fyTo;

  const labels = await loadLabels(tx, s);

  if (q.measure === "processing") return processingQuery(tx, snapshot, { judge, court, custody, period, filters, groupBy, nationality, q });

  let table: string;
  if (q.measure === "completions") {
    table = nationality || groupBy === "nationality" ? "eoir_stats_proceedings_nat" : "eoir_stats_proceedings";
  } else if (q.measure === "applications") {
    if (!application) {
      application = "ASYL";
      defaultsApplied.push("application ASYL (asylum), since none was given");
    }
    filters.application = application;
    table = nationality || groupBy === "nationality" ? "eoir_stats_applications_nat" : "eoir_stats_applications";
  } else {
    if (!appealType) {
      appealType = "CASE APPEAL";
      defaultsApplied.push("appeal type CASE APPEAL (appeals from the judge's decision on the merits), since none was given");
    }
    filters.appeal_type = appealType;
    table = "eoir_stats_appeals";
  }

  const cols = TABLE_COLUMNS[table];
  const need = (name: string, what: string) => {
    if (!cols.includes(name)) {
      throw new StatQueryError(
        `${what} cannot be combined with this query: the ${q.measure} counts that have ${table.endsWith("_nat") ? "nationality" : "this breakdown"} do not have it. ` +
          (table === "eoir_stats_proceedings_nat"
            ? "Completions by nationality are kept by court, fiscal year, case type, custody and representation, not by judge; for a judge by nationality, use measure applications (asylum, withholding, CAT)."
            : table === "eoir_stats_applications_nat"
              ? "Applications by nationality are kept by judge, court and fiscal year, not by custody or representation."
              : "Try a different grouping or filter.")
      );
    }
  };
  if (judge) need("judge_code", "A judge filter");
  if (court) need("court_code", "A court filter");
  if (caseType) need("case_type", "A case type filter");
  if (custody) need("custody", "A custody filter");
  if (q.represented !== null && q.represented !== undefined) need("represented", "A representation filter");
  const groupCol = GROUP_COLUMNS[groupBy];
  if (groupCol && !cols.includes(groupCol)) need(groupCol, `Grouping by ${groupBy}`);

  const conds: SQL[] = [sql`x.snapshot_id = ${s}`, ...fyConds("x", period)];
  if (judge) conds.push(sql`x.judge_code = ${judge}`);
  if (court) conds.push(sql`x.court_code = ${court}`);
  if (nationality) conds.push(sql`x.nationality = ${nationality}`);
  if (caseType) conds.push(sql`x.case_type = ${caseType}`);
  if (custody) conds.push(sql`x.custody = ${custody}`);
  if (q.represented !== null && q.represented !== undefined) conds.push(q.represented ? sql`x.represented` : sql`not x.represented`);
  if (application) conds.push(sql`x.appl_code = ${application}`);
  if (appealType) conds.push(sql`x.appeal_type = ${appealType}`);
  const where = sql.join(conds, sql` and `);

  const tableSql = {
    eoir_stats_proceedings: eoirStatsProceedings,
    eoir_stats_proceedings_nat: eoirStatsProceedingsNat,
    eoir_stats_applications: eoirStatsApplications,
    eoir_stats_applications_nat: eoirStatsApplicationsNat,
    eoir_stats_appeals: eoirStatsAppeals,
  }[table]!;

  let keyExpr: SQL;
  if (groupBy === "none") keyExpr = sql`'all'`;
  else if (groupBy === "outcome") keyExpr = sql`x.case_type || '|' || x.outcome_kind || '|' || x.outcome_code`;
  else if (groupBy === "decision" && table === "eoir_stats_appeals") keyExpr = sql`case when x.decided then x.bia_decision else '(pending)' end`;
  else if (groupBy === "represented") keyExpr = sql`case when x.represented then 'represented' else 'not represented' end`;
  else keyExpr = sql`${sql.raw(`x.${groupCol}`)}::text`;

  let measures: SQL;
  let columns: string[];
  if (q.measure === "completions") {
    columns = ["completions", "decisions", "other_completions", "in_absentia", "in_absentia_share_of_decisions"];
    measures = sql`sum(x.completions)::bigint as completions,
      coalesce(sum(x.completions) filter (where x.outcome_kind = 'decision'), 0)::bigint as decisions,
      coalesce(sum(x.completions) filter (where x.outcome_kind = 'other'), 0)::bigint as other_completions,
      sum(x.absentia)::bigint as in_absentia`;
  } else if (q.measure === "applications") {
    columns = ["applications", "granted", "denied", "other_or_no_decision", "grant_rate_of_decided", "grant_share_of_all"];
    measures = sql`sum(x.n)::bigint as applications,
      coalesce(sum(x.n) filter (where ${decisionGroupSql(s, sql`x.decision`, "granted")}), 0)::bigint as granted,
      coalesce(sum(x.n) filter (where ${decisionGroupSql(s, sql`x.decision`, "denied")}), 0)::bigint as denied`;
  } else {
    columns = ["appeals", "pending", "decided", ...Object.keys(BIA_DECISION_GROUPS), "other"];
    const groupCases = Object.entries(BIA_DECISION_GROUPS).map(
      ([g, codes]) => sql`coalesce(sum(x.n) filter (where x.decided and x.bia_decision in (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})), 0)::bigint as ${sql.raw(g)}`
    );
    const all = Object.values(BIA_DECISION_GROUPS).flat();
    measures = sql`sum(x.n)::bigint as appeals,
      coalesce(sum(x.n) filter (where not x.decided), 0)::bigint as pending,
      coalesce(sum(x.n) filter (where x.decided), 0)::bigint as decided,
      ${sql.join(groupCases, sql`, `)},
      coalesce(sum(x.n) filter (where x.decided and x.bia_decision not in (${sql.join(all.map((c) => sql`${c}`), sql`, `)})), 0)::bigint as other`;
  }

  const rawRows = resultRows<Raw>(
    await tx.execute(sql`
      select ${keyExpr} as key, ${measures}
      from ${tableSql} x where ${where}
      group by 1 order by ${groupBy === "fy" ? sql`1` : sql`2 desc`} limit ${limit + 1}`)
  );
  const [totalRow] = resultRows<Raw>(await tx.execute(sql`select ${measures} from ${tableSql} x where ${where}`));

  const finish = (r: Raw): Record<string, number | null> => {
    const v: Record<string, number | null> = {};
    for (const c of columns) v[c] = r[c] === undefined ? null : num(r[c]);
    if (q.measure === "completions") v.in_absentia_share_of_decisions = num(r.decisions) > 0 ? num(r.in_absentia) / num(r.decisions) : null;
    if (q.measure === "applications") {
      const counts = { granted: num(r.granted), denied: num(r.denied), total: num(r.applications), other: num(r.applications) - num(r.granted) - num(r.denied) };
      const rt = rates(counts);
      v.other_or_no_decision = counts.other;
      v.grant_rate_of_decided = rt.grantRateOfDecided;
      v.grant_share_of_all = rt.grantShareOfAll;
    }
    return v;
  };

  const label = (key: string): string | null => {
    switch (groupBy) {
      case "judge":
        return labels.judge(key);
      case "court":
        return labels.court(key);
      case "nationality":
        return labels.code("nationality", key);
      case "custody":
        return labels.code("custody", key);
      case "case_type":
        return labels.code("case_type", key);
      case "application":
        return labels.code("application", key);
      case "filed_by":
        return labels.code("filed_by", key);
      case "appeal_type":
        return labels.code("appeal_type", key);
      case "decision":
        return table === "eoir_stats_appeals" ? (key === "(pending)" ? "no Board decision yet" : labels.code("bia_decision", key)) : labels.code("application_decision", key);
      case "outcome": {
        const [ct, kind, code] = key.split("|");
        return kind === "none" ? "no decision or completion code" : labels.code(kind === "decision" ? "ij_decision" : "other_completion", code, ct);
      }
      default:
        return null;
    }
  };

  return {
    measure: q.measure,
    table,
    filters,
    defaultsApplied,
    groupBy,
    columns,
    rows: rawRows.slice(0, limit).map((r) => ({ key: String(r.key), label: label(String(r.key)), values: finish(r) })),
    totals: totalRow ? finish(totalRow) : {},
    truncated: rawRows.length > limit,
  };
}

async function processingQuery(
  tx: LibraryDb,
  snapshot: SnapshotView,
  p: { judge: string | null; court: string | null; custody: string | null; nationality: string | null; period: Period; filters: Record<string, string | number | boolean>; groupBy: StatGroup; q: StatQuery }
): Promise<StatResult> {
  if (p.nationality || p.q.caseType || (p.q.represented !== null && p.q.represented !== undefined) || p.q.application) {
    throw new StatQueryError("Processing times are kept by judge, court (with custody) and nationally, per fiscal year; not by nationality, case type, representation or application.");
  }
  if (p.groupBy !== "fy" && p.groupBy !== "none") throw new StatQueryError("Processing times can only be grouped by fiscal year (group_by fy).");
  if (p.judge && p.custody) throw new StatQueryError("Processing times by custody are kept for courts and nationally, not for a judge.");
  if (p.judge && p.court) throw new StatQueryError("Processing times are kept for a judge or for a court, not for a judge at one court.");
  const scope = p.judge ? "judge" : p.court ? "court" : "national";
  const conds: SQL[] = [
    sql`x.snapshot_id = ${snapshot.id}`,
    sql`x.scope = ${scope}`,
    sql`x.scope_code = ${p.judge ?? p.court ?? ""}`,
    sql`x.custody = ${p.custody ?? "all"}`,
    ...fyConds("x", p.period),
  ];
  const rows = resultRows<Raw>(
    await tx.execute(sql`select x.fy, x.n, x.mean_days, x.p25, x.p50, x.p75 from ${eoirStatsProcessing} x where ${sql.join(conds, sql` and `)} order by x.fy`)
  );
  let n = 0;
  let weighted = 0;
  for (const r of rows) {
    n += num(r.n);
    weighted += num(r.n) * num(r.mean_days);
  }
  return {
    measure: "processing",
    table: "eoir_stats_processing",
    filters: { ...p.filters, scope },
    defaultsApplied: p.custody ? [] : ["custody: all"],
    groupBy: "fy",
    columns: ["completions_timed", "mean_days", "p25_days", "median_days", "p75_days"],
    rows: rows.map((r) => ({
      key: String(r.fy),
      label: null,
      values: { completions_timed: num(r.n), mean_days: num(r.mean_days), p25_days: num(r.p25), median_days: num(r.p50), p75_days: num(r.p75) },
    })),
    // Percentiles do not combine across years; the mean does.
    totals: { completions_timed: n, mean_days: n > 0 ? Math.round((weighted / n) * 10) / 10 : null, p25_days: null, median_days: null, p75_days: null },
    truncated: false,
  };
}
