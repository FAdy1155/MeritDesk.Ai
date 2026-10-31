import "server-only";
import { and, eq } from "drizzle-orm";
import type { db } from "@/db/client";
import { emailSends } from "@/db/schema";
import type { EmailKind } from "./templates";

// email_sends (migration 0014): one row per tenant, kind and dedupe key.
// The row is the claim: a sender inserts it before calling SES (the unique
// index makes two senders racing for the same email lose all but one),
// fills in SES's message id and the recipient count when SES answers, and
// deletes it when SES refuses, so pg-boss's retry (or tomorrow's daily job)
// sends again. A process that dies between the send and the completion
// leaves a row with no message id: the email went out at most once, which
// is the rule for billing mail, and nothing sends it again.

export type SentEmailKey = { tenantId: string; kind: EmailKind; dedupeKey: string };

export async function wasEmailSent(tx: typeof db, key: SentEmailKey): Promise<boolean> {
  const [row] = await tx
    .select({ id: emailSends.id })
    .from(emailSends)
    .where(and(eq(emailSends.tenantId, key.tenantId), eq(emailSends.kind, key.kind), eq(emailSends.dedupeKey, key.dedupeKey)))
    .limit(1);
  return Boolean(row);
}

/** The dedupe keys already sent (or claimed) for a tenant, as "<kind>\n<key>" strings (the daily job's selection reads them). */
export async function sentEmailKeys(tx: typeof db, tenantId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ kind: emailSends.kind, dedupeKey: emailSends.dedupeKey })
    .from(emailSends)
    .where(eq(emailSends.tenantId, tenantId));
  return new Set(rows.map((r) => sentKey(r.kind as EmailKind, r.dedupeKey)));
}

export function sentKey(kind: EmailKind, dedupeKey: string): string {
  return `${kind}\n${dedupeKey}`;
}

/** Claims the email: inserts its row before the send. Returns the row id, or null when a row for the key already exists (sent, or being sent). */
export async function claimEmailSend(tx: typeof db, key: SentEmailKey, now = new Date()): Promise<string | null> {
  const inserted = await tx
    .insert(emailSends)
    .values({ tenantId: key.tenantId, kind: key.kind, dedupeKey: key.dedupeKey, recipientCount: 0, providerMessageId: null, sentAt: now })
    .onConflictDoNothing({ target: [emailSends.tenantId, emailSends.kind, emailSends.dedupeKey] })
    .returning({ id: emailSends.id });
  return inserted[0]?.id ?? null;
}

/** SES accepted the email: records its message id and how many addresses it went to. */
export async function completeEmailSend(tx: typeof db, id: string, details: { recipientCount: number; providerMessageId: string | null }, now = new Date()): Promise<void> {
  await tx.update(emailSends).set({ recipientCount: details.recipientCount, providerMessageId: details.providerMessageId, sentAt: now }).where(eq(emailSends.id, id));
}

/** SES refused the email: the claim is released so the next attempt sends it. */
export async function releaseEmailSend(tx: typeof db, id: string): Promise<void> {
  await tx.delete(emailSends).where(eq(emailSends.id, id));
}

/**
 * Records an email as sent in one step, for senders that do not go through
 * SES (the check script's stand-in for the worker). Returns false when a
 * row for the key already existed.
 */
export async function recordEmailSent(
  tx: typeof db,
  key: SentEmailKey,
  details: { recipientCount: number; providerMessageId: string | null }
): Promise<boolean> {
  const inserted = await tx
    .insert(emailSends)
    .values({
      tenantId: key.tenantId,
      kind: key.kind,
      dedupeKey: key.dedupeKey,
      recipientCount: details.recipientCount,
      providerMessageId: details.providerMessageId,
    })
    .onConflictDoNothing({ target: [emailSends.tenantId, emailSends.kind, emailSends.dedupeKey] })
    .returning({ id: emailSends.id });
  return inserted.length > 0;
}
