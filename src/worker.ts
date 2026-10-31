import "./load-env";
import type { Job, PgBoss } from "pg-boss";
import { getBoss } from "./services/queue/boss";
import {
  SKILL_RUN_QUEUE,
  SKILL_RUN_HEARTBEAT_REFRESH_SECONDS,
  SKILL_RUN_CONCURRENCY,
  SKILL_RUN_TENANT_CONCURRENCY_ENV,
  type SkillRunJobData,
} from "./services/queue/skill-run-job";
import {
  DOCUMENT_INGEST_QUEUE,
  DOCUMENT_INGEST_CONCURRENCY,
  DOCUMENT_INGEST_TENANT_CONCURRENCY_ENV,
  type DocumentIngestJobData,
} from "./services/queue/document-ingest-job";
import { STUCK_RUN_SWEEP_CRON, STUCK_RUN_SWEEP_QUEUE } from "./services/queue/stuck-run-sweep-job";
import { registerMonitoringJobs } from "./services/queue/monitoring-worker";
import { registerBillingJobs } from "./services/queue/billing-worker";
import { registerLibraryJobs, stopLibraryJobs } from "./services/library/jobs";
import { registerEoirStatsJobs, stopEoirStatsJobs } from "./services/library/adapters/eoir-statistics/jobs";
import {
  libreOfficeSlots,
  malwareScanSlots,
  readConcurrencySetting,
  readPerTenantLimit,
} from "./services/queue/concurrency";
import { processSkillRun } from "./services/skill-runner/run";
import { sweepStuckSkillRuns } from "./services/skill-runner/stuck-runs";
import { processDocumentIngest, logIngestToolAvailability } from "./services/ingest/ingest";
import { failUnfinishedSkillRun } from "./lib/skill-runs/service";
import { SYSTEM_ACTORS } from "./lib/audit/service";
import { assertDatabaseRoleEnforcesRls } from "./db/client";
import { describeErrorForLog, safeErrorMessage } from "./lib/errors/safe-error";

// On SIGTERM/SIGINT the worker stops taking jobs and waits this long for
// the ones in progress before giving up on them. It must stay below
// kill_timeout in fly.worker.toml (120s), which is when Fly kills the
// process outright; the difference is time to record the outcome. Upload
// scans (tens of seconds) usually finish; most skill runs take longer and
// are marked failed so they can be retried at once.
const DEFAULT_SHUTDOWN_GRACE_SECONDS = 90;
const MAX_SHUTDOWN_GRACE_SECONDS = 280;

const SHUTDOWN_INTERRUPTED_MESSAGE =
  "This run was interrupted: the background worker shut down (a deploy or restart) before the run finished. " +
  "No report was saved. Use Retry to run it again.";

// Jobs this process is working on, across all its slots. Skill runs
// (skillRunId -> tenantId): whatever is still here when a shutdown gives up
// waiting is marked failed. Upload jobs (pg-boss job ids) only for the logs:
// pg-boss puts those back on the queue itself.
const inFlightSkillRuns = new Map<string, string>();
const inFlightIngestJobs = new Set<string>();

function shutdownGraceSeconds(): number {
  const raw = process.env.WORKER_SHUTDOWN_GRACE_SECONDS;
  if (!raw) return DEFAULT_SHUTDOWN_GRACE_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > MAX_SHUTDOWN_GRACE_SECONDS) {
    console.warn(
      `[worker] WORKER_SHUTDOWN_GRACE_SECONDS="${raw}" is not a number from 1 to ${MAX_SHUTDOWN_GRACE_SECONDS}; ` +
        `using ${DEFAULT_SHUTDOWN_GRACE_SECONDS}`
    );
    return DEFAULT_SHUTDOWN_GRACE_SECONDS;
  }
  return seconds;
}

