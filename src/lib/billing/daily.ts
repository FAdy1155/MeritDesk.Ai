import "server-only";
import type Stripe from "stripe";
import { isNull, lt } from "drizzle-orm";
import { withServiceContext, type db } from "@/db/client";
import { firmCreationAttempts, stripeWebhookEvents, tenants } from "@/db/schema";
import { AUDIT_ACTIONS, SYSTEM_ACTORS, recordAuditEvent } from "@/lib/audit/service";
import { sentEmailKeys, sentKey } from "@/lib/email/send-log";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { listOrganizationMembers, type ClerkOrgMember } from "@/lib/tenants/clerk-members";
import { replaceMemberships } from "@/lib/tenants/provision";
import { enqueueBillingEmail, type BillingEmailJobData } from "@/services/queue/billing-jobs";
import {
  CANCEL_REMINDER_DAYS,
  DAY_MS,
  LAPSED_REMINDER_COUNT,
  LAPSED_REMINDER_INTERVAL_DAYS,
  RENEWAL_NOTICE_DAYS,
  TRIAL_WARNING_DAYS,
  WEBHOOK_EVENT_RETENTION_DAYS,
  billingUrl,
  isLiveSubscriptionStatus,
  isOpenSubscriptionStatus,
} from "./config";
import type { Entitlement } from "./entitlement";
import { syncSeats } from "./seats";
import { ensureTenantBilling, lockTenantBilling, reconcileLock, type BillingRow } from "./store";
import { getStripe, isStripeConfigured, stripePriceIdOrNull } from "./stripe";
import { applySubscription } from "./subscription-sync";

// The daily billing job (src/services/queue/billing-worker.ts, once a day):
// for every firm whose organization still exists, in service context, it
//
// 1. refreshes a subscribed firm's subscription from Stripe (the webhook
//    is the normal path; this makes good a delivery that never arrived),
//    and looks at every subscription Stripe holds for the firm's customer:
//    the newest live one is the firm's, any other open one is canceled
//    with proration (one firm, one subscription), and a live one the app
//    did not know of is adopted,
// 2. reconciles the firm's memberships with Clerk's membership list (rows
//    added and removed; an Admin's row owner_admin, a Member's row keeping
//    the app role the firm gave them), so seats and recipients follow the
//    real members even when a Clerk webhook was missed,
// 3. records the lock when a free month or subscription has ended
//    (billing.locked) and the unlock when it is over,
// 4. queues the reminders that are due today: the trial's last week and
//    last day, the trial's end, an upcoming renewal, a scheduled
//    cancellation, and a lapsed subscription (on lock day, then weekly, at
//    most three), each once per tenant and occasion (email_sends), written
//    in the transaction that chose them, and
// 5. sets the subscription's seats to the member count when they differ.
//
// Then it prunes stripe_webhook_events and firm_creation_attempts older
// than WEBHOOK_EVENT_RETENTION_DAYS. A complimentary firm gets no emails.
//
// Which reminders are due is a pure function of the row, the entitlement,
// what was sent and the clock (dueBillingEmails), so the check script
// exercises it directly.

export type DueEmail = Pick<BillingEmailJobData, "kind" | "dedupeKey"> & { sequence?: number };

/**
 * The reminders a firm is due now. Within a kind only the most urgent
 * occasion counts: a firm whose last-day reminder is due gets that one,
 * not the last-week one as well; a lapsed firm 20 days into its lock gets
 * the third reminder, not the earlier ones it missed. A firm that never
 * had a free month (no_trial) and never subscribed is not reminded: there
 * is nothing to remind it of.
 */
