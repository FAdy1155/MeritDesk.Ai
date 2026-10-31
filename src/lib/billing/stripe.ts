import "server-only";
import Stripe from "stripe";

// The Stripe client, made on first use from STRIPE_SECRET_KEY. Nothing here
// runs at build time or at startup: a deployment without Stripe (a
// development machine) still serves every page, and the Billing page says
// billing is not configured.

/** Thrown where a Stripe call was about to be made without the settings for it; the message is safe to show. */
export class BillingNotConfiguredError extends Error {
  constructor(message = "Billing is not configured on this server (STRIPE_SECRET_KEY and STRIPE_PRICE_ID). Ask the platform's operator.") {
    super(message);
    this.name = "BillingNotConfiguredError";
  }
}

let client: Stripe | null = null;
let clientKey = "";

/** Whether the app can start Checkout and read subscriptions: the secret key and the Price are set. */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim() && process.env.STRIPE_PRICE_ID?.trim());
}

/**
 * The client, at the SDK's pinned API version (the version its types
 * describe). One instance per key; a key change in the environment (a
 * restart with new secrets) makes a new one.
 */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new BillingNotConfiguredError();
  if (!client || clientKey !== key) {
    client = new Stripe(key, { typescript: true, maxNetworkRetries: 2 });
    clientKey = key;
  }
  return client;
}

/** The per-user monthly Price (STRIPE_PRICE_ID, from npm run stripe:setup). */
export function stripePriceId(): string {
  const id = process.env.STRIPE_PRICE_ID?.trim();
  if (!id) throw new BillingNotConfiguredError();
  return id;
}

/** STRIPE_PRICE_ID, or null when unset: the webhook and the daily job ignore subscriptions on any other Price. */
export function stripePriceIdOrNull(): string | null {
  return process.env.STRIPE_PRICE_ID?.trim() || null;
}

/** The webhook endpoint's signing secret (STRIPE_WEBHOOK_SECRET), or null when unset. */
export function stripeWebhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;
}
