import { defaultStripeWebhookDeps, handleStripeWebhook } from "@/lib/billing/stripe-webhook";

// Stripe's webhook endpoint (DEPLOY.md, "Billing with Stripe"): subscribed
// to checkout.session.completed, customer.subscription.created, .updated,
// .deleted, invoice.paid and invoice.payment_failed. src/proxy.ts lets it
// through without a session (every /api/webhooks path); the handler
// verifies each request's signature itself, retrieves the objects the event
// names from Stripe and keeps tenant_billing in step
// (src/lib/billing/stripe-webhook.ts).

export async function POST(req: Request) {
  const deps = defaultStripeWebhookDeps();
  if (!deps) {
    console.error("STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY is not set");
    return new Response("Server misconfigured", { status: 500 });
  }
  return handleStripeWebhook(req, deps);
}
