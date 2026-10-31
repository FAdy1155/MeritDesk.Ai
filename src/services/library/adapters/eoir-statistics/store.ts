import { and, desc, eq, getTableName, inArray, lt, ne, sql } from "drizzle-orm";
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
import type { LibraryDb, LibraryTransactions } from "../../db";
import type { AggregateResult } from "./aggregate";

// The writes of the EOIR statistics (migration 0008): a snapshot is created
// as 'loading', its aggregate rows are inserted in batches (each batch its
// own service-context transaction, so a load of a few million rows never
// holds one long transaction), then one transaction makes it 'current' and
// the previous one 'superseded', and the superseded snapshots are deleted
// (their rows go with them, ON DELETE CASCADE). A failed load deletes its
// rows and keeps the snapshot row, status 'failed', with the error, for the
// page. Not an adapter module: the worker job (./jobs.ts) and the local
// check use it; the probe never loads it.

const BATCH_ROWS = 2_000;

export type SnapshotInfo = {
  releaseFolder: string | null;
  dataDate: string | null;
  listedLabel: string | null;
  pageUrl: string;
  officialUrl: string;
  codeKeyUrl: string | null;
  archiveEtag: string | null;
  archiveLastModified: string | null;
  archiveBytes: number | null;
};

export async function startSnapshot(tx: LibraryDb, info: SnapshotInfo, definitions: Record<string, string>): Promise<string> {
  const [row] = await tx
    .insert(eoirStatsSnapshots)
    .values({ ...info, status: "loading", definitions })
    .returning({ id: eoirStatsSnapshots.id });
  return row.id;
}

async function insertInBatches<R, V>(
  transactions: LibraryTransactions,
  rows: Iterable<R>,
  map: (row: R) => V,
  insert: (tx: LibraryDb, values: V[]) => Promise<unknown>,
  signal?: AbortSignal
): Promise<number> {
  let batch: V[] = [];
  let written = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    if (signal?.aborted) throw new Error("The statistics load was stopped (the worker is shutting down).");
    const values = batch;
    batch = [];
    await transactions.write((tx) => insert(tx, values));
    written += values.length;
  };
  for (const row of rows) {
    batch.push(map(row));
    if (batch.length >= BATCH_ROWS) await flush();
  }
  await flush();
  return written;
}

/** Inserts every aggregate row of `result` under `snapshotId`; returns the rows written per table. */
export async function writeAggregates(
  transactions: LibraryTransactions,
  snapshotId: string,
  result: AggregateResult,
  options: { signal?: AbortSignal; log?: (message: string) => void } = {}
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const s = options.signal;
  const step = async (name: string, run: () => Promise<number>) => {
    const started = Date.now();
    counts[name] = await run();
    options.log?.(`${name}: ${counts[name]} rows written in ${Math.round((Date.now() - started) / 1000)} s`);
  };

  await step("judges", () =>
    insertInBatches(transactions, result.judges, (j) => ({ snapshotId, judgeCode: j.code, name: j.name, lookupActive: j.lookupActive, completions: j.completions, firstFy: j.firstFy, lastFy: j.lastFy, courts: j.courts }), (tx, v) => tx.insert(eoirStatsJudges).values(v), s)
  );
  await step("courts", () =>
    insertInBatches(transactions, result.courts, (c) => ({ snapshotId, courtCode: c.code, city: c.city, state: c.state, region: c.region, lookupActive: c.lookupActive, completions: c.completions, firstFy: c.firstFy, lastFy: c.lastFy }), (tx, v) => tx.insert(eoirStatsCourts).values(v), s)
  );
  await step("codes", () =>
    insertInBatches(transactions, result.codes, (c) => ({ snapshotId, ...c }), (tx, v) => tx.insert(eoirStatsCodes).values(v), s)
  );
  await step("proceedings", () =>
    insertInBatches(
      transactions,
      result.proceedings(),
      (r) => ({ snapshotId, judgeCode: r.judge, courtCode: r.court, fy: r.fy, caseType: r.caseType, custody: r.custody, represented: r.represented, outcomeKind: r.outcomeKind, outcomeCode: r.outcomeCode, completions: r.completions, absentia: r.absentia, daysN: r.daysN, daysSum: r.daysSum }),
      (tx, v) => tx.insert(eoirStatsProceedings).values(v),
      s
    )
  );
  await step("proceedingsByNationality", () =>
    insertInBatches(
      transactions,
      result.proceedingsByNationality(),
      (r) => ({ snapshotId, courtCode: r.court, fy: r.fy, nationality: r.nat, caseType: r.caseType, custody: r.custody, represented: r.represented, outcomeKind: r.outcomeKind, outcomeCode: r.outcomeCode, completions: r.completions, absentia: r.absentia }),
      (tx, v) => tx.insert(eoirStatsProceedingsNat).values(v),
      s
    )
  );
  await step("applications", () =>
    insertInBatches(
      transactions,
      result.applications(),
      (r) => ({ snapshotId, judgeCode: r.judge, courtCode: r.court, fy: r.fy, applCode: r.appl, decision: r.decision, custody: r.custody, represented: r.represented, n: r.n }),
      (tx, v) => tx.insert(eoirStatsApplications).values(v),
      s
    )
  );
  await step("applicationsByNationality", () =>
    insertInBatches(
      transactions,
      result.applicationsByNationality(),
      (r) => ({ snapshotId, judgeCode: r.judge, courtCode: r.court, fy: r.fy, nationality: r.nat, applCode: r.appl, decision: r.decision, n: r.n }),
      (tx, v) => tx.insert(eoirStatsApplicationsNat).values(v),
      s
    )
  );
  await step("appeals", () =>
    insertInBatches(
      transactions,
      result.appeals(),
      (r) => ({ snapshotId, judgeCode: r.judge, courtCode: r.court, fy: r.fy, appealType: r.appealType, filedBy: r.filedBy, biaDecision: r.decision, decided: r.decided, n: r.n }),
      (tx, v) => tx.insert(eoirStatsAppeals).values(v),
      s
    )
  );
  await step("processing", () =>
    insertInBatches(
      transactions,
      result.processing(),
      (r) => ({ snapshotId, scope: r.scope, scopeCode: r.code, fy: r.fy, custody: r.custody, n: r.n, meanDays: r.meanDays, p25: r.p25, p50: r.p50, p75: r.p75 }),
      (tx, v) => tx.insert(eoirStatsProcessing).values(v),
      s
    )
  );
  return counts;
}

