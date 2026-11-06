import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { withTenantContext } from "@/db/client";
import { tenantBilling } from "@/db/schema";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { DAY_MS, SEAT_PRICE_CENTS, appOrigin, isOpenSubscriptionStatus } from "./config";
import { computeEntitlement, type Entitlement } from "./entitlement";
import { BillingRequestError } from "./errors";
import { ensurePortalConfiguration } from "./portal";
import { countMembers, ensureTenantBilling, lockTenantBilling, readTenantBilling } from "./store";
import { getStripe, isStripeConfigured, stripePriceId } from "./stripe";
import { readUsageSnapshot, type UsageSnapshot } from "./usage";

// The Billing page's reads and the two things an owner/admin does there
// (README "Trial, billing and emails"): subscribe through Stripe Checkout,
// and manage the subscription (card, invoices, cancellation) in Stripe's
// Customer Portal. Payment never happens inside Claude: the connector only
// points here. Every change Stripe makes comes back through the webhook.
// Stripe is called between short transactions, never inside one.

export { BillingRequestError } from "./errors";

/** Stripe needs a Checkout trial end at least 48 hours out; an hour's margin covers clock drift. */
const CHECKOUT_TRIAL_MIN_MS = 49 * 60 * 60 * 1000;

export type BillingOverview = {
  entitlement: Entitlement;
  /** The firm's members now: what a subscription bills for. */
  memberCount: number;
  seatPriceCents: number;
  monthlyCents: number;
  stripeConfigured: boolean;
  /** A Stripe customer exists, so the Customer Portal can open. */
  hasCustomer: boolean;
  /** No subscription exists in Stripe (none, or a canceled one) and the firm is not complimentary: Subscribe is the thing to do. */
  canSubscribe: boolean;
  /** Subscribe charges the card at once: the firm has no free month left (or never had one). */
  chargesNow: boolean;
  usage: UsageSnapshot;
};

export async function getBillingOverview(tenantId: string): Promise<BillingOverview> {
  const now = new Date();
  return withTenantContext(tenantId, async (tx) => {
    const row = await ensureTenantBilling(tx, tenantId, now);
    const memberCount = Math.max(1, await countMembers(tx, tenantId));
    const entitlement = computeEntitlement(row, now);
    const usage = await readUsageSnapshot(tx, tenantId, entitlement, now);
    return {
      entitlement,
      memberCount,
      seatPriceCents: SEAT_PRICE_CENTS,
      monthlyCents: SEAT_PRICE_CENTS * memberCount,
      stripeConfigured: isStripeConfigured(),
      hasCustomer: row.stripeCustomerId !== null,
      canSubscribe: !row.complimentary && !row.operatorSuspended && !isOpenSubscriptionStatus(row.subscriptionStatus),
      chargesNow: row.trialEndsAt === null || row.trialEndsAt.getTime() - now.getTime() <= CHECKOUT_TRIAL_MIN_MS,
      usage,
    };
  });
}

/**
 * Starts Stripe Checkout for the firm: a subscription to the per-user Price
 * with one seat per member, on a Stripe customer created for the tenant the
 * first time and reused after. While the free month still has more than
 * two days to run, the subscription's trial ends when the free month does,
 * so the first charge is then; closer to the end (Stripe needs a trial end
 * at least 48 hours out), or for a firm with no free month, the card is
 * charged at once. Refused while the firm has any subscription that is not
 * canceled (the portal is where that one is changed). The Checkout Session
 * the firm opened before and did not finish is expired first, so two open
 * Checkout pages can never both end in a subscription. Returns the hosted
 * page's URL; the webhook records the result.
 */
