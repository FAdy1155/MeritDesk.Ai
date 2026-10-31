import "server-only";
import { count, eq } from "drizzle-orm";
import type { db } from "@/db/client";
import { memberships, tenantBilling, tenants, userTrials } from "@/db/schema";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";
import { DAY_MS, trialDays } from "./config";
import { computeEntitlement, type Entitlement } from "./entitlement";

// Reads and writes of tenant_billing (migrations 0014 and 0015) inside a
// caller's transaction: a withTenantContext transaction for that tenant in
// the app, a service-context one in the webhooks, the daily job and the
// create-firm action, a PGlite one in the check script.

export type BillingRow = typeof tenantBilling.$inferSelect;

export async function readTenantBilling(tx: typeof db, tenantId: string): Promise<BillingRow | null> {
  const [row] = await tx.select().from(tenantBilling).where(eq(tenantBilling.tenantId, tenantId)).limit(1);
  return row ?? null;
}

/** The row, locked for the rest of the transaction (SELECT ... FOR UPDATE): every writer of the row starts here. */
export async function lockTenantBilling(tx: typeof db, tenantId: string): Promise<BillingRow | null> {
  const [row] = await tx.select().from(tenantBilling).where(eq(tenantBilling.tenantId, tenantId)).limit(1).for("update");
  return row ?? null;
}

export type StartBillingResult = { row: BillingRow; created: boolean; trialGranted: boolean };

/**
 * Creates the firm's billing row, with or without the free month. The free
 * month is granted once per person: the creator's row in user_trials is
 * inserted here (ON CONFLICT DO NOTHING, so two firms created at once by the
 * same user race on one primary key and exactly one wins), and a creator
 * who already has one gets a firm with trial_ends_at null, locked from the
 * start (billing.no_trial); the Billing page then says the free month was
 * already used and Subscribe charges now. A firm with no known creator (made
 * in the Clerk dashboard) gets the free month: there is nobody to pin it on.
 * Both paths that create tenants (the create-firm action and the org-sync
 * webhook) get here through upsertTenantFromOrganization, and both are
 * idempotent: an existing row is returned as it is.
 */
export async function startBilling(
  tx: typeof db,
  params: {
    tenantId: string;
    creatorUserId: string | null;
    actorUserId: string;
    now?: Date;
    /**
     * The fallback's mode (ensureTenantBilling): user_trials is a
     * service-only table, unreadable from a tenant transaction, so a firm
     * with a known creator is assumed to have had its month and gets none;
     * only a firm with no known creator gets one.
     */
    withoutUserTrials?: boolean;
  }
): Promise<StartBillingResult> {
  const now = params.now ?? new Date();
  const existing = await readTenantBilling(tx, params.tenantId);
  if (existing) return { row: existing, created: false, trialGranted: existing.trialEndsAt !== null };

  let trialGranted = true;
  let earlierTenantId: string | null = null;
  if (params.creatorUserId && params.withoutUserTrials) {
    trialGranted = false;
  } else if (params.creatorUserId) {
    const [won] = await tx
      .insert(userTrials)
      .values({ clerkUserId: params.creatorUserId, tenantId: params.tenantId, startedAt: now })
      .onConflictDoNothing({ target: userTrials.clerkUserId })
      .returning({ clerkUserId: userTrials.clerkUserId });
    if (!won) {
      trialGranted = false;
      const [earlier] = await tx.select({ tenantId: userTrials.tenantId }).from(userTrials).where(eq(userTrials.clerkUserId, params.creatorUserId)).limit(1);
      earlierTenantId = earlier?.tenantId ?? null;
    }
  }

  const trialEndsAt = trialGranted ? new Date(now.getTime() + trialDays() * DAY_MS) : null;
  const [inserted] = await tx
    .insert(tenantBilling)
    .values({ tenantId: params.tenantId, trialEndsAt, lockedAt: trialGranted ? null : now, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: tenantBilling.tenantId })
    .returning();
  if (!inserted) {
    // Lost a race on the billing row itself: the other writer's row stands.
    const row = (await readTenantBilling(tx, params.tenantId))!;
    return { row, created: false, trialGranted: row.trialEndsAt !== null };
  }
  await recordAuditEvent(tx, {
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: trialGranted ? AUDIT_ACTIONS.billingTrialStarted : AUDIT_ACTIONS.billingNoTrial,
    resourceType: "billing",
    resourceId: params.tenantId,
    after: trialGranted
      ? { trialEndsAt: trialEndsAt!.toISOString(), creatorUserId: params.creatorUserId }
      : { creatorUserId: params.creatorUserId, earlierTenantId },
  });
  if (!trialGranted) {
    await recordAuditEvent(tx, {
      tenantId: params.tenantId,
      actorUserId: params.actorUserId,
      action: AUDIT_ACTIONS.billingLocked,
      resourceType: "billing",
      resourceId: params.tenantId,
      after: { reason: "no_trial", subscriptionStatus: null },
    });
  }
  return { row: inserted, created: true, trialGranted };
}

/**
 * The row, created if it is somehow missing (every tenant gets one at
 * creation, and migration 0014 backfilled the rest; this is reached only
 * when a row was removed by hand). The fallback runs in whatever
 * transaction the reader has, usually a tenant one that cannot read
 * user_trials, so it is conservative: a firm with a known creator gets no
 * free month from it (the operator can grant complimentary access, or the
 * firm subscribes); a firm with no known creator gets one. A missing row
 * never hands out a second free month.
 */
export async function ensureTenantBilling(tx: typeof db, tenantId: string, now = new Date()): Promise<BillingRow> {
  const existing = await readTenantBilling(tx, tenantId);
  if (existing) return existing;
  console.warn(`[billing] tenant ${tenantId} had no billing row; creating it now`);
  const [tenant] = await tx.select({ createdByUserId: tenants.createdByUserId }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const { row } = await startBilling(tx, {
    tenantId,
    creatorUserId: tenant?.createdByUserId ?? null,
    actorUserId: "system:billing",
    now,
    withoutUserTrials: true,
  });
  return row;
}

/** How many members the firm has (every role): the seats it is billed for. */
export async function countMembers(tx: typeof db, tenantId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(memberships).where(eq(memberships.tenantId, tenantId));
  return Number(row?.n ?? 0);
}

/**
 * Keeps locked_at in step with the entitlement the row now yields: sets it
 * (and records billing.locked with the reason) when the firm has just
 * become locked, clears it (billing.unlocked) when it is no longer. Returns
 * the row as it is now and its entitlement.
 */
export async function reconcileLock(
  tx: typeof db,
  row: BillingRow,
  actorUserId: string,
  now = new Date()
): Promise<{ row: BillingRow; entitlement: Entitlement }> {
  const entitlement = computeEntitlement(row, now);
  const locked = entitlement.state === "locked";
  if (locked === (row.lockedAt !== null)) return { row, entitlement };
  const [updated] = await tx
    .update(tenantBilling)
    .set({ lockedAt: locked ? now : null, updatedAt: now })
    .where(eq(tenantBilling.tenantId, row.tenantId))
    .returning();
  await recordAuditEvent(tx, {
    tenantId: row.tenantId,
    actorUserId,
    action: locked ? AUDIT_ACTIONS.billingLocked : AUDIT_ACTIONS.billingUnlocked,
    resourceType: "billing",
    resourceId: row.tenantId,
    after: { reason: entitlement.reason, subscriptionStatus: row.subscriptionStatus },
  });
  return { row: updated, entitlement: computeEntitlement(updated, now) };
}
