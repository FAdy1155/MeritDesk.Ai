import "server-only";
import type { Job, PgBoss } from "pg-boss";
import { runLegalUpdateCheck } from "@/services/monitoring/run-check";
import {
  ensureLegalUpdateCheckQueue,
  LEGAL_UPDATE_CHECK_CRON,
  LEGAL_UPDATE_CHECK_HEARTBEAT_REFRESH_SECONDS,
  LEGAL_UPDATE_CHECK_QUEUE,
  LEGAL_UPDATE_CHECK_TZ,
  type LegalUpdateCheckJobData,
} from "./monitoring-jobs";

/**
 * Called once by the worker (src/worker.ts) after getBoss(): creates the
 * legal-update queue, works it (one check at a time, see the queue policy in
 * ./monitoring-jobs.ts), and registers the daily schedule. schedule() is an
 * upsert on the queue name, so every worker start registers the same one, and
 * the first start of this version replaces the earlier Monday schedule. Worker only: this
 * module loads the summarizer and the skill runner's model settings.
 */
export async function registerMonitoringJobs(boss: PgBoss): Promise<void> {
  await ensureLegalUpdateCheckQueue(boss);
  await boss.work<LegalUpdateCheckJobData>(
    LEGAL_UPDATE_CHECK_QUEUE,
    { heartbeatRefreshSeconds: LEGAL_UPDATE_CHECK_HEARTBEAT_REFRESH_SECONDS },
    async ([job]: Job<LegalUpdateCheckJobData>[]) => {
      const trigger = job.data?.trigger === "manual" ? "manual" : "schedule";
      console.log(`[legal-updates] check started (${trigger}, job ${job.id})`);
      const totals = await runLegalUpdateCheck({ trigger, pgBossJobId: job.id });
      console.log(`[legal-updates] check finished: ${JSON.stringify(totals)}`);
    }
  );
  await boss.schedule(LEGAL_UPDATE_CHECK_QUEUE, LEGAL_UPDATE_CHECK_CRON, { trigger: "schedule" }, { tz: LEGAL_UPDATE_CHECK_TZ });
  console.log(`[worker] listening on "${LEGAL_UPDATE_CHECK_QUEUE}" (schedule "${LEGAL_UPDATE_CHECK_CRON}" ${LEGAL_UPDATE_CHECK_TZ})`);
}