export function dueBillingEmails(input: { row: BillingRow; entitlement: Entitlement; sent: Set<string>; now: Date }): DueEmail[] {
  const { row, entitlement, sent, now } = input;
  const due: DueEmail[] = [];
  if (row.complimentary) return due;
  const unsent = (kind: DueEmail["kind"], dedupeKey: string): boolean => !sent.has(sentKey(kind, dedupeKey));
  const trialKey = row.trialEndsAt?.toISOString() ?? null;

  if (entitlement.state === "trialing" && row.trialEndsAt && trialKey) {
    const msLeft = row.trialEndsAt.getTime() - now.getTime();
    if (msLeft <= DAY_MS) {
      if (unsent("trial_reminder_1d", trialKey)) due.push({ kind: "trial_reminder_1d", dedupeKey: trialKey });
    } else if (msLeft <= TRIAL_WARNING_DAYS * DAY_MS) {
      if (unsent("trial_reminder_7d", trialKey)) due.push({ kind: "trial_reminder_7d", dedupeKey: trialKey });
    }
  }

  if (entitlement.state === "locked" && entitlement.reason === "trial_ended" && trialKey && unsent("trial_ended", trialKey)) {
    due.push({ kind: "trial_ended", dedupeKey: trialKey });
  }

  const periodEnd = entitlement.subscription?.currentPeriodEnd ?? null;
  if (entitlement.state === "active" && entitlement.subscription && periodEnd) {
    const periodKey = periodEnd.toISOString();
    const msToEnd = periodEnd.getTime() - now.getTime();
    if (entitlement.subscription.cancelAtPeriodEnd) {
      if (msToEnd > 0 && msToEnd <= CANCEL_REMINDER_DAYS * DAY_MS && unsent("cancel_reminder", periodKey)) {
        due.push({ kind: "cancel_reminder", dedupeKey: periodKey });
      }
    } else if (msToEnd > 0 && msToEnd <= RENEWAL_NOTICE_DAYS * DAY_MS && unsent("renewal_upcoming", periodKey)) {
      due.push({ kind: "renewal_upcoming", dedupeKey: periodKey });
    }
  }

  const lapsed =
    entitlement.state === "locked" && entitlement.reason !== "trial_ended" && entitlement.reason !== "no_trial" && row.lockedAt !== null;
  if (lapsed && row.lockedAt) {
    const daysLocked = Math.floor((now.getTime() - row.lockedAt.getTime()) / DAY_MS);
    if (daysLocked >= 0) {
      const sequence = Math.min(LAPSED_REMINDER_COUNT, 1 + Math.floor(daysLocked / LAPSED_REMINDER_INTERVAL_DAYS));
      const key = `${row.lockedAt.toISOString()}#${sequence}`;
      if (unsent("lapsed_reminder", key)) due.push({ kind: "lapsed_reminder", dedupeKey: key, sequence });
    }
  }
  return due;
}

/** The job data for a due reminder: the template's params from the firm's row. */
export function reminderJob(tenantId: string, firmName: string, row: BillingRow, due: DueEmail): BillingEmailJobData {
  const base = { tenantId, kind: due.kind, dedupeKey: due.dedupeKey };
  const links = { billingUrl: billingUrl() };
  const trialEndsAt = () => {
    if (!row.trialEndsAt) throw new Error(`${due.kind} is due for a firm with no free month`);
    return row.trialEndsAt.toISOString();
  };
  switch (due.kind) {
    case "trial_reminder_7d":
    case "trial_reminder_1d":
      return { ...base, kind: due.kind, params: { ...links, firmName, trialEndsAt: trialEndsAt(), seats: row.seats } };
    case "trial_ended":
      return { ...base, kind: due.kind, params: { ...links, firmName, trialEndsAt: trialEndsAt() } };
    case "renewal_upcoming":
      return { ...base, kind: due.kind, params: { ...links, firmName, renewsAt: row.currentPeriodEnd!.toISOString(), seats: row.seats } };
    case "cancel_reminder":
      return { ...base, kind: due.kind, params: { ...links, firmName, endsAt: row.currentPeriodEnd!.toISOString() } };
    case "lapsed_reminder":
      return { ...base, kind: due.kind, params: { ...links, firmName, lockedAt: row.lockedAt!.toISOString(), sequence: due.sequence ?? 1 } };
    default:
      throw new Error(`${due.kind} is not a reminder the daily job sends`);
  }
}

export type DailyBillingSummary = {
  tenants: number;
  locked: number;
  emailsQueued: number;
  seatsChanged: number;
  subscriptionsCanceled: number;
  membershipsChanged: number;
  pruned: number;
  errors: number;
};

export type DailyStripeDeps = {
  /** The subscription as Stripe has it now. */
  refresh: (subscriptionId: string) => Promise<Stripe.Subscription>;
  /** Every subscription of the customer, any status (the job keeps the open ones on the app's Price). */
  listSubscriptions: (customerId: string) => Promise<Stripe.Subscription[]>;
  /** Cancels a subscription at once, prorated. */
  cancel: (subscriptionId: string) => Promise<void>;
  syncSeats: typeof syncSeats;
};

