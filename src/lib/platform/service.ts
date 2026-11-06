import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { withServiceContext } from "@/db/client";
import { documents, memberships, tenantBilling, tenantUsageMonthly, tenants } from "@/db/schema";
import { computeEntitlement, type Entitlement } from "@/lib/billing/entitlement";
import { billableInputTokens, quotaLimitsFor, utcMonthStart, type QuotaLimits } from "@/lib/billing/quotas";
import { setOperatorSuspended } from "@/lib/billing/suspension";
import { isPlatformOperator } from "@/lib/platform-admin";

export class PlatformForbiddenError extends Error {
  constructor() {
    super("This page is limited to the platform's operators (LIBRARY_IMPORT_ADMINS).");
    this.name = "PlatformForbiddenError";
  }
}

function requireOperator(userId: string | null | undefined): string {
  if (!isPlatformOperator(userId)) throw new PlatformForbiddenError();
  return userId!;
}

export type PlatformFirmRow = {
  id: string;
  name: string;
  slug: string;
  clerkOrgId: string;
  createdAt: Date;
  deletedAt: Date | null;
  memberCount: number;
  storageBytes: number;
  billableInputTokens: number;
  limits: QuotaLimits;
  entitlement: Entitlement;
  complimentary: boolean;
  operatorSuspended: boolean;
  operatorSuspendedReason: string | null;
  subscriptionStatus: string | null;
  seats: number;
};

export async function listPlatformFirms(actorUserId: string): Promise<PlatformFirmRow[]> {
  requireOperator(actorUserId);
  const now = new Date();
  const periodStart = utcMonthStart(now);
  return withServiceContext(async (tx) => {
    const rows = await tx
      .select({
        tenant: tenants,
        billing: tenantBilling,
        usageInputTokens: tenantUsageMonthly.inputTokens,
        usageCacheCreation: tenantUsageMonthly.cacheCreationInputTokens,
        memberCount: sql<number>`(select count(*) from ${memberships} as m where m.tenant_id = ${tenants.id})`,
        storageBytes: sql<number>`(select coalesce(sum(d.size_bytes), 0) from ${documents} as d where d.tenant_id = ${tenants.id})`,
      })
      .from(tenants)
      .leftJoin(tenantBilling, eq(tenantBilling.tenantId, tenants.id))
      .leftJoin(
        tenantUsageMonthly,
        sql`${tenantUsageMonthly.tenantId} = ${tenants.id} and ${tenantUsageMonthly.periodStart} = ${periodStart}`
      )
      .orderBy(desc(tenants.createdAt));

    return rows.flatMap((row) => {
      if (!row.billing) return [];
      const entitlement = computeEntitlement(row.billing, now);
      const memberCount = Math.max(1, Number(row.memberCount ?? 0));
      return [
        {
          id: row.tenant.id,
          name: row.tenant.name,
          slug: row.tenant.slug,
          clerkOrgId: row.tenant.clerkOrgId,
          createdAt: row.tenant.createdAt,
          deletedAt: row.tenant.deletedAt,
          memberCount: Number(row.memberCount ?? 0),
          storageBytes: Number(row.storageBytes ?? 0),
          billableInputTokens: billableInputTokens({
            inputTokens: Number(row.usageInputTokens ?? 0),
            cacheCreationInputTokens: Number(row.usageCacheCreation ?? 0),
          }),
          limits: quotaLimitsFor(entitlement, memberCount),
          entitlement,
          complimentary: row.billing.complimentary,
          operatorSuspended: row.billing.operatorSuspended,
          operatorSuspendedReason: row.billing.operatorSuspendedReason,
          subscriptionStatus: row.billing.subscriptionStatus,
          seats: row.billing.seats,
        },
      ];
    });
  });
}

export async function setFirmSuspended(params: {
  actorUserId: string;
  tenantId: string;
  suspended: boolean;
  reason?: string | null;
}): Promise<void> {
  requireOperator(params.actorUserId);
  await withServiceContext((tx) =>
    setOperatorSuspended(tx, {
      tenantId: params.tenantId,
      suspended: params.suspended,
      actorUserId: params.actorUserId,
      reason: params.reason,
    })
  );
}
