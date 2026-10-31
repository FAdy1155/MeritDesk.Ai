import "server-only";
import type { Job, PgBoss, Queue } from "pg-boss";
import { withGlobalReadContext, withServiceContext } from "@/db/client";
import { putLibraryOriginal } from "@/lib/s3";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { readConcurrencySetting } from "@/services/queue/concurrency";
import type { LibraryTransactions } from "./db";
import { runBackfillChunk, runDaily, type PipelineDeps } from "./pipeline";
import {
  adaptersInBackfillOrder,
  backfillPausedReason,
  dailyCronFor,
  getLibraryAdapter,
  isManualSource,
  isSourceDisabled,
  LIBRARY_DAILY_TZ,
  listLibraryAdapters,
  missingEnv,
  rejectedAdapterMessages,
} from "./registry";
import { loadBackfillState, syncSources } from "./store";
import type { LibrarySourceAdapter } from "./types";

// The library's background jobs (pg-boss), all registered by
// registerLibraryJobs, which the worker calls once (src/worker.ts):
//
// - library-daily: one scheduled job per source each day, early morning
//   U.S. Central time, staggered (registry.ts dailyCronFor) so every run
//   starts before the 05:00 legal-update check that summarizes what the
//   runs feed it. "stately" with the source code as singletonKey: at most one
//   queued and one running per source, so a slow run is never doubled. A
//   source's failure is its own; retried twice, 30 minutes apart, then the
//   next day's run is the retry.
// - library-backfill: one chunk of one source's history per job; a chunk
//   that leaves more queues the next one. Low priority: fewer slots than the
//   daily runs, and ctx.http gives daily requests the host first.
// - library-backfill-kick: hourly, queues a chunk for every source whose
//   history walk is not complete (unless paused), in the backfill order of
//   groups.ts (immigration core first), as job priority.
//
// Both run queues group jobs by the adapter's first host, and the worker
// runs at most one job per host at a time (localGroupConcurrency 1), so two
// sources on justice.gov take turns instead of sharing its crawl delay.
// Pausing: LIBRARY_BACKFILL=paused (all sources) or
// LIBRARY_BACKFILL_PAUSED_SOURCES=<code>,<code>; LIBRARY_DISABLED_SOURCES
// turns sources off entirely. Sources missing an API key are skipped and
// shown as needing it. Sources in LIBRARY_MANUAL_SOURCES (by default the
// thirteen whose sites refuse automated tools) get no daily schedule and no
// backfill: they are kept up to date by import from the official site
// (./manual-import.ts).

export const LIBRARY_DAILY_QUEUE = "library-daily";
export const LIBRARY_BACKFILL_QUEUE = "library-backfill";
export const LIBRARY_BACKFILL_KICK_QUEUE = "library-backfill-kick";
const BACKFILL_KICK_CRON = "17 * * * *";
const HEARTBEAT_SECONDS = 5 * 60;
const HEARTBEAT_REFRESH_SECONDS = 60;

const DAILY_QUEUE_OPTIONS: Omit<Queue, "name"> = {
  policy: "stately",
  retryLimit: 2,
  retryDelay: 30 * 60,
  // Above LIBRARY_DAILY_RUN_MINUTES (100), so a live run records its own outcome first.
  expireInSeconds: 2 * 60 * 60,
  heartbeatSeconds: HEARTBEAT_SECONDS,
  deleteAfterSeconds: 14 * 24 * 60 * 60,
};

const BACKFILL_QUEUE_OPTIONS: Omit<Queue, "name"> = {
  policy: "stately",
  retryLimit: 0,
  // Above LIBRARY_BACKFILL_CHUNK_MINUTES (50).
  expireInSeconds: 90 * 60,
  heartbeatSeconds: HEARTBEAT_SECONDS,
  deleteAfterSeconds: 3 * 24 * 60 * 60,
};

const KICK_QUEUE_OPTIONS: Omit<Queue, "name"> = {
  policy: "stately",
  retryLimit: 0,
  expireInSeconds: 10 * 60,
  deleteAfterSeconds: 24 * 60 * 60,
};

