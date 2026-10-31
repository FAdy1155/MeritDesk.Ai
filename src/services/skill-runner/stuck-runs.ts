import "server-only";
import type { JobWithMetadata } from "pg-boss";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { withServiceContext } from "@/db/client";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { skillRuns } from "@/db/schema";
import { SYSTEM_ACTORS } from "@/lib/audit/service";
import { failUnfinishedSkillRun, type SkillRunFailureReason } from "@/lib/skill-runs/service";
import { getBoss } from "@/services/queue/boss";
import {
  SKILL_RUN_JOB_EXPIRE_SECONDS,
  SKILL_RUN_JOB_HEARTBEAT_SECONDS,
  SKILL_RUN_QUEUE,
  type SkillRunJobData,
} from "@/services/queue/skill-run-job";

// A run still "running" this long after it started is failed whatever its
// job says: past the queue's job expiry plus a margin, no live run can still
// be working (its own deadline is an hour before the expiry). This is the
// backstop for anything the job checks below miss.
export const STALE_RUNNING_AFTER_SECONDS = SKILL_RUN_JOB_EXPIRE_SECONDS + 30 * 60;

// Running rows younger than this are not checked: a dead worker's job is
// only failed once its heartbeat is SKILL_RUN_JOB_HEARTBEAT_SECONDS old.
const RUNNING_CHECK_AFTER_SECONDS = SKILL_RUN_JOB_HEARTBEAT_SECONDS;

// Queued rows younger than this are not checked: enqueueSkillRun commits the
// row a moment before it sends the job.
const QUEUED_CHECK_AFTER_SECONDS = 10 * 60;

// A job that ended less than this long ago may belong to a handler whose own
// record step (processSkillRun) is still landing; the next sweep looks again.
const JOB_END_GRACE_MS = 2 * 60 * 1000;

// Bounded work per sweep; anything left over is picked up 5 minutes later.
const MAX_RUNS_PER_SWEEP = 200;

const LIVE_JOB_STATES = new Set(["created", "retry", "active"]);

export type StuckRunCandidate = {
  id: string;
  tenantId: string;
  status: "queued" | "running";
  /** Seconds since the run started (running) or was created (queued), by the database clock. */
  ageSeconds: number;
};

type Verdict =
  | { action: "leave" }
  | { action: "fail"; reason: SkillRunFailureReason; errorMessage: string };

export type StuckRunSweepResult = {
  checked: number;
  failed: { skillRunId: string; tenantId: string; reason: SkillRunFailureReason }[];
  /** Runs that could not be checked or updated this time (left as they are, retried next sweep). */
  skipped: number;
};

/**
 * The scheduled stuck-run sweep (worker, every 5 minutes; see
 * src/services/queue/stuck-run-sweep-job.ts). Fails, with a message saying
 * what happened and to use Retry:
 *
 * - "running" runs whose worker died: their pg-boss job ended (failed by
 *   the heartbeat check, the expiry, or a shutdown) or no longer exists, or
 *   they have been running longer than STALE_RUNNING_AFTER_SECONDS;
 * - "queued" runs that no job will ever start: no job in created, retry or
 *   active state exists for them.
 *
 * Finding candidates crosses tenants, so that one read runs in service
 * context (RLS bypassed), and it reads only ids, tenant ids, statuses and
 * ages. Each change is then made in that run's own tenant context, through
 * failUnfinishedSkillRun, which re-checks the status under a row lock, so a
 * run that finished meanwhile is never overwritten.
 */
export async function sweepStuckSkillRuns(): Promise<StuckRunSweepResult> {
  const candidates = await findCandidates();
  const result: StuckRunSweepResult = { checked: candidates.length, failed: [], skipped: 0 };
  if (candidates.length === 0) return result;

  const boss = await getBoss();
  for (const candidate of candidates) {
    let verdict: Verdict;
    try {
      verdict = await judge(candidate, (skillRunId) =>
        boss.findJobs<SkillRunJobData>(SKILL_RUN_QUEUE, { data: { skillRunId } })
      );
    } catch (err) {
      // The queue could not be read: never treat that as "no job".
      console.error(`[stuck-runs] could not look up the queue job for SkillRun ${candidate.id}; leaving it: ${describeErrorForLog(err)}`);
      result.skipped += 1;
      continue;
    }
    if (verdict.action === "leave") continue;

    try {
      const changed = await failUnfinishedSkillRun({
        tenantId: candidate.tenantId,
        skillRunId: candidate.id,
        fromStatuses: [candidate.status],
        errorMessage: verdict.errorMessage,
        actor: SYSTEM_ACTORS.stuckRunSweeper,
        reason: verdict.reason,
      });
      if (changed) {
        result.failed.push({ skillRunId: candidate.id, tenantId: candidate.tenantId, reason: verdict.reason });
      }
    } catch (err) {
      console.error(`[stuck-runs] could not mark SkillRun ${candidate.id} failed; trying again next sweep: ${describeErrorForLog(err)}`);
      result.skipped += 1;
    }
  }
  return result;
}

