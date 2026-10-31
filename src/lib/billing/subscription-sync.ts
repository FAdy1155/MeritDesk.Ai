import "server-only";
import type Stripe from "stripe";
import { eq, or } from "drizzle-orm";
import type { db } from "@/db/client";
import { tenantBilling } from "@/db/schema";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";
import type { BillingEmailJobData } from "@/services/queue/billing-jobs";
import {
  LIVE_SUBSCRIPTION_STATUSES,
  PAID_UP_SUBSCRIPTION_STATUSES,
  TERMINAL_SUBSCRIPTION_STATUSES,
  billingUrl,
  isOpenSubscriptionStatus,
} from "./config";
import { countMembers, reconcileLock, type BillingRow } from "./store";

// Copies what the app needs of a Stripe subscription into tenant_billing:
// from the webhook's customer.subscription.* events, the checkout session's
// and the invoices' subscription (src/lib/billing/stripe-webhook.ts, which
// retrieves each from Stripe and never applies a payload), and from the
// daily job's refresh of every subscribed firm (src/lib/billing/daily.ts).
// Every call runs inside the caller's service-context transaction, with
// the row already locked (lockTenantBilling / findBillingRowForSubscription).
// Stripe is never called from here: what has to happen in Stripe after the
// transaction commits (cancel a superseded subscription, set the seats) is
// returned as follow-ups for the caller.

