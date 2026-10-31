import "server-only";
import type Stripe from "stripe";
import { PRODUCT_NAME } from "./config";

// Stripe's Customer Portal, configured from code rather than from the
// dashboard: the portal lets a firm update its card, see its invoices and
// cancel at the end of the period, and nothing else. In particular it never
// changes quantities (the app sets seats from the firm's members) or
// switches products. The configuration is found by its metadata, created
// once per Stripe account and brought back to these settings every time a
// process first needs it, so a dashboard edit does not stick; the portal
// session is created with it (src/lib/billing/service.ts), so the
// dashboard's default configuration is never used.

const CONFIGURATION_KEY = "meritdesk_portal";
const CONFIGURATION_VERSION = "1";

let cached: { secretKey: string; id: string } | null = null;

/** The features the portal offers; exported for the check script. */
export function portalFeatures(): Stripe.BillingPortal.ConfigurationCreateParams.Features {
  return {
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ["email", "name", "address", "phone"] },
    subscription_cancel: {
      enabled: true,
      mode: "at_period_end",
      proration_behavior: "none",
      cancellation_reason: { enabled: true, options: ["too_expensive", "missing_features", "switched_service", "unused", "other"] },
    },
    subscription_update: { enabled: false },
    subscription_pause: { enabled: false },
  };
}

function configurationParams(origin: string | null): Stripe.BillingPortal.ConfigurationCreateParams {
  const https = origin?.startsWith("https://") ? origin : null;
  return {
    name: `${PRODUCT_NAME} (managed by the app)`,
    features: portalFeatures(),
    business_profile: {
      headline: `${PRODUCT_NAME}: your card, invoices and subscription`,
      ...(https ? { privacy_policy_url: `${https}/privacy`, terms_of_service_url: `${https}/terms` } : {}),
    },
    metadata: { [CONFIGURATION_KEY]: CONFIGURATION_VERSION },
  };
}

/**
 * The id of the app's portal configuration in the Stripe account the key
 * belongs to, created or brought up to date on first use in this process.
 * `origin` is the app's public https origin for the terms and privacy
 * links; null leaves them out.
 */
export async function ensurePortalConfiguration(stripe: Stripe, origin: string | null): Promise<string> {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (cached && cached.secretKey === secretKey) return cached.id;
  const params = configurationParams(origin);
  const existing = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  const found = existing.data.find((c) => c.metadata?.[CONFIGURATION_KEY] === CONFIGURATION_VERSION);
  const configuration = found
    ? await stripe.billingPortal.configurations.update(found.id, params)
    : await stripe.billingPortal.configurations.create(params);
  cached = { secretKey, id: configuration.id };
  return configuration.id;
}
