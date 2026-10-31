import "server-only";
import type Stripe from "stripe";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { withServiceContext, type db } from "@/db/client";
import { stripeWebhookEvents, tenantBilling, tenants } from "@/db/schema";
import { AUDIT_ACTIONS, SYSTEM_ACTORS, recordAuditEvent } from "@/lib/audit/service";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { enqueueBillingEmail, type BillingEmailJobData } from "@/services/queue/billing-jobs";
import { DAY_MS, WEBHOOK_CLAIM_RECLAIM_MINUTES, billingUrl, pastDueGraceDays } from "./config";
import { syncSeatsQuietly } from "./seats";
import { lockTenantBilling, reconcileLock, type BillingRow } from "./store";
import { getStripe, stripePriceIdOrNull, stripeWebhookSecret } from "./stripe";
import { applySubscription, findBillingRowForSubscription, type SubscriptionFollowUp } from "./subscription-sync";

// The Stripe webhook (src/app/api/webhooks/stripe/route.ts): the one way
// Stripe's side of billing reaches tenant_billing. In order:
//
// 1. The raw body is verified against the Stripe-Signature header with the
//    endpoint's secret (STRIPE_WEBHOOK_SECRET); anything else is 400.
// 2. The objects the event is about are retrieved from Stripe (the
//    subscription, the invoice and its subscription), outside any database
//    transaction. The payload only says which objects; what is applied is
//    always Stripe's current state, so the order events arrive in does not
//    matter (Stripe does not guarantee it).
// 3. One service-context transaction claims the event id in
//    stripe_webhook_events, locks the firm's tenant_billing row FOR UPDATE,
//    applies the event, queues the emails it calls for (pg-boss writes the
//    jobs in the same transaction) and marks the claim applied. It commits
//    as a whole or not at all: a failure anywhere answers 500 before
//    anything is committed, so Stripe retries. An id already claimed is
//    answered 200 and not applied again, unless its claim is older than
//    WEBHOOK_CLAIM_RECLAIM_MINUTES and never applied (the request died).
// 4. After the commit, what the change calls for in Stripe: a superseded
//    subscription is canceled with proration, a seat count is set. Each is
//    audited in its own transaction; a failure is logged, and the daily job
//    (src/lib/billing/daily.ts) reconciles.
//
// Events handled: checkout.session.completed, customer.subscription.created,
// customer.subscription.updated, customer.subscription.deleted, invoice.paid,
// invoice.payment_failed. Everything the handler needs is injected
// (StripeWebhookDeps) so the check script can run it against PGlite with
// constructed, signed events and a map of Stripe objects.

export type StripeWebhookDeps = {
  /** stripe.webhooks.constructEvent bound to the endpoint secret; throws on a bad signature. */
  constructEvent: (payload: string, signature: string) => Stripe.Event;
  retrieveSubscription: (id: string) => Promise<Stripe.Subscription>;
  retrieveInvoice: (id: string) => Promise<Stripe.Invoice>;
  /** Cancels a subscription at once, prorated (a final invoice credits the unused time). */
  cancelSubscription: (id: string) => Promise<void>;
  /** Sets a firm's subscription quantity to its member count (src/lib/billing/seats.ts); never throws. */
  syncSeats: (tenantId: string) => Promise<void>;
  runService: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
  /** Queues one email in the given transaction (pg-boss's db option), so the job commits with the change. */
  enqueueEmail: (tx: typeof db, data: BillingEmailJobData) => Promise<unknown>;
  /** STRIPE_PRICE_ID; subscriptions on any other Price are ignored. */
  priceId: string | null;
  now?: () => Date;
};

/** The real dependencies, or null while STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY is not set. */
export function defaultStripeWebhookDeps(): StripeWebhookDeps | null {
  const secret = stripeWebhookSecret();
  if (!secret || !process.env.STRIPE_SECRET_KEY?.trim()) return null;
  const stripe = getStripe();
  return {
    constructEvent: (payload, signature) => stripe.webhooks.constructEvent(payload, signature, secret),
    retrieveSubscription: (id) => stripe.subscriptions.retrieve(id),
    retrieveInvoice: (id) => stripe.invoices.retrieve(id),
    cancelSubscription: async (id) => {
      await stripe.subscriptions.cancel(id, { prorate: true, invoice_now: true });
    },
    syncSeats: (tenantId) => syncSeatsQuietly(tenantId, SYSTEM_ACTORS.stripeWebhook),
    runService: withServiceContext,
    enqueueEmail: (tx, data) => enqueueBillingEmail(data, { tx }),
    priceId: stripePriceIdOrNull(),
  };
}