async function main() {
  // Refuse to take jobs as a database role row-level security does not
  // apply to (src/db/client.ts); the error says how to fix the role.
  await assertDatabaseRoleEnforcesRls();
  console.log("[worker] database role: subject to row-level security");
  await logIngestToolAvailability();
  const boss = await getBoss();

  // Slot counts (README "Worker concurrency"; fly.worker.toml sets them and
  // sizes the VM for them).
  const skillRunSlots = readConcurrencySetting(SKILL_RUN_CONCURRENCY);
  const skillRunTenantSlots = readPerTenantLimit(SKILL_RUN_TENANT_CONCURRENCY_ENV, skillRunSlots);
  const ingestSlots = readConcurrencySetting(DOCUMENT_INGEST_CONCURRENCY);
  const ingestTenantSlots = readPerTenantLimit(DOCUMENT_INGEST_TENANT_CONCURRENCY_ENV, ingestSlots);
  console.log(
    `[worker] concurrency: ${skillRunSlots} skill run(s) at once, at most ${skillRunTenantSlots} per tenant; ` +
      `${ingestSlots} upload job(s) at once, at most ${ingestTenantSlots} per tenant; ` +
      `${libreOfficeSlots().limit} LibreOffice conversion(s) and ${malwareScanSlots().limit} ClamAV scan(s) at once`
  );

  // Skill runs, up to skillRunSlots at once: pg-boss starts that many
  // pollers on the queue (localConcurrency), each working one job at a
  // time. localGroupConcurrency is the per-tenant guard: jobs are grouped by
  // tenant when sent (enqueueSkillRun), and a tenant with
  // skillRunTenantSlots runs in progress here is skipped by the next fetch
  // (a job fetched in the same instant is put straight back), so its other
  // runs stay queued, in order, while other tenants' runs start. It is
  // counted in this process, so it is exact; the database-tracked
  // groupConcurrency can be overshot by pollers fetching at the same moment,
  // and pg-boss takes one or the other, not both.
  //
  // Each job is sent with a heartbeat (enqueueSkillRun). pg-boss refreshes
  // every job in progress on its own timer, every
  // SKILL_RUN_HEARTBEAT_REFRESH_SECONDS, so a dead worker's jobs are all
  // failed within minutes, however many there were.
  await boss.work<SkillRunJobData>(
    SKILL_RUN_QUEUE,
    {
      localConcurrency: skillRunSlots,
      localGroupConcurrency: skillRunTenantSlots,
      heartbeatRefreshSeconds: SKILL_RUN_HEARTBEAT_REFRESH_SECONDS,
    },
    async ([job]: Job<SkillRunJobData>[]) => {
      const { skillRunId, tenantId } = job.data;
      if (!job.groupId) {
        console.warn(
          `[worker] SkillRun ${skillRunId} was queued without a tenant group, so the per-tenant limit does not apply to it`
        );
      }
      inFlightSkillRuns.set(skillRunId, tenantId);
      console.log(
        `[worker] processing SkillRun ${skillRunId} (tenant ${tenantId}; ` +
          `${inFlightSkillRuns.size} of ${skillRunSlots} skill-run slots in use)`
      );
      try {
        await processSkillRun(skillRunId, tenantId);
      } catch (err) {
        // pg-boss stores the thrown error as the job's output (no RLS, kept
        // for days): hand it a message with no query values or tool input.
        console.error(`[worker] SkillRun ${skillRunId} failed: ${describeErrorForLog(err)}`);
        throw new Error(safeErrorMessage(err));
      } finally {
        inFlightSkillRuns.delete(skillRunId);
      }
      console.log(`[worker] finished SkillRun ${skillRunId}`);
    }
  );

  // Malware scan + text extraction for each upload (src/services/ingest/ingest.ts).
  // Its own queue and its own slots, so long skill runs never hold up
  // scanning new uploads; the per-tenant guard works as for skill runs.
  await boss.work<DocumentIngestJobData>(
    DOCUMENT_INGEST_QUEUE,
    { localConcurrency: ingestSlots, localGroupConcurrency: ingestTenantSlots },
    async ([job]: Job<DocumentIngestJobData>[]) => {
      const { documentId, tenantId } = job.data;
      inFlightIngestJobs.add(job.id);
      console.log(
        `[worker] ingesting document ${documentId} (tenant ${tenantId}; ` +
          `${inFlightIngestJobs.size} of ${ingestSlots} upload slots in use)`
      );
      try {
        await processDocumentIngest(documentId, tenantId);
      } catch (err) {
        // pg-boss stores the thrown error as the job's output (no RLS, kept
        // for days): hand it a message with no query values or object keys.
        console.error(`[worker] ingesting document ${documentId} failed: ${describeErrorForLog(err)}`);
        throw new Error(safeErrorMessage(err));
      } finally {
        inFlightIngestJobs.delete(job.id);
      }
      console.log(`[worker] finished ingesting document ${documentId}`);
    }
  );

  // Every 5 minutes: fail skill runs a dead worker left "running", and
  // "queued" runs no job will ever start (src/services/skill-runner/stuck-runs.ts).
  // Its own queue and poller, so it runs on schedule even while every
  // skill-run slot is busy. schedule() is an upsert, so every worker start
  // re-registers the same schedule.
  await boss.work(STUCK_RUN_SWEEP_QUEUE, async () => {
    const result = await sweepStuckSkillRuns();
    for (const run of result.failed) {
      console.warn(`[worker] stuck-run sweep failed SkillRun ${run.skillRunId} (tenant ${run.tenantId}): ${run.reason}`);
    }
    if (result.skipped > 0) {
      console.warn(`[worker] stuck-run sweep could not check ${result.skipped} run(s); they are checked again next time`);
    }
  });
  await boss.schedule(STUCK_RUN_SWEEP_QUEUE, STUCK_RUN_SWEEP_CRON);

  // The daily legal-update check (src/services/monitoring/,
  // src/services/queue/monitoring-worker.ts): creates its own queue (one
  // check at a time), works it with its own single poller, registers the
  // daily schedule and logs its own "listening on" line. Its queue is not
  // in QUEUES in boss.ts: monitoring-jobs.ts imports getBoss from boss.ts,
  // so the reverse import would be a cycle. boss.stop() in shutdown() stops
  // its worker along with these.
  await registerMonitoringJobs(boss);

  // Billing (src/services/queue/billing-worker.ts, README "Trial, billing
  // and emails"): the email queue (welcome, reminders, receipts, sent
  // through SES to each firm's owner/admins) and the daily job that locks
  // firms whose free month or subscription ended, queues the reminders due
  // and keeps seats in step with Stripe. Needs CLERK_SECRET_KEY on the
  // worker for the recipients; without SES_FROM_ADDRESS it logs and skips.
  await registerBillingJobs(boss);

  // The library (src/services/library/jobs.ts, docs/LIBRARY.md): its daily
  // run per source, its backfill chunks and the hourly backfill kick, each
  // queue with its own pollers, one job per host at a time. It records the
  // registered sources first; if it cannot (migration 0007 not applied), it
  // logs why and stays off, and everything above keeps running.
  await registerLibraryJobs(boss);

  // EOIR court and judge statistics
  // (src/services/library/adapters/eoir-statistics/jobs.ts): a daily check of
  // EOIR's case data release, loaded into the migration 0008 aggregates when
  // a new one is posted. A failure to register is logged; the rest keeps running.
  await registerEoirStatsJobs(boss);

  installShutdownHandlers(boss);
  console.log(
    `[worker] listening on "${SKILL_RUN_QUEUE}", "${DOCUMENT_INGEST_QUEUE}" and "${STUCK_RUN_SWEEP_QUEUE}" ` +
      `(sweep schedule "${STUCK_RUN_SWEEP_CRON}")`
  );
}