function stripeId(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

/** The tenant a Stripe subscription belongs to: its metadata first, then the customer or subscription id already stored. Locked FOR UPDATE. */
export async function findBillingRowForSubscription(tx: typeof db, subscription: Stripe.Subscription): Promise<BillingRow | null> {
  const tenantId = subscription.metadata?.tenant_id;
  const customerId = stripeId(subscription.customer);
  const [row] = await tx
    .select()
    .from(tenantBilling)
    .where(
      tenantId
        ? eq(tenantBilling.tenantId, tenantId)
        : or(
            eq(tenantBilling.stripeSubscriptionId, subscription.id),
            ...(customerId ? [eq(tenantBilling.stripeCustomerId, customerId)] : [])
          )
    )
    .limit(1)
    .for("update");
  return row ?? null;
}

/** Something to do in Stripe once the transaction has committed (src/lib/billing/stripe-webhook.ts runs them). */
export type SubscriptionFollowUp =
  /** A newer live subscription replaced this one: cancel it at once, prorated, so the firm is never billed twice. */
  | { kind: "cancel_superseded"; tenantId: string; subscriptionId: string; replacedBy: string }
  /** The subscription's quantity differs from the member count: set it (src/lib/billing/seats.ts). */
  | { kind: "sync_seats"; tenantId: string };

export type SubscriptionIgnoredReason = "foreign_price" | "customer_mismatch" | "terminal_status" | "older_subscription" | "not_live";

export type SubscriptionSyncResult = {
  row: BillingRow;
  applied: boolean;
  /** Why nothing was applied, when the subscription was ignored (logged by the caller too). */
  ignored?: SubscriptionIgnoredReason;
  /** Emails the change calls for (queued by the caller in the same transaction). */
  emails: BillingEmailJobData[];
  followUps: SubscriptionFollowUp[];
};

export type ApplySubscriptionContext = {
  /** The Stripe event type, or "daily_refresh"; recorded on the audit entry. */
  source: string;
  actorUserId: string;
  firmName: string;
  /** STRIPE_PRICE_ID: a subscription on any other Price is not the app's and is ignored. Null skips the check (not configured). */
  expectedPriceId: string | null;
  now?: Date;
};

/**
 * Applies a subscription's current state (as retrieved from Stripe) to the
 * firm's row, records billing.subscription_updated when something changed,
 * and keeps locked_at in step. What is refused, in order:
 *
 * - a subscription whose item is not on STRIPE_PRICE_ID (not the app's);
 * - a subscription of a customer other than the firm's stored customer;
 * - for the stored subscription, a live status after a terminal one
 *   (canceled, incomplete_expired): Stripe never leaves those, so the
 *   event is stale;
 * - a different subscription that is not live, or that is older (Stripe's
 *   `created`) than the stored one: events are not delivered in order, and
 *   an old subscription's last event must not overwrite the new one.
 *
 * A different, newer, live subscription replaces the stored one; when the
 * stored one is still open in Stripe, a follow-up cancels it with proration
 * (one firm, one subscription). When the quantity differs from the member
 * count, a follow-up sets the seats.
 */
export async function applySubscription(
  tx: typeof db,
  row: BillingRow,
  subscription: Stripe.Subscription,
  context: ApplySubscriptionContext
): Promise<SubscriptionSyncResult> {
  const { source, actorUserId, firmName } = context;
  const now = context.now ?? new Date();
  const status = subscription.status;
  const item = subscription.items.data[0];
  const customerId = stripeId(subscription.customer);
  const ignore = (ignored: SubscriptionIgnoredReason, detail: string): SubscriptionSyncResult => {
    console.warn(`[billing] ignoring ${source} for subscription ${subscription.id} (${status}) of tenant ${row.tenantId}: ${detail}`);
    return { row, applied: false, ignored, emails: [], followUps: [] };
  };

  const priceId = item?.price?.id ?? null;
  if (context.expectedPriceId && priceId !== context.expectedPriceId) {
    return ignore("foreign_price", `its price ${priceId ?? "(none)"} is not ${context.expectedPriceId}`);
  }
  if (row.stripeCustomerId && customerId && customerId !== row.stripeCustomerId) {
    return ignore("customer_mismatch", `its customer ${customerId} is not the firm's ${row.stripeCustomerId}`);
  }

  const followUps: SubscriptionFollowUp[] = [];
  if (row.stripeSubscriptionId === subscription.id) {
    if (row.subscriptionStatus && TERMINAL_SUBSCRIPTION_STATUSES.has(row.subscriptionStatus) && !TERMINAL_SUBSCRIPTION_STATUSES.has(status)) {
      return ignore("terminal_status", `the stored status ${row.subscriptionStatus} is final`);
    }
  } else if (row.stripeSubscriptionId) {
    if (!LIVE_SUBSCRIPTION_STATUSES.has(status)) {
      return ignore("not_live", `the firm's subscription is ${row.stripeSubscriptionId}`);
    }
    if (row.subscriptionCreatedAt && subscription.created * 1000 < row.subscriptionCreatedAt.getTime()) {
      return ignore("older_subscription", `it is older than the firm's subscription ${row.stripeSubscriptionId}`);
    }
    if (isOpenSubscriptionStatus(row.subscriptionStatus)) {
      followUps.push({ kind: "cancel_superseded", tenantId: row.tenantId, subscriptionId: row.stripeSubscriptionId, replacedBy: subscription.id });
    }
  }

  const next = {
    stripeCustomerId: row.stripeCustomerId ?? customerId,
    stripeSubscriptionId: subscription.id,
    stripeSubscriptionItemId: item?.id ?? row.stripeSubscriptionItemId,
    subscriptionCreatedAt: new Date(subscription.created * 1000),
    subscriptionStatus: status,
    seats: item?.quantity ?? row.seats,
    currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    // A failed payment is made good when Stripe reports the subscription paid up again.
    pastDueSince: status === "past_due" ? (row.pastDueSince ?? now) : PAID_UP_SUBSCRIPTION_STATUSES.has(status) ? null : row.pastDueSince,
  };

  // Seats follow members: a live subscription billing another count is set right after the commit.
  if (LIVE_SUBSCRIPTION_STATUSES.has(status) && typeof item?.quantity === "number") {
    const members = await countMembers(tx, row.tenantId);
    if (members >= 1 && members !== item.quantity) followUps.push({ kind: "sync_seats", tenantId: row.tenantId });
  }

  const unchanged =
    next.stripeCustomerId === row.stripeCustomerId &&
    next.stripeSubscriptionId === row.stripeSubscriptionId &&
    next.stripeSubscriptionItemId === row.stripeSubscriptionItemId &&
    next.subscriptionCreatedAt.getTime() === (row.subscriptionCreatedAt?.getTime() ?? null) &&
    next.subscriptionStatus === row.subscriptionStatus &&
    next.seats === row.seats &&
    (next.currentPeriodEnd?.getTime() ?? null) === (row.currentPeriodEnd?.getTime() ?? null) &&
    next.cancelAtPeriodEnd === row.cancelAtPeriodEnd &&
    (next.pastDueSince?.getTime() ?? null) === (row.pastDueSince?.getTime() ?? null);
  if (unchanged) {
    const { row: reconciled } = await reconcileLock(tx, row, actorUserId, now);
    return { row: reconciled, applied: false, emails: [], followUps };
  }

  const [updated] = await tx
    .update(tenantBilling)
    .set({ ...next, updatedAt: now })
    .where(eq(tenantBilling.tenantId, row.tenantId))
    .returning();
  await recordAuditEvent(tx, {
    tenantId: row.tenantId,
    actorUserId,
    action: AUDIT_ACTIONS.billingSubscriptionUpdated,
    resourceType: "billing",
    resourceId: subscription.id,
    before: snapshot(row),
    after: { ...snapshot(updated), event: source },
  });
  const { row: reconciled } = await reconcileLock(tx, updated, actorUserId, now);

  const emails: BillingEmailJobData[] = [];
  const wasPaying = row.subscriptionStatus !== null && PAID_UP_SUBSCRIPTION_STATUSES.has(row.subscriptionStatus) && row.stripeSubscriptionId === subscription.id;
  if (PAID_UP_SUBSCRIPTION_STATUSES.has(status) && !wasPaying && !reconciled.complimentary) {
    emails.push({
      tenantId: row.tenantId,
      kind: "subscription_confirmed",
      dedupeKey: subscription.id,
      params: {
        firmName,
        seats: reconciled.seats,
        firstChargeAt: status === "trialing" && subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
        billingUrl: billingUrl(),
      },
    });
  }
  return { row: reconciled, applied: true, emails, followUps };
}

function snapshot(row: BillingRow) {
  return {
    subscriptionId: row.stripeSubscriptionId,
    subscriptionStatus: row.subscriptionStatus,
    seats: row.seats,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    pastDueSince: row.pastDueSince?.toISOString() ?? null,
  };
}