export type LibraryJobData = { code: string };

const DAILY_CONCURRENCY = { env: "LIBRARY_DAILY_CONCURRENCY", fallback: 2, max: 8 };
const BACKFILL_CONCURRENCY = { env: "LIBRARY_BACKFILL_CONCURRENCY", fallback: 2, max: 8 };

// Aborted when the worker shuts down, so runs in progress stop fetching and record what they stored.
const shutdown = new AbortController();

/** Stops the library's runs in progress (the worker calls it on SIGTERM before stopping pg-boss). */
export function stopLibraryJobs(): void {
  shutdown.abort(new Error("worker shutdown"));
}

const transactions: LibraryTransactions = {
  write: (fn) => withServiceContext((tx) => fn(tx)),
  read: (fn) => withGlobalReadContext((tx) => fn(tx), { statementTimeoutMs: null }),
};

function pipelineDeps(): PipelineDeps {
  return {
    tx: transactions,
    storeOriginal: process.env.LIBRARY_STORE_ORIGINALS === "true" ? putLibraryOriginal : null,
    log: (line) => console.log(line),
  };
}

/** The pacing group of a source: its first host, without "www.". */
export function hostGroup(adapter: LibrarySourceAdapter): string {
  return (adapter.hosts[0] ?? adapter.code).replace(/^www\./, "");
}

function backfillPriority(code: string): number {
  const order = adaptersInBackfillOrder();
  const at = order.findIndex((a) => a.code === code);
  return Math.max(1, order.length - Math.max(at, 0));
}

async function enqueueBackfill(boss: PgBoss, adapter: LibrarySourceAdapter, startAfterSeconds = 0): Promise<string | null> {
  return boss.send(LIBRARY_BACKFILL_QUEUE, { code: adapter.code } satisfies LibraryJobData, {
    singletonKey: adapter.code,
    priority: backfillPriority(adapter.code),
    group: { id: hostGroup(adapter) },
    ...(startAfterSeconds ? { startAfter: startAfterSeconds } : {}),
  });
}

/** Queues a backfill chunk for every source whose history walk is not complete. */
async function kickBackfill(boss: PgBoss): Promise<void> {
  for (const adapter of adaptersInBackfillOrder()) {
    if (backfillPausedReason(adapter.code) || isSourceDisabled(adapter.code) || missingEnv(adapter).length || isManualSource(adapter.code)) continue;
    const state = await withServiceContext((tx) => loadBackfillState(tx, adapter.code));
    if (state.status === "complete") continue;
    await enqueueBackfill(boss, adapter);
  }
}

/**
 * Creates the library's queues, writes every registered source to
 * library_sources, works the queues and registers the schedules. A failure
 * here (for example migration 0007 not applied yet) is logged and leaves
 * the library off; the worker's other queues keep running.
 */