export async function handleStripeWebhook(request: Request, deps: StripeWebhookDeps): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing Stripe-Signature header", { status: 400 });
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = deps.constructEvent(payload, signature);
  } catch (err) {
    console.error(`[billing] Stripe webhook signature verification failed: ${describeErrorForLog(err)}`);
    return new Response("Invalid signature", { status: 400 });
  }
  const now = deps.now?.() ?? new Date();

  // 2. Stripe's current state of the objects the event names, before any transaction.
  let prepared: PreparedEvent;
  try {
    prepared = await prepareStripeEvent(event, deps);
  } catch (err) {
    console.error(`[billing] Stripe event ${event.id} (${event.type}): the objects it names could not be retrieved: ${describeErrorForLog(err)}`);
    return new Response("Event could not be prepared", { status: 500 });
  }

  // 3. Claim, apply, queue and mark applied, together.
  let outcome: { claimed: false } | { claimed: true; followUps: SubscriptionFollowUp[] };
  try {
    outcome = await deps.runService(async (tx) => {
      if (!(await claimEvent(tx, event, now))) return { claimed: false as const };
      const result = await applyPreparedEvent(tx, prepared, deps, now);
      for (const email of result.emails) await deps.enqueueEmail(tx, email);
      await tx.update(stripeWebhookEvents).set({ appliedAt: now }).where(eq(stripeWebhookEvents.eventId, event.id));
      return { claimed: true as const, followUps: result.followUps };
    });
  } catch (err) {
    console.error(`[billing] Stripe event ${event.id} (${event.type}) could not be applied: ${describeErrorForLog(err)}`);
    return new Response("Event could not be applied", { status: 500 });
  }
  if (!outcome.claimed) return new Response("Already processed", { status: 200 });

  // 4. Stripe, after the commit.
  await runFollowUps(outcome.followUps, deps, now);
  return new Response("ok", { status: 200 });
}

/**
 * Takes the event id: inserts it, or takes over a claim with no applied_at
 * that is older than WEBHOOK_CLAIM_RECLAIM_MINUTES. Returns false when the
 * event was applied already or is being applied by a concurrent request.
 */
async function claimEvent(tx: typeof db, event: Stripe.Event, now: Date): Promise<boolean> {
  const reclaimBefore = new Date(now.getTime() - WEBHOOK_CLAIM_RECLAIM_MINUTES * 60 * 1000);
  const inserted = await tx
    .insert(stripeWebhookEvents)
    .values({ eventId: event.id, eventType: event.type, receivedAt: now })
    .onConflictDoUpdate({
      target: stripeWebhookEvents.eventId,
      set: { receivedAt: now },
      setWhere: and(isNull(stripeWebhookEvents.appliedAt), lt(stripeWebhookEvents.receivedAt, reclaimBefore)),
    })
    .returning({ eventId: stripeWebhookEvents.eventId });
  return inserted.length > 0;
}

function stripeId(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

async function firmName(tx: typeof db, tenantId: string): Promise<string> {
  const [row] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return row?.name ?? "Your firm";
}

/** The firm an invoice belongs to, by its subscription or its customer, locked FOR UPDATE. */
async function lockBillingRowForInvoice(tx: typeof db, invoice: Stripe.Invoice): Promise<BillingRow | null> {
  const subscriptionId = stripeId(invoice.parent?.subscription_details?.subscription);
  const customerId = stripeId(invoice.customer);
  const conditions = [
    ...(subscriptionId ? [eq(tenantBilling.stripeSubscriptionId, subscriptionId)] : []),
    ...(customerId ? [eq(tenantBilling.stripeCustomerId, customerId)] : []),
  ];
  if (conditions.length === 0) return null;
  const [row] = await tx.select().from(tenantBilling).where(or(...conditions)).limit(1).for("update");
  return row ?? null;
}

/** An event with the Stripe objects it names retrieved; applyPreparedEvent reads only these, never the payload's copies. */
type PreparedEvent =
  | { kind: "ignored"; type: string; detail: string }
  | { kind: "checkout"; type: string; session: Stripe.Checkout.Session; tenantId: string; subscription: Stripe.Subscription | null }
  | { kind: "subscription"; type: string; subscription: Stripe.Subscription }
  | { kind: "invoice"; type: "invoice.paid" | "invoice.payment_failed"; invoice: Stripe.Invoice; subscription: Stripe.Subscription | null };

/** Retrieves from Stripe what the event is about. Exported for the check script. */
export async function prepareStripeEvent(event: Stripe.Event, deps: StripeWebhookDeps): Promise<PreparedEvent> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode !== "subscription") return { kind: "ignored", type: event.type, detail: `Checkout Session ${session.id} is not a subscription` };
      // Only the metadata the app set on the session names the firm; client_reference_id is not read.
      const tenantId = session.metadata?.tenant_id;
      if (!tenantId) return { kind: "ignored", type: event.type, detail: `Checkout Session ${session.id} names no tenant` };
      const subscriptionId = stripeId(session.subscription);
      const subscription = subscriptionId ? await deps.retrieveSubscription(subscriptionId) : null;
      return { kind: "checkout", type: event.type, session, tenantId, subscription };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return { kind: "subscription", type: event.type, subscription: await deps.retrieveSubscription(event.data.object.id) };
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = await deps.retrieveInvoice(event.data.object.id);
      const subscriptionId = stripeId(invoice.parent?.subscription_details?.subscription);
      const subscription = subscriptionId ? await deps.retrieveSubscription(subscriptionId) : null;
      return { kind: "invoice", type: event.type, invoice, subscription };
    }
    default:
      return { kind: "ignored", type: event.type, detail: "not handled" };
  }
}

