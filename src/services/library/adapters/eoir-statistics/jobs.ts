import "server-only";
import type { Job, PgBoss, Queue } from "pg-boss";
import { withGlobalReadContext, withServiceContext } from "@/db/client";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import type { LibraryTransactions } from "../../db";
import { loadEoirStatistics } from "./load";
import { EOIR_STATS_SOURCE_CODE } from "./model";

// The EOIR statistics load (./load.ts) as a pg-boss job, registered by
// registerEoirStatsJobs, which the worker calls once after the library's
// jobs (src/worker.ts):
//
// - eoir-stats-load: every day at 03:41 U.S. Central time, and on demand
//   (enqueueEoirStatsLoad, or `npm run eoir-stats:load`). It reads EOIR's
//   FOIA library page and the end of the release file (a few kilobytes) and
//   stops there unless the release differs from the current snapshot (its
//   folder name, ETag and size); a new release is streamed and aggregated,
//   which takes tens of minutes (about 1.2 GB of range requests) and a few
//   hundred MB of memory, outside the V8 heap for the most part.
// - "exclusive" with no retries: one load at a time across every worker;
//   the next day's run is the retry (a failed release is retried after 20
//   hours). The heartbeat lets pg-boss fail the job of a worker that died.
// - EOIR_STATS_LOAD=paused, or eoir_case_data in LIBRARY_DISABLED_SOURCES,
//   turns it off.

export const EOIR_STATS_QUEUE = "eoir-stats-load";
const CRON = "41 3 * * *";
const TZ = "America/Chicago";

const QUEUE_OPTIONS: Omit<Queue, "name"> = {
  policy: "exclusive",
  retryLimit: 0,
  expireInSeconds: 4 * 60 * 60,
  heartbeatSeconds: 5 * 60,
  deleteAfterSeconds: 30 * 24 * 60 * 60,
};

export type EoirStatsJobData = { force?: boolean };

const shutdown = new AbortController();

/** Stops a load in progress (the worker calls it on SIGTERM); the load is recorded as failed and runs again on the next day. */
export function stopEoirStatsJobs(): void {
  shutdown.abort(new Error("worker shutdown"));
}

const transactions: LibraryTransactions = {
  write: (fn) => withServiceContext((tx) => fn(tx)),
  read: (fn) => withGlobalReadContext((tx) => fn(tx), { statementTimeoutMs: null }),
};

function paused(): string | null {
  if ((process.env.EOIR_STATS_LOAD ?? "").trim().toLowerCase() === "paused") return "EOIR_STATS_LOAD=paused";
  const disabled = (process.env.LIBRARY_DISABLED_SOURCES ?? "").split(",").map((s) => s.trim());
  return disabled.includes(EOIR_STATS_SOURCE_CODE) ? `${EOIR_STATS_SOURCE_CODE} is in LIBRARY_DISABLED_SOURCES` : null;
}

export async function enqueueEoirStatsLoad(boss: PgBoss, data: EoirStatsJobData = {}): Promise<string | null> {
  await boss.createQueue(EOIR_STATS_QUEUE, QUEUE_OPTIONS);
  return boss.send(EOIR_STATS_QUEUE, data satisfies EoirStatsJobData);
}

/** Creates the queue, works it (one load at a time) and registers the daily schedule. A failure here is logged; the worker keeps running. */
export async function registerEoirStatsJobs(boss: PgBoss): Promise<void> {
  try {
    await boss.createQueue(EOIR_STATS_QUEUE, QUEUE_OPTIONS);
    await boss.work<EoirStatsJobData>(EOIR_STATS_QUEUE, { localConcurrency: 1, heartbeatRefreshSeconds: 60 }, async ([job]: Job<EoirStatsJobData>[]) => {
      const reason = paused();
      if (reason) {
        console.log(`[eoir-stats] load skipped: ${reason}`);
        return;
      }
      try {
        const outcome = await loadEoirStatistics({ transactions, signal: shutdown.signal, log: (line) => console.log(line), force: job.data?.force === true });
        if (outcome.status === "loaded") {
          console.log(`[eoir-stats] ${outcome.releaseFolder ?? "release"} loaded in ${outcome.seconds} s: ${JSON.stringify(outcome.rowCounts)}`);
        } else if (outcome.status === "up_to_date") {
          console.log(`[eoir-stats] ${outcome.releaseFolder ?? "the release"} is already loaded`);
        } else {
          console.log(`[eoir-stats] load skipped: ${outcome.reason}`);
        }
      } catch (err) {
        console.error(`[eoir-stats] load failed: ${describeErrorForLog(err)}`);
        throw new Error("EOIR statistics load failed.");
      }
    });
    await boss.schedule(EOIR_STATS_QUEUE, CRON, {} satisfies EoirStatsJobData, { tz: TZ });
    console.log(`[worker] EOIR statistics: daily release check at 03:41 ${TZ}${paused() ? ` (paused: ${paused()})` : ""}`);
  } catch (err) {
    console.error(`[eoir-stats] could not register the statistics load (is migration 0008 applied?): ${describeErrorForLog(err)}`);
  }
}