/** The one cross-tenant read: unfinished runs old enough to check, oldest first. */
async function findCandidates(): Promise<StuckRunCandidate[]> {
  return withServiceContext((tx) =>
    tx
      .select({
        id: skillRuns.id,
        tenantId: skillRuns.tenantId,
        status: sql<"queued" | "running">`${skillRuns.status}`,
        ageSeconds: sql<number>`(extract(epoch from now() - coalesce(${skillRuns.startedAt}, ${skillRuns.createdAt})))::int`,
      })
      .from(skillRuns)
      .where(
        or(
          and(
            eq(skillRuns.status, "running"),
            sql`coalesce(${skillRuns.startedAt}, ${skillRuns.createdAt}) < now() - make_interval(secs => ${RUNNING_CHECK_AFTER_SECONDS})`
          ),
          and(
            eq(skillRuns.status, "queued"),
            sql`${skillRuns.createdAt} < now() - make_interval(secs => ${QUEUED_CHECK_AFTER_SECONDS})`
          )
        )
      )
      .orderBy(asc(skillRuns.createdAt))
      .limit(MAX_RUNS_PER_SWEEP)
  );
}

/**
 * Decides one candidate from its age and its pg-boss job(s). Exported for
 * tests, with the job lookup injected.
 */
export async function judge(
  candidate: StuckRunCandidate,
  findJobs: (skillRunId: string) => Promise<JobWithMetadata<SkillRunJobData>[]>,
  now: Date = new Date()
): Promise<Verdict> {
  if (candidate.status === "running" && candidate.ageSeconds > STALE_RUNNING_AFTER_SECONDS) {
    const hours = Math.floor(candidate.ageSeconds / 3600);
    return {
      action: "fail",
      reason: "stuck_running",
      errorMessage:
        `This run was still marked "running" ${hours} hours after it started, longer than any run is allowed to take ` +
        `(the queue gives a run ${SKILL_RUN_JOB_EXPIRE_SECONDS / 3600} hours), so the worker processing it most likely stopped. ` +
        "No report was saved. Use Retry to run it again.",
    };
  }

  const jobs = await findJobs(candidate.id);
  if (jobs.some((job) => LIVE_JOB_STATES.has(job.state))) return { action: "leave" };

  // Every job for the run has ended (or there is none). Give a job that only
  // just ended time for its handler's own record step.
  const lastEnded = jobs.reduce<Date | null>((latest, job) => {
    const ended = job.completedOn ? new Date(job.completedOn) : null;
    return ended && (!latest || ended > latest) ? ended : latest;
  }, null);
  if (lastEnded && now.getTime() - lastEnded.getTime() < JOB_END_GRACE_MS) return { action: "leave" };

  const queueSays = jobs.length === 0 ? null : jobEndReason(jobs);
  if (candidate.status === "running") {
    return {
      action: "fail",
      reason: "worker_stopped",
      errorMessage:
        "This run was interrupted: the background worker processing it stopped before it finished " +
        (queueSays ? `(the queue reports: ${queueSays})` : "(its queue job no longer exists)") +
        ", most likely a crash, restart or deploy. No report was saved. Use Retry to run it again.",
    };
  }
  return {
    action: "fail",
    reason: "never_started",
    errorMessage:
      "This run never started: " +
      (queueSays
        ? `its queue job ended before a worker picked the run up (the queue reports: ${queueSays}).`
        : "no queue job exists for it, so no worker would ever pick it up (it was most likely lost while being queued).") +
      " Use Retry to queue it again.",
  };
}

/** The most recently ended job's state and pg-boss's reason, as one short line. */
function jobEndReason(jobs: JobWithMetadata<SkillRunJobData>[]): string {
  const latest = [...jobs].sort(
    (a, b) => new Date(b.completedOn ?? b.createdOn).getTime() - new Date(a.completedOn ?? a.createdOn).getTime()
  )[0];
  const message = outputMessage(latest.output);
  const text = message ? `${latest.state}, ${message}` : latest.state;
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/**
 * pg-boss stores a failure as the job's output: { value: { message } } for
 * its own timeouts, { value: "..." } for a plain string, or a serialized
 * Error ({ message, ... }) for a handler that threw.
 */
function outputMessage(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { message?: unknown; value?: unknown };
  if (typeof o.message === "string") return o.message;
  if (typeof o.value === "string") return o.value;
  if (o.value && typeof o.value === "object" && typeof (o.value as { message?: unknown }).message === "string") {
    return (o.value as { message: string }).message;
  }
  return null;
}
