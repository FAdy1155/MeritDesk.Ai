import "server-only";
import type { Job, PgBoss } from "pg-boss";
import { runBillingDaily } from "@/lib/billing/daily";
import { processBillingEmail } from "@/lib/email/send";
import { describeErrorForLog, safeErrorMessage } from "@/lib/errors/safe-error";
import {
  BILLING_DAILY_CRON,
  BILLING_DAILY_QUEUE,
  BILLING_DAILY_TZ,
  BILLING_EMAIL_QUEUE,
  ensureBillingQueues,
  type BillingEmailJobData,
} from "./billing-jobs";

/**
 * Called once by the worker (src/worker.ts) after getBoss(): creates the
 * billing queues (./billing-jobs.ts), works the email queue (one send per
 * job, src/lib/email/send.ts) and the daily queue (src/lib/billing/daily.ts),
 * and registers the daily schedule. schedule() is an upsert on the queue
 * name, so every worker start registers the same one. Worker only: this
 * loads SES and Clerk's backend client.
 */
export async function registerBillingJobs(boss: PgBoss): Promise<void> {
  await ensureBillingQueues(boss);

  await boss.work<BillingEmailJobData>(BILLING_EMAIL_QUEUE, async ([job]: Job<BillingEmailJobData>[]) => {
    const { tenantId, kind } = job.data;
    try {
      const outcome = await processBillingEmail(job.data);
      if (outcome !== "sent") console.log(`[email] ${kind} for tenant ${tenantId}: ${outcome}`);
    } catch (err) {
      // pg-boss stores the thrown error as the job's output (no RLS, kept
      // for days): hand it a message with no addresses or query values.
      console.error(`[email] ${kind} for tenant ${tenantId} failed: ${describeErrorForLog(err)}`);
      throw new Error(safeErrorMessage(err));
    }
  });

  await boss.work(BILLING_DAILY_QUEUE, async () => {
    console.log("[billing] daily job started");
    const summary = await runBillingDaily();
    console.log(`[billing] daily job finished: ${JSON.stringify(summary)}`);
  });
  await boss.schedule(BILLING_DAILY_QUEUE, BILLING_DAILY_CRON, null, { tz: BILLING_DAILY_TZ });
  console.log(
    `[worker] listening on "${BILLING_EMAIL_QUEUE}" and "${BILLING_DAILY_QUEUE}" (schedule "${BILLING_DAILY_CRON}" ${BILLING_DAILY_TZ})`
  );
}
