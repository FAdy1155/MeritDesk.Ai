import "server-only";
import type { ConcurrencySetting } from "./concurrency";

export const SKILL_RUN_QUEUE = "skill-run";

export type SkillRunJobData = {
  skillRunId: string;
  tenantId: string;
};

// How many of one tenant's runs may wait "queued" at once; enqueueSkillRun
// (src/services/skill-runner/run.ts) refuses the next one until some start.
export const QUEUED_RUNS_PER_TENANT_MAX = 25;

// How long pg-boss lets a skill-run job stay active before it fails it. A
// run's own wall clock (RUN_DEADLINE_MS in run.ts) is an hour shorter, so a
// live run always records its own outcome first.
export const SKILL_RUN_JOB_EXPIRE_SECONDS = 4 * 60 * 60;

// pg-boss heartbeats: while a handler runs, the worker refreshes its job's
// heartbeat every SKILL_RUN_HEARTBEAT_REFRESH_SECONDS. If the worker dies
// (crash, OOM kill, machine stop), the refreshes stop and pg-boss's
// supervisor fails the job once the heartbeat is this old, instead of
// leaving it "active" until the 4-hour expiry. The stuck-run sweep
// (src/services/skill-runner/stuck-runs.ts) then fails the run's row.
// Generous on purpose: a live worker would have to miss five refreshes in a
// row (for example a long database outage) before its job is failed.
export const SKILL_RUN_JOB_HEARTBEAT_SECONDS = 5 * 60;
export const SKILL_RUN_HEARTBEAT_REFRESH_SECONDS = 60;

// How many skill runs one worker process works on at once (pg-boss
// localConcurrency, src/worker.ts). A run spends most of its time waiting
// on the model, so several share a machine; what bounds this is memory (each
// run holds its matter documents and conversation, and may start a
// LibreOffice conversion or a ClamAV scan). The default fits the VM in
// fly.worker.toml, whose comments give the memory budget.
export const SKILL_RUN_CONCURRENCY: ConcurrencySetting = { env: "SKILL_RUN_CONCURRENCY", fallback: 4, max: 16 };

// Per-tenant fairness: at most this many of one tenant's runs in progress in
// a worker process (pg-boss localGroupConcurrency), so one firm's backlog
// cannot take every slot; its other runs wait "queued", in order, while
// other firms' runs start. Unset: half of SKILL_RUN_CONCURRENCY, rounded up
// (readPerTenantLimit). pg-boss counts jobs by their group, so every
// skill-run job is sent with group: { id: tenantId } (enqueueSkillRun in
// run.ts); a job without one is not limited. Counted per process: with two
// worker machines a tenant can have this many on each.
export const SKILL_RUN_TENANT_CONCURRENCY_ENV = "SKILL_RUN_TENANT_CONCURRENCY";