export async function startCheckout(params: {
  tenantId: string;
  tenantName: string;
  actorUserId: string;
  /** The app's origin for Stripe's return links (https://app.example.com). */
  origin: string;
}): Promise<{ url: string }> {
  if (!isStripeConfigured()) throw new BillingRequestError("not_configured");
  const stripe = getStripe();
  const now = new Date();
  const { tenantId } = params;

  // 1. The row, locked while it is read: what Checkout needs, and the refusals.
  const state = await withTenantContext(tenantId, async (tx) => {
    await ensureTenantBilling(tx, tenantId, now);
    const row = (await lockTenantBilling(tx, tenantId))!;
    if (row.complimentary) throw new BillingRequestError("complimentary");
    if (row.operatorSuspended) throw new BillingRequestError("suspended");
    if (isOpenSubscriptionStatus(row.subscriptionStatus)) throw new BillingRequestError("already_subscribed");
    return {
      customerId: row.stripeCustomerId,
      openSessionId: row.checkoutSessionId,
      trialEndsAt: row.trialEndsAt,
      status: row.subscriptionStatus,
      seats: Math.max(1, await countMembers(tx, tenantId)),
    };
  });

  // 2. Stripe, outside any transaction: the customer (created once per
  //    tenant; a concurrent request that also created one loses, and its
  //    customer is left unused), the open session expired, the new session.
  let customerId = state.customerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ name: params.tenantName, metadata: { tenant_id: tenantId } });
    customerId = await withTenantContext(tenantId, async (tx) => {
      const [claimed] = await tx
        .update(tenantBilling)
        .set({ stripeCustomerId: customer.id, updatedAt: now })
        .where(and(eq(tenantBilling.tenantId, tenantId), isNull(tenantBilling.stripeCustomerId)))
        .returning({ id: tenantBilling.stripeCustomerId });
      if (claimed?.id) return claimed.id;
      const stored = (await readTenantBilling(tx, tenantId))?.stripeCustomerId;
      console.warn(`[billing] tenant ${tenantId}: two Checkout requests created Stripe customers at once; ${customer.id} is unused`);
      if (!stored) throw new Error("the Stripe customer could not be recorded");
      return stored;
    });
  }
  if (state.openSessionId) await expireCheckoutSession(state.openSessionId);

  const deferFirstCharge = state.trialEndsAt !== null && state.trialEndsAt.getTime() - now.getTime() > CHECKOUT_TRIAL_MIN_MS;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: stripePriceId(), quantity: state.seats }],
    success_url: `${params.origin}/billing?checkout=success`,
    cancel_url: `${params.origin}/billing?checkout=canceled`,
    // The one thing the webhook reads to find the firm (client_reference_id is not set or read).
    metadata: { tenant_id: tenantId },
    subscription_data: {
      metadata: { tenant_id: tenantId },
      ...(deferFirstCharge && state.trialEndsAt ? { trial_end: Math.floor(state.trialEndsAt.getTime() / 1000) } : {}),
    },
    // A card is taken even when the first charge is deferred to the free month's end.
    payment_method_collection: "always",
  });
  if (!session.url) throw new Error("Stripe returned a Checkout Session without a URL");

  // 3. The open session, remembered so the next Subscribe click expires it, and the audit entry.
  await withTenantContext(tenantId, async (tx) => {
    await tx.update(tenantBilling).set({ checkoutSessionId: session.id, updatedAt: now }).where(eq(tenantBilling.tenantId, tenantId));
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId: params.actorUserId,
      action: AUDIT_ACTIONS.billingCheckoutStarted,
      resourceType: "billing",
      resourceId: session.id,
      after: {
        seats: state.seats,
        firstChargeDeferredTo: deferFirstCharge && state.trialEndsAt ? state.trialEndsAt.toISOString() : null,
        previousSubscriptionStatus: state.status,
        expiredSessionId: state.openSessionId,
      },
    });
  });
  return { url: session.url };
}

/** Expires the firm's earlier Checkout Session; one already completed or expired makes Stripe answer with an error, which is fine. */
async function expireCheckoutSession(sessionId: string): Promise<void> {
  try {
    await getStripe().checkout.sessions.expire(sessionId);
  } catch (err) {
    console.log(`[billing] earlier Checkout Session ${sessionId} was not expired (already finished or expired): ${describeErrorForLog(err)}`);
  }
}

/** Opens Stripe's Customer Portal for the firm's customer (card, invoices, cancellation), with the app's own portal configuration; returns its URL. */
export async function openBillingPortal(params: { tenantId: string; actorUserId: string; origin: string }): Promise<{ url: string }> {
  if (!isStripeConfigured()) throw new BillingRequestError("not_configured");
  const customerId = await withTenantContext(params.tenantId, async (tx) => (await ensureTenantBilling(tx, params.tenantId)).stripeCustomerId);
  if (!customerId) throw new BillingRequestError("no_customer");
  let url: string;
  try {
    const stripe = getStripe();
    const configuration = await ensurePortalConfiguration(stripe, appOrigin() ?? params.origin);
    const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${params.origin}/billing`, configuration });
    url = session.url;
  } catch (err) {
    console.error(`[billing] the Customer Portal session could not be created: ${describeErrorForLog(err)}`);
    throw new BillingRequestError("portal_unavailable");
  }
  await withTenantContext(params.tenantId, (tx) =>
    recordAuditEvent(tx, {
      tenantId: params.tenantId,
      actorUserId: params.actorUserId,
      action: AUDIT_ACTIONS.billingPortalOpened,
      resourceType: "billing",
      resourceId: params.tenantId,
    })
  );
  return { url };
}

/** Whether a date is within the trial's last days, for the banner (shared with the daily job's reminders). */
export function withinDays(date: Date, now: Date, days: number): boolean {
  const ms = date.getTime() - now.getTime();
  return ms > 0 && ms <= days * DAY_MS;
}
