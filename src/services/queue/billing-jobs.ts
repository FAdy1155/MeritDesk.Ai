import "server-only";
import { sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss, type Queue } from "pg-boss";
import type { db } from "@/db/client";
import type { EmailKind, EmailParams } from "@/lib/email/templates";
import { getBoss } from "./boss";

// Billing's two queues (README "Trial, billing and emails"). The worker
// side (working them, the daily schedule) is in ./billing-worker.ts, so the
// web app, which only sends to the email queue, never loads SES or Clerk's
// backend client.
//
// billing-email: one job per email to a firm, sent by the Stripe webhook
// (receipts, failed payments, confirmations), by tenant creation (welcome)
// and by the daily job (reminders). The job reads the firm's owner/admin
// addresses from Clerk, renders the template and sends through SES
// (src/lib/email/send.ts). "exclusive" with a singletonKey per tenant, kind
// and dedupe key: one such job may be queued or active at a time, so a
// second send while one is in flight is refused (send returns null), and
// email_sends makes a completed one final. A failed send is retried a few
// times with backoff; after that the daily job (for reminders) or a
// redelivered Stripe event (for receipts) queues it again.
//
// A sender inside a database transaction passes it (`tx`): pg-boss then
// writes the job through that transaction (its Drizzle adapter), so the
// job commits with the change that called for it, or not at all. pg-boss's
// tables live in the same database (QUEUE_DATABASE_URL is a direct
// connection to it) and are owned by the same runtime role, so the app's
// pooled connection can write them.
//
// billing-daily: once a day, src/lib/billing/daily.ts locks firms whose
// free month or subscription ended, queues the reminders that are due and
// keeps seat counts in step with Stripe. "stately": one queued and one
// active at most, so a worker that was down does not run a backlog of them.

export const BILLING_EMAIL_QUEUE = "billing-email";
export const BILLING_DAILY_QUEUE = "billing-daily";

// Every day at 09:00 in BILLING_DAILY_TZ (U.S. Central), a working hour for
// the reminders it sends.
export const BILLING_DAILY_CRON = "0 9 * * *";
export const BILLING_DAILY_TZ = "America/Chicago";

export const BILLING_EMAIL_QUEUE_OPTIONS: Omit<Queue, "name"> = {
  policy: "exclusive",
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 5 * 60,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
};

export const BILLING_DAILY_QUEUE_OPTIONS: Omit<Queue, "name"> = {
  policy: "stately",
  retryLimit: 0,
  expireInSeconds: 30 * 60,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
};

export type BillingEmailJobData<K extends EmailKind = EmailKind> = {
  tenantId: string;
  kind: K;
  /** What makes this email one of a kind for the tenant (src/lib/email/templates.ts). */
  dedupeKey: string;
  params: EmailParams[K];
};

export async function ensureBillingQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(BILLING_EMAIL_QUEUE, BILLING_EMAIL_QUEUE_OPTIONS);
  await boss.createQueue(BILLING_DAILY_QUEUE, BILLING_DAILY_QUEUE_OPTIONS);
}

/** The singletonKey of an email job: one in flight per tenant, kind and dedupe key. */
export function billingEmailSingletonKey(data: Pick<BillingEmailJobData, "tenantId" | "kind" | "dedupeKey">): string {
  return `${data.tenantId}:${data.kind}:${data.dedupeKey}`;
}

/**
 * Queues one email. Returns the job id, or null when the same email is
 * already queued or in flight. `startAfterSeconds` delays it (a welcome
 * waits for Clerk's membership events to land); `tx` writes the job in that
 * transaction (see above).
 */
export async function enqueueBillingEmail<K extends EmailKind>(
  data: BillingEmailJobData<K>,
  options: { startAfterSeconds?: number; tx?: typeof db } = {}
): Promise<string | null> {
  const boss = await getBoss();
  await ensureBillingQueues(boss);
  return boss.send(BILLING_EMAIL_QUEUE, data, {
    singletonKey: billingEmailSingletonKey(data),
    ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
    ...(options.tx ? { db: fromDrizzle(options.tx, sql) } : {}),
  });
}
