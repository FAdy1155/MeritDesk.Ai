import "server-only";
import type { PgBoss, Queue } from "pg-boss";
import { getBoss } from "./boss";

// The legal-update check (src/services/monitoring/run-check.ts): every day
// early in the morning, U.S. Central time, on a schedule (the
// eoir-weekly-update skill ran weekly; the platform checks daily, after the
// library's daily runs have fed in what they found, src/services/library/),
// and on demand from an owner/admin's "Check now" on /updates. The worker side (working the queue,
// registering the schedule) is in ./monitoring-worker.ts, so the web app,
// which only sends to this queue, never loads the summarizer.
//
// "exclusive": at most one check is queued or running at a time, across
// every worker and the web app, so a "Check now" during a scheduled check
// (or a second click) is refused by pg-boss instead of starting a second
// check. No retries: the next day's check, or "Check now", is the retry, and
// a failed source never fails the job (each source is recorded on its own).
// The heartbeat lets pg-boss fail the job of a worker that died within
// minutes, which frees the queue for the next check. A check still running
// when the next day's schedule fires is not doubled: the exclusive policy
// refuses the scheduled send.

export const LEGAL_UPDATE_CHECK_QUEUE = "legal-update-check";
// Every day at 05:00 in LEGAL_UPDATE_CHECK_TZ (U.S. Central, daylight saving
// time included: pg-boss evaluates the cron in that time zone), after the
// library's daily runs (01:00 to 04:59 there).
export const LEGAL_UPDATE_CHECK_CRON = "0 5 * * *";
export const LEGAL_UPDATE_CHECK_TZ = "America/Chicago";
export const LEGAL_UPDATE_CHECK_EXPIRE_SECONDS = 2 * 60 * 60;
const LEGAL_UPDATE_CHECK_HEARTBEAT_SECONDS = 5 * 60;
export const LEGAL_UPDATE_CHECK_HEARTBEAT_REFRESH_SECONDS = 60;

export const LEGAL_UPDATE_CHECK_QUEUE_OPTIONS: Omit<Queue, "name"> = {
  policy: "exclusive",
  retryLimit: 0,
  expireInSeconds: LEGAL_UPDATE_CHECK_EXPIRE_SECONDS,
  heartbeatSeconds: LEGAL_UPDATE_CHECK_HEARTBEAT_SECONDS,
  deleteAfterSeconds: 30 * 24 * 60 * 60,
};

export type LegalUpdateCheckJobData = { trigger: "schedule" | "manual" };

/** Creates the queue if it does not exist yet; idempotent, and the options apply only on creation. */
export async function ensureLegalUpdateCheckQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(LEGAL_UPDATE_CHECK_QUEUE, LEGAL_UPDATE_CHECK_QUEUE_OPTIONS);
}

/**
 * Queues a check now. Returns the job id, or null when a check is already
 * queued or running (the exclusive policy refused the send).
 */
export async function enqueueLegalUpdateCheck(trigger: LegalUpdateCheckJobData["trigger"]): Promise<string | null> {
  const boss = await getBoss();
  await ensureLegalUpdateCheckQueue(boss);
  return boss.send(LEGAL_UPDATE_CHECK_QUEUE, { trigger } satisfies LegalUpdateCheckJobData);
}