/**
 * Graceful shutdown. Fly sends kill_signal (SIGTERM, set in fly.worker.toml;
 * Fly's own default is SIGINT) when it stops the machine for a deploy or
 * restart, and kills the process kill_timeout later. Ctrl+C sends SIGINT.
 *
 * 1. boss.stop: every poller of every queue stops fetching, the jobs in
 *    progress in all slots get up to the grace period to finish, then
 *    pg-boss fails the jobs still active (upload scans have retries left
 *    and are picked up again by the next worker; skill-run jobs have none)
 *    and closes its connections.
 * 2. Skill runs still in progress are marked failed with a message saying
 *    to use Retry, instead of sitting "running" until the stuck-run sweep
 *    notices. Runs that finished meanwhile are left alone.
 *
 * A second signal stops waiting: in-progress runs are marked failed and the
 * process exits at once.
 */
function installShutdownHandlers(boss: PgBoss) {
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.warn(`[worker] ${signal} again: not waiting for in-flight jobs any longer`);
      void markInterruptedSkillRuns().finally(() => process.exit(1));
      return;
    }
    shuttingDown = true;
    shutdown(boss, signal).then(
      () => process.exit(0),
      (err) => {
        console.error(`[worker] shutdown failed: ${describeErrorForLog(err)}`);
        process.exit(1);
      }
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

async function shutdown(boss: PgBoss, signal: NodeJS.Signals): Promise<void> {
  const graceSeconds = shutdownGraceSeconds();
  console.log(
    `[worker] ${signal} received: taking no new jobs; waiting up to ${graceSeconds}s for jobs in progress ` +
      `(${inFlightSkillRuns.size} skill run(s), ${inFlightIngestJobs.size} upload job(s))`
  );
  // Library runs stop fetching now and record what they stored, instead of
  // using the grace period (they resume on their next run or chunk).
  stopLibraryJobs();
  stopEoirStatsJobs();
  try {
    await boss.stop({ graceful: true, timeout: graceSeconds * 1000 });
  } catch (err) {
    console.error(`[worker] pg-boss did not stop cleanly: ${describeErrorForLog(err)}`);
  }
  await markInterruptedSkillRuns();
  console.log("[worker] shutdown complete");
}

async function markInterruptedSkillRuns(): Promise<void> {
  await Promise.all(
    [...inFlightSkillRuns].map(async ([skillRunId, tenantId]) => {
      try {
        const changed = await failUnfinishedSkillRun({
          tenantId,
          skillRunId,
          fromStatuses: ["queued", "running"],
          errorMessage: SHUTDOWN_INTERRUPTED_MESSAGE,
          actor: SYSTEM_ACTORS.workerShutdown,
          reason: "worker_shutdown",
        });
        if (changed) console.warn(`[worker] marked SkillRun ${skillRunId} failed: interrupted by shutdown`);
      } catch (err) {
        // The stuck-run sweep fails it later (its job's heartbeat stops).
        console.error(`[worker] could not mark SkillRun ${skillRunId} failed during shutdown: ${describeErrorForLog(err)}`);
      }
    })
  );
}

main().catch((err) => {
  console.error(`[worker] fatal error: ${describeErrorForLog(err)}`);
  process.exit(1);
});