type AppliedEvent = { emails: BillingEmailJobData[]; followUps: SubscriptionFollowUp[] };

const NOTHING: AppliedEvent = { emails: [], followUps: [] };

/** Applies a prepared event inside the caller's transaction (the row is locked here). Exported for the check script. */
export async function applyPreparedEvent(tx: typeof db, prepared: PreparedEvent, deps: StripeWebhookDeps, now: Date): Promise<AppliedEvent> {
  const actor = SYSTEM_ACTORS.stripeWebhook;
  const context = (source: string, name: string) => ({ source, actorUserId: actor, firmName: name, expectedPriceId: deps.priceId, now });

  switch (prepared.kind) {
    case "ignored":
      console.log(`[billing] Stripe event ${prepared.type} ignored: ${prepared.detail}`);
      return NOTHING;

    case "checkout": {
      const { session, tenantId, subscription } = prepared;
      const row = await lockTenantBilling(tx, tenantId);
      if (!row) {
        console.warn(`[billing] checkout.session.completed ${session.id} is for unknown tenant ${tenantId}; ignored`);
        return NOTHING;
      }
      const customerId = stripeId(session.customer);
      if (!row.stripeCustomerId || customerId !== row.stripeCustomerId) {
        console.warn(`[billing] checkout.session.completed ${session.id}: its customer ${customerId ?? "(none)"} is not tenant ${tenantId}'s ${row.stripeCustomerId ?? "(none)"}; ignored`);
        return NOTHING;
      }
      let current = row;
      if (row.checkoutSessionId === session.id) {
        [current] = await tx.update(tenantBilling).set({ checkoutSessionId: null, updatedAt: now }).where(eq(tenantBilling.tenantId, tenantId)).returning();
      }
      if (!subscription) return NOTHING;
      const result = await applySubscription(tx, current, subscription, context(prepared.type, await firmName(tx, tenantId)));
      return { emails: result.emails, followUps: result.followUps };
    }

    case "subscription": {
      const { subscription } = prepared;
      const row = await findBillingRowForSubscription(tx, subscription);
      if (!row) {
        console.warn(`[billing] ${prepared.type} for subscription ${subscription.id} matches no firm; ignored`);
        return NOTHING;
      }
      const result = await applySubscription(tx, row, subscription, context(prepared.type, await firmName(tx, row.tenantId)));
      return { emails: result.emails, followUps: result.followUps };
    }

    case "invoice": {
      const { invoice, subscription } = prepared;
      const row = await lockBillingRowForInvoice(tx, invoice);
      if (!row) {
        console.warn(`[billing] ${prepared.type} ${invoice.id} matches no firm; ignored`);
        return NOTHING;
      }
      const name = await firmName(tx, row.tenantId);
      // The subscription's current state first: paid up, past due, canceled, as Stripe has it now.
      let current = row;
      const applied: AppliedEvent = { emails: [], followUps: [] };
      if (subscription) {
        const result = await applySubscription(tx, row, subscription, context(prepared.type, name));
        current = result.row;
        applied.emails.push(...result.emails);
        applied.followUps.push(...result.followUps);
      }
      if (prepared.type === "invoice.paid") {
        if (invoice.status !== "paid") {
          console.warn(`[billing] invoice.paid ${invoice.id}: Stripe now reports the invoice ${invoice.status ?? "(no status)"}; nothing recorded`);
          return applied;
        }
        const line = invoice.lines?.data?.[0];
        const periodStart = line?.period?.start ?? invoice.period_start;
        const periodEnd = line?.period?.end ?? invoice.period_end;
        await recordAuditEvent(tx, {
          tenantId: row.tenantId,
          actorUserId: actor,
          action: AUDIT_ACTIONS.billingInvoicePaid,
          resourceType: "billing",
          resourceId: invoice.id,
          after: {
            amountCents: invoice.amount_paid,
            currency: invoice.currency,
            periodStart: periodStart ? new Date(periodStart * 1000).toISOString() : null,
            periodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
            seats: line?.quantity ?? null,
            subscriptionId: subscription?.id ?? null,
            invoiceNumber: invoice.number ?? null,
          },
        });
        await reconcileLock(tx, current, actor, now);
        if (invoice.amount_paid <= 0 || current.complimentary) return applied;
        applied.emails.push({
          tenantId: row.tenantId,
          kind: "payment_receipt",
          dedupeKey: invoice.id,
          params: {
            firmName: name,
            amountCents: invoice.amount_paid,
            currency: invoice.currency,
            periodStart: periodStart ? new Date(periodStart * 1000).toISOString() : null,
            periodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
            seats: line?.quantity ?? null,
            invoiceNumber: invoice.number ?? null,
            invoiceUrl: invoice.hosted_invoice_url ?? null,
            billingUrl: billingUrl(),
          },
        });
        return applied;
      }

      // invoice.payment_failed
      if (invoice.status === "paid" || invoice.status === "void") {
        console.warn(`[billing] invoice.payment_failed ${invoice.id}: Stripe now reports the invoice ${invoice.status}; the failure is over`);
        return applied;
      }
      if (subscription && current.stripeSubscriptionId !== subscription.id) {
        console.warn(`[billing] invoice.payment_failed ${invoice.id}: its subscription ${subscription.id} is not the firm's ${current.stripeSubscriptionId}; ignored`);
        return applied;
      }
      const pastDueSince = current.pastDueSince ?? now;
      const graceEndsAt = new Date(pastDueSince.getTime() + pastDueGraceDays() * DAY_MS);
      if (current.pastDueSince === null) {
        [current] = await tx.update(tenantBilling).set({ pastDueSince, updatedAt: now }).where(eq(tenantBilling.tenantId, row.tenantId)).returning();
      }
      await recordAuditEvent(tx, {
        tenantId: row.tenantId,
        actorUserId: actor,
        action: AUDIT_ACTIONS.billingPaymentFailed,
        resourceType: "billing",
        resourceId: current.stripeSubscriptionId ?? invoice.id,
        after: { invoiceId: invoice.id, graceEndsAt: graceEndsAt.toISOString(), attempt: invoice.attempt_count },
      });
      await reconcileLock(tx, current, actor, now);
      if (current.complimentary) return applied;
      applied.emails.push({
        tenantId: row.tenantId,
        kind: "payment_failed",
        dedupeKey: invoice.id,
        params: {
          firmName: name,
          graceEndsAt: graceEndsAt.toISOString(),
          amountCents: invoice.amount_due ?? null,
          invoiceUrl: invoice.hosted_invoice_url ?? null,
          billingUrl: billingUrl(),
        },
      });
      return applied;
    }
  }
}