export type DailyClerkDeps = {
  /** The organization's members as Clerk has them (user id and Clerk role are what the job uses), or null when the list could not be read whole. */
  listMembers: (clerkOrgId: string) => Promise<Pick<ClerkOrgMember, "userId" | "clerkRole">[] | null>;
};

type DailyDeps = {
  now?: Date;
  runService?: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
  /** Queues one email in the given transaction, like the webhook's. */
  enqueueEmail?: (tx: typeof db, data: BillingEmailJobData) => Promise<unknown>;
  /** Stripe reads and writes; null skips them (Stripe not configured, or the check script). */
  stripe?: DailyStripeDeps | null;
  /** Clerk's membership lists; null skips the reconciliation (no CLERK_SECRET_KEY, or the check script). */
  clerk?: DailyClerkDeps | null;
  /** STRIPE_PRICE_ID; subscriptions on another Price are not the app's. */
  priceId?: string | null;
};

function defaultStripeDeps(): DailyStripeDeps | null {
  if (!isStripeConfigured()) return null;
  return {
    refresh: (id) => getStripe().subscriptions.retrieve(id),
    listSubscriptions: async (customerId) => {
      const page = await getStripe().subscriptions.list({ customer: customerId, status: "all", limit: 100 });
      return page.data;
    },
    cancel: async (id) => {
      await getStripe().subscriptions.cancel(id, { prorate: true, invoice_now: true });
    },
    syncSeats,
  };
}

function defaultClerkDeps(): DailyClerkDeps | null {
  if (!process.env.CLERK_SECRET_KEY?.trim()) return null;
  return { listMembers: listOrganizationMembers };
}

/** Of the firm's subscriptions in Stripe on the app's Price, the one the firm should have: the newest live one, else the newest open one; null when none is open. */
export function pickCanonicalSubscription(subscriptions: Stripe.Subscription[], priceId: string | null): { keep: Stripe.Subscription | null; others: Stripe.Subscription[] } {
  const open = subscriptions.filter((s) => isOpenSubscriptionStatus(s.status) && (!priceId || s.items.data[0]?.price?.id === priceId));
  if (open.length === 0) return { keep: null, others: [] };
  const newest = (list: Stripe.Subscription[]) => list.reduce((a, b) => (b.created > a.created ? b : a));
  const live = open.filter((s) => isLiveSubscriptionStatus(s.status));
  const keep = newest(live.length > 0 ? live : open);
  return { keep, others: open.filter((s) => s.id !== keep.id) };
}

