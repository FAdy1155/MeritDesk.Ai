import "../../../load-env";
import Stripe from "stripe";

// npm run stripe:setup: creates the Product "MeritDesk.AI" and its per-user
// monthly Price in the Stripe account STRIPE_SECRET_KEY belongs to (test
// mode with an sk_test_ key, live mode with sk_live_), and prints the price
// id to put in STRIPE_PRICE_ID. Safe to run again: the Price carries a
// lookup key, and an existing one is printed instead of creating another.

const PRODUCT_NAME = "MeritDesk.AI";
const PRODUCT_DESCRIPTION = "Immigration legal work in Claude: matters, documents, skills and the legal library, per user per month.";
const PRICE_LOOKUP_KEY = "meritdesk_ai_user_monthly";
const UNIT_AMOUNT_CENTS = 2000;

async function main() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    console.error("STRIPE_SECRET_KEY is not set. Put the account's secret key in .env.local (sk_test_... for test mode) and run again.");
    process.exit(1);
  }
  const mode = key.startsWith("sk_live_") ? "live" : "test";
  const stripe = new Stripe(key, { typescript: true });

  const existing = await stripe.prices.list({ lookup_keys: [PRICE_LOOKUP_KEY], active: true, limit: 1 });
  const found = existing.data[0];
  if (found) {
    console.log(`The per-user monthly Price already exists in ${mode} mode (product ${typeof found.product === "string" ? found.product : found.product.id}).`);
    console.log(`\nSTRIPE_PRICE_ID=${found.id}\n`);
    return;
  }

  const products = await stripe.products.list({ active: true, limit: 100 });
  let product = products.data.find((p) => p.name === PRODUCT_NAME);
  if (product) {
    console.log(`Using the existing product ${product.id} (${PRODUCT_NAME}).`);
  } else {
    product = await stripe.products.create({ name: PRODUCT_NAME, description: PRODUCT_DESCRIPTION });
    console.log(`Created the product ${product.id} (${PRODUCT_NAME}) in ${mode} mode.`);
  }

  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: UNIT_AMOUNT_CENTS,
    billing_scheme: "per_unit",
    recurring: { interval: "month", usage_type: "licensed" },
    lookup_key: PRICE_LOOKUP_KEY,
    nickname: "Per user, monthly",
  });
  console.log(`Created the price ${price.id}: $${(UNIT_AMOUNT_CENTS / 100).toFixed(2)} per user per month, in ${mode} mode.`);
  console.log(`\nSTRIPE_PRICE_ID=${price.id}\n`);
  console.log("Put it in .env.local for development and in the web app's Fly secrets for production (DEPLOY.md, Billing).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
