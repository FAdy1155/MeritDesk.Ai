import "server-only";
import { eq } from "drizzle-orm";
import type { db } from "@/db/client";
import { tenantBilling } from "@/db/schema";
import { AUDIT_ACTIONS, SYSTEM_ACTORS, recordAuditEvent } from "@/lib/audit/service";
import { ensureTenantBilling, lockTenantBilling, reconcileLock, type BillingRow } from "./store";

// Complimentary access: the operator's own firm (or a firm the operator
// chooses) is entitled without a subscription and gets no billing emails.
// Set only from the command line (npm run billing:comp, src/lib/billing/cli/
// complimentary.ts); nothing in the web app or the connector can grant it.
// Every change is audited as billing.complimentary_set.

export async function setComplimentary(
  tx: typeof db,
  params: { tenantId: string; complimentary: boolean; operator: string; now?: Date }
): Promise<{ row: BillingRow; changed: boolean }> {
  const now = params.now ?? new Date();
  await ensureTenantBilling(tx, params.tenantId, now);
  const row = (await lockTenantBilling(tx, params.tenantId))!;
  if (row.complimentary === params.complimentary) return { row, changed: false };
  const [updated] = await tx
    .update(tenantBilling)
    .set({ complimentary: params.complimentary, updatedAt: now })
    .where(eq(tenantBilling.tenantId, params.tenantId))
    .returning();
  await recordAuditEvent(tx, {
    tenantId: params.tenantId,
    actorUserId: SYSTEM_ACTORS.billingCli,
    action: AUDIT_ACTIONS.billingComplimentarySet,
    resourceType: "billing",
    resourceId: params.tenantId,
    before: { complimentary: row.complimentary },
    after: { complimentary: params.complimentary, operator: params.operator },
  });
  const { row: reconciled } = await reconcileLock(tx, updated, SYSTEM_ACTORS.billingCli, now);
  return { row: reconciled, changed: true };
}
