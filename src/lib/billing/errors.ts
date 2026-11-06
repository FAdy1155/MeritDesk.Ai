// The refusals the Billing page can show. The page's actions send the
// browser back to /billing?error=<code>; the page maps the code to the fixed
// text below, so nothing from an exception's message is ever rendered
// from the query string. Kept free of server imports so the check script
// and the page share it.

export const BILLING_ERROR_CODES = [
  "not_configured",
  "forbidden",
  "already_subscribed",
  "complimentary",
  "no_customer",
  "portal_unavailable",
  "origin_missing",
  "checkout_failed",
  "suspended",
] as const;

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

const TEXT: Record<BillingErrorCode, string> = {
  not_configured: "Billing is not configured on this server yet (Stripe). Ask the platform's operator.",
  forbidden: "Only the firm's owner can subscribe or change billing. Ask your firm's owner.",
  already_subscribed: "The firm already has a subscription. Use Manage billing to change the card, the plan or the cancellation.",
  complimentary: "This firm has complimentary access and does not subscribe.",
  no_customer: "The firm has no billing account yet. Subscribe first; the portal then shows the card and invoices.",
  portal_unavailable: "Stripe's billing portal could not be opened just now. Try again; if it keeps failing, ask the platform's operator.",
  origin_missing: "The app's public address is not configured, so Stripe cannot send you back here. Ask the platform's operator.",
  checkout_failed: "Stripe Checkout could not be started just now. Try again; if it keeps failing, ask the platform's operator.",
  suspended: "This firm has been suspended by the platform's operator. Subscribing will not restore access until the suspension is cleared.",
};

const GENERIC = "Something went wrong with billing. Try again; if it keeps failing, ask the platform's operator.";

export function isBillingErrorCode(value: unknown): value is BillingErrorCode {
  return typeof value === "string" && (BILLING_ERROR_CODES as readonly string[]).includes(value);
}

/** The fixed sentence for a code from the query string; anything else gets the generic one. */
export function billingErrorText(code: string | undefined): string | null {
  if (code === undefined) return null;
  return isBillingErrorCode(code) ? TEXT[code] : GENERIC;
}

/** A refusal the owner/admin can act on; the action sends its code back to the page, which shows the text above. */
export class BillingRequestError extends Error {
  constructor(readonly code: BillingErrorCode) {
    super(TEXT[code]);
    this.name = "BillingRequestError";
  }
}