export async function runBillingDaily(deps: DailyDeps = {}): Promise<DailyBillingSummary> {
  const now = deps.now ?? new Date();
  const runService = deps.runService ?? withServiceContext;
  const enqueueEmail = deps.enqueueEmail ?? ((tx: typeof db, data: BillingEmailJobData) => enqueueBillingEmail(data, { tx }));
  const stripe = deps.stripe !== undefined ? deps.stripe : defaultStripeDeps();
  const clerk = deps.clerk !== undefined ? deps.clerk : defaultClerkDeps();
  const priceId = deps.priceId !== undefined ? deps.priceId : stripePriceIdOrNull();
  const actor = SYSTEM_ACTORS.billingDaily;
  const summary: DailyBillingSummary = { tenants: 0, locked: 0, emailsQueued: 0, seatsChanged: 0, subscriptionsCanceled: 0, membershipsChanged: 0, pruned: 0, errors: 0 };
  const context = (source: string, firmName: string) => ({ source, actorUserId: actor, firmName, expectedPriceId: priceId, now });

  const firms = await runService((tx) =>
    tx.select({ id: tenants.id, name: tenants.name, clerkOrgId: tenants.clerkOrgId }).from(tenants).where(isNull(tenants.deletedAt))
  );
  for (const firm of firms) {
    summary.tenants++;
    try {
      const billing = await runService((tx) => ensureTenantBilling(tx, firm.id, now));

      // 1. The subscription as Stripe has it now, and one subscription only.
      if (stripe && billing.stripeSubscriptionId) {
        try {
          const subscription = await stripe.refresh(billing.stripeSubscriptionId);
          await runService(async (tx) => {
            const row = await lockTenantBilling(tx, firm.id);
            if (row) await applySubscription(tx, row, subscription, context("daily_refresh", firm.name));
          });
        } catch (err) {
          console.error(`[billing] daily: subscription ${billing.stripeSubscriptionId} of tenant ${firm.id} could not be refreshed: ${describeErrorForLog(err)}`);
        }
      }
      if (stripe && billing.stripeCustomerId) {
        try {
          const { keep, others } = pickCanonicalSubscription(await stripe.listSubscriptions(billing.stripeCustomerId), priceId);
          for (const extra of others) {
            await stripe.cancel(extra.id);
            summary.subscriptionsCanceled++;
            await runService((tx) =>
              recordAuditEvent(tx, {
                tenantId: firm.id,
                actorUserId: actor,
                action: AUDIT_ACTIONS.billingSubscriptionCanceled,
                resourceType: "billing",
                resourceId: extra.id,
                after: { reason: "superseded", replacedBy: keep!.id, canceledAt: now.toISOString() },
              })
            );
            console.warn(`[billing] daily: canceled subscription ${extra.id} of tenant ${firm.id}; the firm's subscription is ${keep!.id}`);
          }
          if (keep && keep.id !== billing.stripeSubscriptionId) {
            await runService(async (tx) => {
              const row = await lockTenantBilling(tx, firm.id);
              if (row) await applySubscription(tx, row, keep, context("daily_reconcile", firm.name));
            });
          }
        } catch (err) {
          console.error(`[billing] daily: the subscriptions of tenant ${firm.id} could not be reconciled with Stripe: ${describeErrorForLog(err)}`);
        }
      }

      // 2. Members, as Clerk has them.
      if (clerk) {
        try {
          const members = await clerk.listMembers(firm.clerkOrgId);
          if (members === null) {
            console.warn(`[billing] daily: the members of tenant ${firm.id} could not be read from Clerk; memberships left as they are`);
          } else if (members.length === 0) {
            console.warn(`[billing] daily: Clerk lists no members for tenant ${firm.id}; memberships left as they are`);
          } else {
            const changed = await runService((tx) => replaceMemberships(tx, firm.id, members));
            if (changed > 0) console.log(`[billing] daily: tenant ${firm.id}: ${changed} membership row(s) brought in step with Clerk`);
            summary.membershipsChanged += changed;
          }
        } catch (err) {
          console.error(`[billing] daily: memberships of tenant ${firm.id} could not be reconciled with Clerk: ${describeErrorForLog(err)}`);
        }
      }

      // 3 and 4. The lock, and the reminders due, written together.
      const queued = await runService(async (tx) => {
        const current = (await lockTenantBilling(tx, firm.id)) ?? (await ensureTenantBilling(tx, firm.id, now));
        const { row, entitlement } = await reconcileLock(tx, current, actor, now);
        if (entitlement.state === "locked") summary.locked++;
        const sent = await sentEmailKeys(tx, firm.id);
        const jobs = dueBillingEmails({ row, entitlement, sent, now }).map((due) => reminderJob(firm.id, firm.name, row, due));
        for (const job of jobs) await enqueueEmail(tx, job);
        return jobs.length;
      });
      summary.emailsQueued += queued;

      // 5. Seats.
      if (stripe && billing.stripeSubscriptionId) {
        const result = await stripe.syncSeats(firm.id, actor, now);
        if (result.changed) summary.seatsChanged++;
      }
    } catch (err) {
      summary.errors++;
      console.error(`[billing] daily: tenant ${firm.id} could not be processed: ${describeErrorForLog(err)}`);
    }
  }

  try {
    summary.pruned = await runService((tx) => pruneBillingRows(tx, now));
  } catch (err) {
    summary.errors++;
    console.error(`[billing] daily: old webhook and attempt rows could not be pruned: ${describeErrorForLog(err)}`);
  }
  return summary;
}

/** Deletes stripe_webhook_events and firm_creation_attempts rows older than WEBHOOK_EVENT_RETENTION_DAYS; returns how many. */
export async function pruneBillingRows(tx: typeof db, now: Date): Promise<number> {
  const before = new Date(now.getTime() - WEBHOOK_EVENT_RETENTION_DAYS * DAY_MS);
  const events = await tx.delete(stripeWebhookEvents).where(lt(stripeWebhookEvents.receivedAt, before)).returning({ id: stripeWebhookEvents.eventId });
  const attempts = await tx.delete(firmCreationAttempts).where(lt(firmCreationAttempts.attemptedAt, before)).returning({ id: firmCreationAttempts.id });
  return events.length + attempts.length;
}

