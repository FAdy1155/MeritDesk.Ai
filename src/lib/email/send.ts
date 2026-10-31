import "server-only";
import { eq } from "drizzle-orm";
import { withServiceContext } from "@/db/client";
import { tenantBilling, tenants } from "@/db/schema";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import type { BillingEmailJobData } from "@/services/queue/billing-jobs";
import { ownerAdminEmails } from "./recipients";
import { claimEmailSend, completeEmailSend, releaseEmailSend, wasEmailSent } from "./send-log";
import { isEmailConfigured, sendEmail } from "./ses";
import { isEmailKind, renderEmail } from "./templates";

// One billing-email job (src/services/queue/billing-worker.ts): sends the
// email at most once. In order: skip if email_sends already has the key;
// find the tenant (skip a deleted or complimentary firm); read its
// owner/admins' verified addresses from Clerk; skip (with a log line, not
// a failure) when SES is not configured or nobody can receive it; claim
// the email_sends row; render; send; complete the row with SES's message
// id. If SES refuses, the claim is deleted and the error rethrown, so
// pg-boss retries; a crash after SES accepted leaves the claim in place,
// so the email is never sent twice.

export type EmailSendOutcome = "sent" | "already_sent" | "no_recipients" | "email_not_configured" | "tenant_missing" | "complimentary";

export async function processBillingEmail(data: BillingEmailJobData): Promise<EmailSendOutcome> {
  if (!isEmailKind(data.kind)) throw new Error(`Unknown email kind "${String(data.kind)}"`);
  const key = { tenantId: data.tenantId, kind: data.kind, dedupeKey: data.dedupeKey };

  const tenant = await withServiceContext(async (tx) => {
    if (await wasEmailSent(tx, key)) return "already_sent" as const;
    const [row] = await tx
      .select({ clerkOrgId: tenants.clerkOrgId, name: tenants.name, deletedAt: tenants.deletedAt, complimentary: tenantBilling.complimentary })
      .from(tenants)
      .leftJoin(tenantBilling, eq(tenantBilling.tenantId, tenants.id))
      .where(eq(tenants.id, data.tenantId))
      .limit(1);
    return row ?? null;
  });
  if (tenant === "already_sent") return "already_sent";
  if (!tenant || tenant.deletedAt) {
    console.warn(`[email] ${data.kind} for tenant ${data.tenantId} not sent: the tenant no longer exists`);
    return "tenant_missing";
  }
  if (tenant.complimentary) {
    console.log(`[email] ${data.kind} for tenant ${data.tenantId} not sent: the firm has complimentary access`);
    return "complimentary";
  }
  if (!isEmailConfigured()) {
    console.warn(`[email] ${data.kind} for tenant ${data.tenantId} not sent: SES_FROM_ADDRESS is not set`);
    return "email_not_configured";
  }

  const to = await ownerAdminEmails(tenant.clerkOrgId);
  if (to.length === 0) {
    console.warn(`[email] ${data.kind} for tenant ${data.tenantId} not sent: the firm has no owner/admin with a verified email address in Clerk`);
    return "no_recipients";
  }

  const claimId = await withServiceContext((tx) => claimEmailSend(tx, key));
  if (!claimId) return "already_sent";

  const rendered = renderEmail(data.kind, data.params as never);
  let messageId: string | null;
  try {
    ({ messageId } = await sendEmail({ to, subject: rendered.subject, text: rendered.text, html: rendered.html }));
  } catch (err) {
    await withServiceContext((tx) => releaseEmailSend(tx, claimId)).catch((releaseErr) => {
      console.error(`[email] the claim on ${data.kind} for tenant ${data.tenantId} could not be released: ${describeErrorForLog(releaseErr)}`);
    });
    throw err;
  }
  await withServiceContext((tx) => completeEmailSend(tx, claimId, { recipientCount: to.length, providerMessageId: messageId }));
  console.log(`[email] sent ${data.kind} to ${to.length} owner/admin(s) of tenant ${data.tenantId}`);
  return "sent";
}
