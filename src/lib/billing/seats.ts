import "server-only";
import { eq } from "drizzle-orm";
import { withServiceContext } from "@/db/client";
import { tenantBilling } from "@/db/schema";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { isLiveSubscriptionStatus } from "./config";
import { countMembers, ensureTenantBilling, lockTenantBilling } from "./store";
import { getStripe, isStripeConfigured } from "./stripe";

// Seats follow members. The Clerk org-sync webhook calls syncSeats after
// every membership change, the Stripe webhook after a subscription event
// whose quantity differs from the member count, and the daily job for every
// subscribed firm (after reconciling memberships with Clerk), so a missed
// webhook delivery is made good within a day. While a subscription is live,
// its one item's quantity is set to the member count (Stripe prorates the
// difference on the next invoice, its default); the stored seats are
// updated with it. The Stripe call happens between two short transactions,
// never inside one.

export type SeatSyncResult = { seats: number; changed: boolean; reason: "synced" | "no_subscription" | "stripe_not_configured" | "replaced" };

/**
 * Sets the subscription's quantity to the firm's member count when they
 * differ. Service context: the webhooks have no tenant session. Throws when
 * Stripe refuses; callers log and move on (the next change or the daily job
 * tries again).
 */
export async function syncSeats(tenantId: string, actorUserId: string, now = new Date()): Promise<SeatSyncResult> {
  type Plan = { done: SeatSyncResult } | { done?: undefined; seats: number; subscriptionId: string; itemId: string; storedSeats: number };
  const plan = await withServiceContext<Plan>(async (tx) => {
    const row = await ensureTenantBilling(tx, tenantId, now);
    const seats = Math.max(1, await countMembers(tx, tenantId));
    if (!row.stripeSubscriptionId || !row.stripeSubscriptionItemId || !isLiveSubscriptionStatus(row.subscriptionStatus)) {
      return { done: { seats, changed: false, reason: "no_subscription" } };
    }
    if (row.seats === seats) return { done: { seats, changed: false, reason: "synced" } };
    return { seats, subscriptionId: row.stripeSubscriptionId, itemId: row.stripeSubscriptionItemId, storedSeats: row.seats };
  });
  if (plan.done) return plan.done;
  if (!isStripeConfigured()) {
    console.warn(`[billing] tenant ${tenantId} has ${plan.seats} member(s) but ${plan.storedSeats} seat(s); STRIPE_SECRET_KEY is not set, so Stripe was not updated`);
    return { seats: plan.seats, changed: false, reason: "stripe_not_configured" };
  }

  await getStripe().subscriptions.update(plan.subscriptionId, {
    items: [{ id: plan.itemId, quantity: plan.seats }],
    proration_behavior: "create_prorations",
  });

  return withServiceContext(async (tx) => {
    const row = await lockTenantBilling(tx, tenantId);
    if (!row || row.stripeSubscriptionId !== plan.subscriptionId) {
      // The subscription changed while Stripe was being called; the webhook carries the new one's quantity.
      return { seats: plan.seats, changed: false, reason: "replaced" };
    }
    await tx.update(tenantBilling).set({ seats: plan.seats, updatedAt: now }).where(eq(tenantBilling.tenantId, tenantId));
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId,
      action: AUDIT_ACTIONS.billingSubscriptionUpdated,
      resourceType: "billing",
      resourceId: plan.subscriptionId,
      before: { seats: row.seats },
      after: { seats: plan.seats, event: "seats_synced" },
    });
    return { seats: plan.seats, changed: true, reason: "synced" };
  });
}

/** syncSeats for callers that must not fail on a Stripe error (the webhooks): logs instead. */
export async function syncSeatsQuietly(tenantId: string, actorUserId: string): Promise<void> {
  try {
    const result = await syncSeats(tenantId, actorUserId);
    if (result.changed) console.log(`[billing] tenant ${tenantId}: subscription set to ${result.seats} seat(s)`);
  } catch (err) {
    console.error(`[billing] seats for tenant ${tenantId} could not be synced with Stripe: ${describeErrorForLog(err)}`);
  }
}
