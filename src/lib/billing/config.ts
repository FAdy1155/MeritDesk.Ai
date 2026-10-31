// What billing is made of, read from the environment on every call so a
// restart with new settings is enough: the free month's length, the grace
// period after a failed payment, and the app's public address for the links
// in emails and in the connector's refusals. Kept free of server imports so
// the worker, the connector and the check script read the same values.

export const PRODUCT_NAME = "MeritDesk.AI";

/**
 * The per-user monthly price, for display (the Billing page, the landing
 * page, emails). What Stripe charges is the Price behind STRIPE_PRICE_ID,
 * which npm run stripe:setup creates at this amount.
 */
export const SEAT_PRICE_CENTS = 2000;

export const DEFAULT_TRIAL_DAYS = 30;
export const DEFAULT_PAST_DUE_GRACE_DAYS = 7;

/** The trial's last days: the banner shows, and the first reminder goes out. */
export const TRIAL_WARNING_DAYS = 7;
/** How far ahead of a renewal the upcoming-renewal email goes out. */
export const RENEWAL_NOTICE_DAYS = 7;
/** How far ahead of a scheduled cancellation the renew reminder goes out. */
export const CANCEL_REMINDER_DAYS = 3;
/** After a subscription lapses: a reminder on lock day, then this many days apart, at most LAPSED_REMINDER_COUNT. */
export const LAPSED_REMINDER_INTERVAL_DAYS = 7;
export const LAPSED_REMINDER_COUNT = 3;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stripe subscription statuses under which the firm is paying, or about to:
 * these win over a stored, ended subscription, and a subscription in one of
 * them is what "the firm has a subscription" means.
 */
export const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);
/** Statuses with no unpaid invoice outstanding. */
export const PAID_UP_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);
/** Statuses a subscription never leaves: Stripe's own terminal states. A later event claiming otherwise for the same id is stale. */
export const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

export function isLiveSubscriptionStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && LIVE_SUBSCRIPTION_STATUSES.has(status);
}

/** A subscription that still exists in Stripe (not canceled or expired): Checkout is refused while the firm has one. */
export function isOpenSubscriptionStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && !TERMINAL_SUBSCRIPTION_STATUSES.has(status);
}

/** How many times one user may call the create-firm action in a rolling day (src/lib/tenants/create-firm.ts). */
export const FIRM_CREATION_DAILY_LIMIT = 3;
/** A Stripe event claimed this long ago and not applied belonged to a request that died; the next delivery takes it over. */
export const WEBHOOK_CLAIM_RECLAIM_MINUTES = 10;
/** stripe_webhook_events (and firm_creation_attempts) rows older than this are pruned by the daily job. */
export const WEBHOOK_EVENT_RETENTION_DAYS = 7;

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(`[billing] ${name}="${raw}" is not a whole number from ${min} to ${max}; using ${fallback}`);
    return fallback;
  }
  return value;
}

/** Days in the free month (TRIAL_DAYS, default 30). */
export function trialDays(): number {
  return intEnv("TRIAL_DAYS", DEFAULT_TRIAL_DAYS, 1, 365);
}

/** Days of full access after a failed payment before the firm is locked (PAST_DUE_GRACE_DAYS, default 7). */
export function pastDueGraceDays(): number {
  return intEnv("PAST_DUE_GRACE_DAYS", DEFAULT_PAST_DUE_GRACE_DAYS, 0, 90);
}

/**
 * The app's public origin (CONNECTOR_PUBLIC_ORIGIN, no path), or null when
 * it is not set or not an http(s) URL. Emails and the connector's refusals
 * link to <origin>/billing and <origin>/connect; without it they name the
 * page instead of linking to it.
 */
export function appOrigin(): string | null {
  const configured = process.env.CONNECTOR_PUBLIC_ORIGIN?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** <origin>/billing, where a firm subscribes and manages its billing; null without a public origin. */
export function billingUrl(origin: string | null = appOrigin()): string | null {
  return origin ? `${origin}/billing` : null;
}

/** <origin>/connect, the page that explains how to add the connector to Claude; null without a public origin. */
export function connectUrl(origin: string | null = appOrigin()): string | null {
  return origin ? `${origin}/connect` : null;
}

/** "$20.00", "$40.00": US dollars from cents (the one currency the Price is in). */
export function formatUsd(cents: number): string {
  const dollars = Math.floor(Math.abs(cents) / 100);
  const rest = Math.abs(cents) % 100;
  return `${cents < 0 ? "-" : ""}$${dollars.toLocaleString("en-US")}.${String(rest).padStart(2, "0")}`;
}

/** "November 29, 2026" (UTC), for emails and the connector. */
export function formatDay(date: Date): string {
  return date.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
}

/** Whole days from now until `date`, rounded up; 0 when it has passed. */
export function daysUntil(date: Date, now: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / DAY_MS));
}
