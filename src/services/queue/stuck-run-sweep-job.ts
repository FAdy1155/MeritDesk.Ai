import "server-only";
import type { Queue } from "pg-boss";

// Scheduled by the worker (src/worker.ts) with boss.schedule: every 5
// minutes, sweepStuckSkillRuns (src/services/skill-runner/stuck-runs.ts)
// fails skill runs a dead worker left "running", and runs left "queued"
// with no queue job that would ever start them.
export const STUCK_RUN_SWEEP_QUEUE = "skill-run-stuck-sweep";
export const STUCK_RUN_SWEEP_CRON = "*/5 * * * *";

// "stately": at most one sweep queued and one active, so a backlog (worker
// down for hours) never piles up sweeps. No retries: the next tick is the
// retry. Finished sweep jobs are kept a day rather than pg-boss's default week.
export const STUCK_RUN_SWEEP_QUEUE_OPTIONS: Omit<Queue, "name"> = {
  policy: "stately",
  retryLimit: 0,
  expireInSeconds: 10 * 60,
  deleteAfterSeconds: 24 * 60 * 60,
};