/** What the committed change calls for in Stripe; each failure is logged and left to the daily job. Exported for the check script. */
export async function runFollowUps(followUps: SubscriptionFollowUp[], deps: StripeWebhookDeps, now: Date): Promise<void> {
  for (const followUp of followUps) {
    if (followUp.kind === "sync_seats") {
      await deps.syncSeats(followUp.tenantId);
      continue;
    }
    try {
      await deps.cancelSubscription(followUp.subscriptionId);
    } catch (err) {
      console.error(`[billing] superseded subscription ${followUp.subscriptionId} of tenant ${followUp.tenantId} could not be canceled: ${describeErrorForLog(err)}`);
      continue;
    }
    await deps
      .runService((tx) =>
        recordAuditEvent(tx, {
          tenantId: followUp.tenantId,
          actorUserId: SYSTEM_ACTORS.stripeWebhook,
          action: AUDIT_ACTIONS.billingSubscriptionCanceled,
          resourceType: "billing",
          resourceId: followUp.subscriptionId,
          after: { reason: "superseded", replacedBy: followUp.replacedBy, canceledAt: now.toISOString() },
        })
      )
      .catch((err) => console.error(`[billing] the cancellation of ${followUp.subscriptionId} could not be audited: ${describeErrorForLog(err)}`));
    console.log(`[billing] canceled superseded subscription ${followUp.subscriptionId} of tenant ${followUp.tenantId} (replaced by ${followUp.replacedBy})`);
  }
}
