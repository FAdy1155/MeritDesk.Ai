import { createLibraryHttp } from "../../http/client";
import type { LibraryTransactions } from "../../db";
import { aggregateRelease, readCurrentRelease, type CurrentRelease } from "./loader";
import { DEFINITIONS } from "./model";
import { abandonStaleLoads, failSnapshot, finishSnapshot, pruneSnapshots, snapshotStates, startSnapshot, writeAggregates } from "./store";

// One statistics load, start to finish: is there a release the app has not
// loaded yet (or a forced reload), then read and aggregate it
// (./loader.ts) and write it as the new current snapshot (./store.ts).
// Used by the worker job (./jobs.ts) and the manual command (./cli.ts);
// takes the transactions as a parameter, so it runs against the app's
// database or PGlite alike.

/** Every host the load reads: the FOIA library page (justice.gov) and the release (fileshare.eoir.justice.gov). */
export const EOIR_STATS_HOSTS = ["www.justice.gov", "justice.gov", "fileshare.eoir.justice.gov"] as const;

export type LoadOutcome =
  | { status: "up_to_date"; releaseFolder: string | null }
  | { status: "skipped"; reason: string }
  | { status: "loaded"; snapshotId: string; releaseFolder: string | null; rowCounts: Record<string, number>; seconds: number };

export async function loadEoirStatistics(params: {
  transactions: LibraryTransactions;
  signal: AbortSignal;
  log: (line: string) => void;
  force?: boolean;
  /** Local tests only: read a prefix of each table (the snapshot is then marked as partial in its notes). */
  maxCompressedBytesPerTable?: number;
}): Promise<LoadOutcome> {
  const { transactions, signal, log } = params;
  const notes: string[] = [];
  const note = (m: string) => {
    if (!notes.includes(m) && notes.length < 50) notes.push(m);
    log(`[eoir-stats] note: ${m}`);
  };
  const http = createLibraryHttp({ hosts: EOIR_STATS_HOSTS, priority: "backfill", signal, note });

  const stale = await abandonStaleLoads(transactions, 6);
  if (stale) log(`[eoir-stats] ${stale} unfinished load(s) from a stopped worker marked failed`);

  const current: CurrentRelease = await readCurrentRelease(http);
  const states = await transactions.write((tx) => snapshotStates(tx));
  const same = (s: { releaseFolder: string | null; archiveEtag: string | null; archiveBytes: number | null } | null) =>
    s !== null && s.releaseFolder === current.folder && s.archiveEtag === current.release.etag && Number(s.archiveBytes) === current.release.fileSize;
  if (!params.force && same(states.current)) return { status: "up_to_date", releaseFolder: current.folder };
  if (!params.force && states.latest?.status === "loading" && same(states.latest)) {
    return { status: "skipped", reason: "a load of this release is already in progress" };
  }
  if (!params.force && states.latest?.status === "failed" && same(states.latest) && Date.now() - states.latest.startedAt.getTime() < 20 * 60 * 60 * 1000) {
    return { status: "skipped", reason: `the last load of this release failed less than 20 hours ago (${states.latest.error ?? "no error recorded"}); the next daily run retries it` };
  }

  const started = Date.now();
  const snapshotId = await transactions.write((tx) =>
    startSnapshot(
      tx,
      {
        releaseFolder: current.folder,
        dataDate: current.dataDate,
        listedLabel: current.links.caseData.label,
        pageUrl: current.pageUrl,
        officialUrl: current.release.url,
        codeKeyUrl: current.links.codeKey?.url ?? null,
        archiveEtag: current.release.etag,
        archiveLastModified: current.release.lastModified,
        archiveBytes: current.release.fileSize,
      },
      { ...DEFINITIONS }
    )
  );
  log(`[eoir-stats] loading ${current.folder ?? current.release.url} (${current.release.fileSize} bytes) as snapshot ${snapshotId}`);
  try {
    if (params.maxCompressedBytesPerTable !== undefined) note(`TEST LOAD: only the first ${params.maxCompressedBytesPerTable} compressed bytes of each table were read; these counts are partial.`);
    const result = await aggregateRelease(http, current, { signal, note, log: (m) => log(`[eoir-stats] ${m}`), maxCompressedBytesPerTable: params.maxCompressedBytesPerTable });
    const rowCounts = await writeAggregates(transactions, snapshotId, result, { signal, log: (m) => log(`[eoir-stats] ${m}`) });
    await transactions.write((tx) => finishSnapshot(tx, snapshotId, { tableCounts: result.tables, rowCounts, notes }));
    const pruned = await transactions.write((tx) => pruneSnapshots(tx));
    if (pruned) log(`[eoir-stats] ${pruned} older snapshot(s) removed`);
    return { status: "loaded", snapshotId, releaseFolder: current.folder, rowCounts, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failSnapshot(transactions, snapshotId, message).catch((e) => log(`[eoir-stats] could not record the failure: ${e instanceof Error ? e.message : String(e)}`));
    throw err;
  }
}
