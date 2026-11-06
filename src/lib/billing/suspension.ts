import "server-only";
import { eq } from "drizzle-orm";
import type { db } from "@/db/client";
import { tenantBilling } from "@/db/schema";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";
import { ensureTenantBilling, lockTenantBilling, reconcileLock, type BillingRow } from "./store";

const MAX_REASON_CHARS = 500;

export function normalizeSuspensionReason(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_REASON_CHARS);
}

/**
 * Operator suspension: the firm is locked regardless of trial, subscription
 * or complimentary access until the operator clears it. Data is retained.
 * Called only from /platform (src/lib/platform/service.ts).
 */
export async function setOperatorSuspended(
  tx: typeof db,
  params: {
    tenantId: string;
    suspended: boolean;
    actorUserId: string;
    reason?: string | null;
    now?: Date;
  }
): Promise<{ row: BillingRow; changed: boolean }> {
  const now = params.now ?? new Date();
  await ensureTenantBilling(tx, params.tenantId, now);
  const row = (await lockTenantBilling(tx, params.tenantId))!;
  const reason = params.suspended ? normalizeSuspensionReason(params.reason) : null;
  if (row.operatorSuspended === params.suspended && (params.suspended ? row.operatorSuspendedReason === reason : true)) {
    return { row, changed: false };
  }
  const [updated] = await tx
    .update(tenantBilling)
    .set({
      operatorSuspended: params.suspended,
      operatorSuspendedAt: params.suspended ? now : null,
      operatorSuspendedReason: reason,
      updatedAt: now,
    })
    .where(eq(tenantBilling.tenantId, params.tenantId))
    .returning();
  await recordAuditEvent(tx, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: params.suspended ? AUDIT_ACTIONS.billingOperatorSuspended : AUDIT_ACTIONS.billingOperatorUnsuspended,
    resourceType: "billing",
    resourceId: params.tenantId,
    before: { operatorSuspended: row.operatorSuspended },
    after: { operatorSuspended: params.suspended, reason },
  });
  const { row: reconciled } = await reconcileLock(tx, updated, params.actorUserId, now);
  return { row: reconciled, changed: true };
}
