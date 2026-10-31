import "server-only";
import { cache } from "react";
import { withTenantContext, type TenantTransactionRunner } from "@/db/client";
import type { tenantBilling } from "@/db/schema";
import { DAY_MS, daysUntil, pastDueGraceDays } from "./config";
// store.ts imports computeEntitlement from here; both modules only use the other inside functions.
import { ensureTenantBilling } from "./store";

// What a firm may do right now, derived from its tenant_billing row
// (README "Trial, billing and emails"). The rules, in order:
//
// 0. A complimentary firm (the operator's own, npm run billing:comp) is
//    entitled whatever else the row says.
// 1. A live Stripe subscription wins: active, or trialing (the firm
//    subscribed during its free month and Stripe's trial ends when the
//    month does), with no unpaid invoice outstanding.
// 2. A failed payment (past_due_since set, or Stripe reporting past_due)
//    keeps full access for PAST_DUE_GRACE_DAYS with a warning; after that
//    the firm is locked (grace_ended).
// 3. Otherwise the free month: trialing until trial_ends_at. A firm whose
//    creator had already used a free month has none (trial_ends_at null).
// 4. Otherwise locked: the trial ended without a subscription, there never
//    was one (no_trial), or the subscription was canceled, went unpaid, or
//    was paused.
//
// Computed on every read (nothing is cached across requests; getEntitlement
// memoizes within one request through React's cache), so a webhook that
// lands between two requests takes effect at once. The web app's layout
// (src/app/AppShell.tsx), every Server Action under src/app/(app) (through
// getCurrentEntitledTenant in src/lib/tenant.ts), the worker's claim of a
// queued run, and the connector (src/services/connector/) all read it.

export type EntitlementState = "trialing" | "active" | "past_due" | "locked";

export type EntitlementReason =
  | "trial"
  | "complimentary"
  | "subscription_active"
  | "subscription_trialing"
  | "payment_failed"
  | "trial_ended"
  | "no_trial"
  | "subscription_canceled"
  | "subscription_unpaid"
  | "subscription_paused"
  | "grace_ended";

export type Entitlement = {
  state: EntitlementState;
  reason: EntitlementReason;
  /** When the free month ends or ended; null for a firm that got none (its creator had used one). */
  trialEndsAt: Date | null;
  /** When the grace period after a failed payment ends (state past_due, or locked for grace_ended); null otherwise. */
  graceEndsAt: Date | null;
  /** The Stripe subscription as last reported, or null before any was made. */
  subscription: {
    id: string | null;
    status: string | null;
    seats: number;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  lockedAt: Date | null;
  /** Whole days left in the free month while trialing (rounded up); 0 otherwise. */
  trialDaysLeft: number;
  /** The operator's own firm: entitled without a subscription, no billing emails. */
  complimentary: boolean;
};

type BillingRow = typeof tenantBilling.$inferSelect;

const LIVE_STATUSES = new Set(["active", "trialing"]);

/** The rules above, as a pure function of the row and the clock (the check script runs it directly). */
export function computeEntitlement(row: BillingRow, now: Date, graceDays: number = pastDueGraceDays()): Entitlement {
  const subscription = row.subscriptionStatus
    ? {
        id: row.stripeSubscriptionId,
        status: row.subscriptionStatus,
        seats: row.seats,
        currentPeriodEnd: row.currentPeriodEnd,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      }
    : null;
  const base = {
    trialEndsAt: row.trialEndsAt,
    graceEndsAt: null as Date | null,
    subscription,
    lockedAt: row.lockedAt,
    trialDaysLeft: 0,
    complimentary: row.complimentary,
  };
  const status = row.subscriptionStatus;

  if (row.complimentary) return { ...base, state: "active", reason: "complimentary" };

  // A payment that failed and was not made good: grace, then locked.
  const paymentFailed = status === "past_due" || (row.pastDueSince !== null && status !== null && LIVE_STATUSES.has(status));
  if (paymentFailed) {
    const graceEndsAt = new Date((row.pastDueSince ?? now).getTime() + graceDays * DAY_MS);
    if (now < graceEndsAt) return { ...base, state: "past_due", reason: "payment_failed", graceEndsAt };
    return { ...base, state: "locked", reason: "grace_ended", graceEndsAt };
  }

  if (status && LIVE_STATUSES.has(status)) {
    return { ...base, state: "active", reason: status === "trialing" ? "subscription_trialing" : "subscription_active" };
  }

  if (row.trialEndsAt && now < row.trialEndsAt) {
    return { ...base, state: "trialing", reason: "trial", trialDaysLeft: daysUntil(row.trialEndsAt, now) };
  }

  const reason: EntitlementReason =
    status === "canceled" || status === "incomplete_expired"
      ? "subscription_canceled"
      : status === "unpaid"
        ? "subscription_unpaid"
        : status === "paused"
          ? "subscription_paused"
          : row.trialEndsAt === null
            ? "no_trial"
            : "trial_ended";
  return { ...base, state: "locked", reason };
}

/**
 * The firm's entitlement now, read in its own tenant transaction (the row
 * is created if it is missing). getEntitlement is the per-request memoized
 * form for pages and actions.
 */
export async function readEntitlement(
  tenantId: string,
  inTenant: TenantTransactionRunner = withTenantContext,
  now = new Date()
): Promise<Entitlement> {
  const row = await inTenant(tenantId, (tx) => ensureTenantBilling(tx, tenantId, now));
  return computeEntitlement(row, now);
}

/** readEntitlement, memoized per request (React cache): pages, layouts and actions in one request share one read. */
export const getEntitlement = cache((tenantId: string): Promise<Entitlement> => readEntitlement(tenantId));

/** Thrown by requireEntitled; its message is safe to show to the user. */
export class EntitlementLockedError extends Error {
  constructor(
    readonly entitlement: Entitlement,
    message: string
  ) {
    super(message);
    this.name = "EntitlementLockedError";
  }
}

/** A sentence saying why the firm is locked, for the lock screen, action refusals and the connector. */
export function lockedReasonText(entitlement: Entitlement): string {
  switch (entitlement.reason) {
    case "trial_ended":
      return "the firm's free month has ended and it has no subscription";
    case "no_trial":
      return "the firm has no free month (its creator already used one with another firm) and no subscription yet";
    case "subscription_canceled":
      return "the firm's subscription was canceled";
    case "subscription_unpaid":
      return "the firm's subscription is unpaid";
    case "subscription_paused":
      return "the firm's subscription is paused";
    case "grace_ended":
      return "a payment failed and the grace period has ended";
    default:
      return "the firm's subscription is not active";
  }
}

/**
 * Refuses work while the firm is locked: anything that changes the firm's
 * data, costs the platform something (a skill run, an upload, an import) or
 * discloses data (a download URL). Server Actions reach it through
 * getCurrentEntitledTenant (src/lib/tenant.ts); `action` completes
 * "... cannot <action> ...".
 */
export async function requireEntitled(tenantId: string, action: string): Promise<Entitlement> {
  const entitlement = await getEntitlement(tenantId);
  if (entitlement.state === "locked") {
    throw new EntitlementLockedError(
      entitlement,
      `MeritDesk.AI cannot ${action} right now: ${lockedReasonText(entitlement)}. The firm's owner can subscribe on the Billing page.`
    );
  }
  return entitlement;
}