/** Makes the snapshot current and the previous current one superseded, in one transaction. */
export async function finishSnapshot(
  tx: LibraryDb,
  snapshotId: string,
  data: { tableCounts: Record<string, unknown>; rowCounts: Record<string, number>; notes: string[] }
): Promise<void> {
  await tx.update(eoirStatsSnapshots).set({ status: "superseded", updatedAt: new Date() }).where(and(eq(eoirStatsSnapshots.status, "current"), ne(eoirStatsSnapshots.id, snapshotId)));
  await tx
    .update(eoirStatsSnapshots)
    .set({ status: "current", loadedAt: new Date(), tableCounts: data.tableCounts, rowCounts: data.rowCounts, notes: data.notes, updatedAt: new Date() })
    .where(eq(eoirStatsSnapshots.id, snapshotId));
}

/** Deletes superseded snapshots (their rows go with them) and all but the last few failed attempts. */
export async function pruneSnapshots(tx: LibraryDb, keepFailed = 5): Promise<number> {
  const superseded = await tx.delete(eoirStatsSnapshots).where(eq(eoirStatsSnapshots.status, "superseded")).returning({ id: eoirStatsSnapshots.id });
  const failed = await tx
    .select({ id: eoirStatsSnapshots.id })
    .from(eoirStatsSnapshots)
    .where(eq(eoirStatsSnapshots.status, "failed"))
    .orderBy(desc(eoirStatsSnapshots.startedAt));
  const old = failed.slice(keepFailed).map((r) => r.id);
  if (old.length) await tx.delete(eoirStatsSnapshots).where(inArray(eoirStatsSnapshots.id, old));
  return superseded.length + old.length;
}

const ROW_TABLES = [eoirStatsJudges, eoirStatsCourts, eoirStatsCodes, eoirStatsProceedings, eoirStatsProceedingsNat, eoirStatsApplications, eoirStatsApplicationsNat, eoirStatsAppeals, eoirStatsProcessing];

/** A failed load: its rows deleted, the snapshot row kept with status 'failed' and the error. */
export async function failSnapshot(transactions: LibraryTransactions, snapshotId: string, error: string): Promise<void> {
  for (const table of ROW_TABLES) {
    await transactions.write((tx) => tx.delete(table).where(eq(table.snapshotId, snapshotId)));
  }
  await transactions.write((tx) =>
    tx.update(eoirStatsSnapshots).set({ status: "failed", error: error.slice(0, 2_000), updatedAt: new Date() }).where(eq(eoirStatsSnapshots.id, snapshotId))
  );
}

/** Loads left 'loading' by a worker that stopped (older than `hours`): failed, rows deleted. */
export async function abandonStaleLoads(transactions: LibraryTransactions, hours: number): Promise<number> {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const stale = await transactions.write((tx) =>
    tx.select({ id: eoirStatsSnapshots.id }).from(eoirStatsSnapshots).where(and(eq(eoirStatsSnapshots.status, "loading"), lt(eoirStatsSnapshots.startedAt, cutoff)))
  );
  for (const { id } of stale) await failSnapshot(transactions, id, "The load did not finish (the worker stopped or restarted); its rows were removed.");
  return stale.length;
}

export type SnapshotState = {
  id: string;
  status: string;
  releaseFolder: string | null;
  archiveEtag: string | null;
  archiveBytes: number | null;
  startedAt: Date;
  loadedAt: Date | null;
  error: string | null;
};

/** The current snapshot and the latest attempt (which may be the same), for the job's "is there anything new" check. */
export async function snapshotStates(tx: LibraryDb): Promise<{ current: SnapshotState | null; latest: SnapshotState | null }> {
  const cols = {
    id: eoirStatsSnapshots.id,
    status: eoirStatsSnapshots.status,
    releaseFolder: eoirStatsSnapshots.releaseFolder,
    archiveEtag: eoirStatsSnapshots.archiveEtag,
    archiveBytes: eoirStatsSnapshots.archiveBytes,
    startedAt: eoirStatsSnapshots.startedAt,
    loadedAt: eoirStatsSnapshots.loadedAt,
    error: eoirStatsSnapshots.error,
  };
  const [current] = await tx.select(cols).from(eoirStatsSnapshots).where(eq(eoirStatsSnapshots.status, "current")).limit(1);
  const [latest] = await tx.select(cols).from(eoirStatsSnapshots).orderBy(desc(eoirStatsSnapshots.startedAt)).limit(1);
  return { current: current ?? null, latest: latest ?? null };
}

/** Rows per table of a snapshot (the local check uses it). */
export async function countRows(tx: LibraryDb, snapshotId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ROW_TABLES) {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.snapshotId, snapshotId));
    out[getTableName(table)] = row?.n ?? 0;
  }
  return out;
}