export async function registerLibraryJobs(boss: PgBoss): Promise<void> {
  for (const message of rejectedAdapterMessages()) {
    console.error(`[library] collector left out, misconfigured: ${message}`);
  }
  const adapters = listLibraryAdapters();
  try {
    await withServiceContext((tx) =>
      syncSources(
        tx,
        adapters.map((adapter) => ({
          adapter,
          missingEnv: missingEnv(adapter),
          disabled: isSourceDisabled(adapter.code),
          manual: isManualSource(adapter.code),
        }))
      )
    );
  } catch (err) {
    console.error(`[library] could not record the library's sources (is migration 0007 applied?): ${describeErrorForLog(err)}; library jobs are off`);
    return;
  }

  await boss.createQueue(LIBRARY_DAILY_QUEUE, DAILY_QUEUE_OPTIONS);
  await boss.createQueue(LIBRARY_BACKFILL_QUEUE, BACKFILL_QUEUE_OPTIONS);
  await boss.createQueue(LIBRARY_BACKFILL_KICK_QUEUE, KICK_QUEUE_OPTIONS);

  const dailySlots = readConcurrencySetting(DAILY_CONCURRENCY);
  const backfillSlots = readConcurrencySetting(BACKFILL_CONCURRENCY);

  await boss.work<LibraryJobData>(
    LIBRARY_DAILY_QUEUE,
    { localConcurrency: dailySlots, localGroupConcurrency: 1, heartbeatRefreshSeconds: HEARTBEAT_REFRESH_SECONDS },
    async ([job]: Job<LibraryJobData>[]) => {
      const code = job.data?.code;
      if (!code || !getLibraryAdapter(code)) {
        console.warn(`[library] daily job ${job.id} names no registered source (${String(code)}); ignored`);
        return;
      }
      try {
        await runDaily(code, { pgBossJobId: job.id, signal: shutdown.signal }, pipelineDeps());
      } catch (err) {
        // pg-boss keeps the thrown error as the job's output: a message with no query values.
        console.error(`[library] ${code} daily run failed: ${describeErrorForLog(err)}`);
        throw new Error(`Library daily run of ${code} failed.`);
      }
    }
  );

  await boss.work<LibraryJobData>(
    LIBRARY_BACKFILL_QUEUE,
    { localConcurrency: backfillSlots, localGroupConcurrency: 1, heartbeatRefreshSeconds: HEARTBEAT_REFRESH_SECONDS },
    async ([job]: Job<LibraryJobData>[]) => {
      const adapter = job.data?.code ? getLibraryAdapter(job.data.code) : null;
      if (!adapter) return;
      try {
        const result = await runBackfillChunk(adapter.code, { pgBossJobId: job.id, signal: shutdown.signal }, pipelineDeps());
        if (result.more && !shutdown.signal.aborted) await enqueueBackfill(boss, adapter, 5);
      } catch (err) {
        console.error(`[library] ${adapter.code} backfill chunk failed: ${describeErrorForLog(err)}`);
        throw new Error(`Library backfill chunk of ${adapter.code} failed.`);
      }
    }
  );

  await boss.work(LIBRARY_BACKFILL_KICK_QUEUE, async () => {
    try {
      await kickBackfill(boss);
    } catch (err) {
      console.error(`[library] backfill kick failed: ${describeErrorForLog(err)}`);
    }
  });

  // One schedule per source, keyed by its code; schedules of sources no longer registered, or now kept up
  // to date by manual import (LIBRARY_MANUAL_SOURCES), are removed.
  const scheduled = adapters.filter((a) => !isManualSource(a.code));
  const codes = new Set(scheduled.map((a) => a.code));
  for (const schedule of await boss.getSchedules(LIBRARY_DAILY_QUEUE)) {
    if (!codes.has(schedule.key)) await boss.unschedule(LIBRARY_DAILY_QUEUE, schedule.key);
  }
  for (const adapter of scheduled) {
    await boss.schedule(LIBRARY_DAILY_QUEUE, dailyCronFor(adapter.code), { code: adapter.code } satisfies LibraryJobData, {
      tz: LIBRARY_DAILY_TZ,
      key: adapter.code,
      singletonKey: adapter.code,
      group: { id: hostGroup(adapter) },
    });
  }
  await boss.schedule(LIBRARY_BACKFILL_KICK_QUEUE, BACKFILL_KICK_CRON);

  const paused = (process.env.LIBRARY_BACKFILL ?? "on").trim().toLowerCase() === "paused";
  console.log(
    `[worker] library: ${adapters.length} source(s), ${adapters.length - scheduled.length} kept up to date by manual import; daily runs from 01:00 ${LIBRARY_DAILY_TZ} (${dailySlots} at once, one per host); ` +
      `backfill ${paused ? "paused (LIBRARY_BACKFILL=paused)" : `on (${backfillSlots} chunk(s) at once, one per host, kicked hourly)`}; ` +
      `originals ${process.env.LIBRARY_STORE_ORIGINALS === "true" ? "stored in S3" : "not stored"}`
  );
  if (!paused) {
    // Start backfill now rather than at the next hourly kick.
    await kickBackfill(boss).catch((err) => console.error(`[library] backfill kick failed: ${describeErrorForLog(err)}`));
  }
}
