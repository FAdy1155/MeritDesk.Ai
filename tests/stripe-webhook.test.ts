import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type Stripe from "stripe";
import { sql } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { db as appDb } from "@/db/client";
import type { BillingEmailJobData } from "@/services/queue/billing-jobs";

const TENANT = "90000000-0000-4000-8000-000000000001";
const CUSTOMER = "cus_test_meritdesk";
const SUBSCRIPTION = "sub_test_meritdesk";
const NOW = new Date("2026-11-05T12:00:00.000Z");

const pg = new PGlite({ extensions: { pg_trgm } });
const db = drizzle(pg, { schema });
let handleStripeWebhook: typeof import("@/lib/billing/stripe-webhook").handleStripeWebhook;
let syncSeats: typeof import("@/lib/billing/seats").syncSeats;

type WebhookEvent = Stripe.Event;
type WebhookDeps = import("@/lib/billing/stripe-webhook").StripeWebhookDeps;

test.before(async () => {
  await migrate(db, { migrationsFolder: path.resolve("src/db/migrations") });
  await pg.exec(`
    CREATE ROLE app_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
    GRANT USAGE ON SCHEMA public TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
    INSERT INTO tenants (id, name, slug, clerk_org_id) VALUES
      ('${TENANT}', 'Billing Test Firm', 'billing-test', 'org_billing_test');
    INSERT INTO memberships (tenant_id, user_id, role) VALUES
      ('${TENANT}', 'user_billing_test', 'owner_admin');
    INSERT INTO tenant_billing (tenant_id, trial_ends_at, stripe_customer_id, created_at, updated_at)
      VALUES ('${TENANT}', '2027-01-01T00:00:00Z', '${CUSTOMER}', '${NOW.toISOString()}', '${NOW.toISOString()}');
  `);
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
  process.env.QUEUE_DATABASE_URL = process.env.DATABASE_URL;
  ({ handleStripeWebhook } = await import("@/lib/billing/stripe-webhook"));
  ({ syncSeats } = await import("@/lib/billing/seats"));
});

test.after(async () => {
  await pg.close();
});

function event(id: string, type: string): WebhookEvent {
  return {
    id,
    object: "event",
    api_version: "2025-09-30.clover",
    created: Math.floor(NOW.getTime() / 1000),
    data: { object: { id: SUBSCRIPTION, object: "subscription" } },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  } as unknown as WebhookEvent;
}

function subscription(status: Stripe.Subscription.Status): Stripe.Subscription {
  return {
    id: SUBSCRIPTION,
    object: "subscription",
    customer: CUSTOMER,
    status,
    metadata: { tenant_id: TENANT },
    created: Math.floor(new Date("2026-10-01T00:00:00.000Z").getTime() / 1000),
    cancel_at_period_end: false,
    trial_end: null,
    items: {
      object: "list",
      data: [{ id: "si_test_meritdesk", object: "subscription_item", price: { id: "price_test_meritdesk" }, quantity: 1, current_period_end: 1_798_761_600 }],
      has_more: false,
      url: "/v1/subscription_items",
    },
  } as unknown as Stripe.Subscription;
}

function depsFor(input: {
  event: WebhookEvent;
  status?: Stripe.Subscription.Status;
  failEmail?: boolean;
  rejectSignature?: boolean;
  emails?: BillingEmailJobData[];
}): WebhookDeps {
  const emails = input.emails ?? [];
  return {
    constructEvent: () => {
      if (input.rejectSignature) throw new Error("signature mismatch");
      return input.event;
    },
    retrieveSubscription: async () => subscription(input.status ?? "active"),
    retrieveInvoice: async () => { throw new Error("unexpected invoice retrieval"); },
    cancelSubscription: async () => undefined,
    syncSeats: async () => undefined,
    runService: async <T>(fn: (tx: typeof appDb) => Promise<T>) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_runtime`);
        await tx.execute(sql`SET LOCAL app.is_service_role = 'true'`);
        return fn(tx as unknown as typeof appDb);
      }),
    enqueueEmail: async (_tx, data) => {
      if (input.failEmail) throw new Error("queue unavailable");
      emails.push(data);
    },
    priceId: "price_test_meritdesk",
    now: () => NOW,
  };
}

function request(): Request {
  return new Request("https://meritdesk.test/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "signed-test-payload" },
    body: "synthetic payload",
  });
}

test("Stripe webhook applies one subscription event once across duplicate delivery", async () => {
  const emails: BillingEmailJobData[] = [];
  const evt = event("evt_billing_once", "customer.subscription.updated");
  const deps = depsFor({ event: evt, emails });

  const first = await handleStripeWebhook(request(), deps);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "ok");

  const duplicate = await handleStripeWebhook(request(), deps);
  assert.equal(duplicate.status, 200);
  assert.equal(await duplicate.text(), "Already processed");

  const billing = await pg.query<{ stripe_subscription_id: string; subscription_status: string }>(
    "SELECT stripe_subscription_id, subscription_status FROM tenant_billing WHERE tenant_id = $1",
    [TENANT]
  );
  assert.deepEqual(billing.rows, [{ stripe_subscription_id: SUBSCRIPTION, subscription_status: "active" }]);
  const events = await pg.query<{ count: number; applied: number }>(
    "SELECT count(*)::int AS count, count(applied_at)::int AS applied FROM stripe_webhook_events WHERE event_id = $1",
    [evt.id]
  );
  assert.deepEqual(events.rows, [{ count: 1, applied: 1 }]);
  assert.equal(emails.length, 1);
});

test("a stale active event cannot revive a canceled Stripe subscription", async () => {
  const canceled = await handleStripeWebhook(
    request(),
    depsFor({ event: event("evt_billing_canceled", "customer.subscription.updated"), status: "canceled" })
  );
  assert.equal(canceled.status, 200);

  const staleActive = await handleStripeWebhook(
    request(),
    depsFor({ event: event("evt_billing_stale_active", "customer.subscription.updated"), status: "active" })
  );
  assert.equal(staleActive.status, 200);

  const billing = await pg.query<{ subscription_status: string }>(
    "SELECT subscription_status FROM tenant_billing WHERE tenant_id = $1",
    [TENANT]
  );
  assert.deepEqual(billing.rows, [{ subscription_status: "canceled" }]);
});

test("invalid signatures and transaction-side email failures leave billing unchanged", async () => {
  await pg.exec(`
    UPDATE tenant_billing
       SET stripe_subscription_id = NULL, stripe_subscription_item_id = NULL,
           subscription_created_at = NULL, subscription_status = NULL,
           current_period_end = NULL, cancel_at_period_end = FALSE, past_due_since = NULL
     WHERE tenant_id = '${TENANT}';
  `);
  const auditBefore = await pg.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM audit_logs WHERE tenant_id = $1 AND action = 'billing.subscription_updated'",
    [TENANT]
  );
  const badSignature = await handleStripeWebhook(
    request(),
    depsFor({ event: event("evt_invalid_sig", "customer.subscription.updated"), rejectSignature: true })
  );
  assert.equal(badSignature.status, 400);

  const failed = await handleStripeWebhook(
    request(),
    depsFor({ event: event("evt_billing_rollback", "customer.subscription.updated"), failEmail: true })
  );
  assert.equal(failed.status, 500);

  const billing = await pg.query<{ stripe_subscription_id: string | null; subscription_status: string | null }>(
    "SELECT stripe_subscription_id, subscription_status FROM tenant_billing WHERE tenant_id = $1",
    [TENANT]
  );
  assert.deepEqual(billing.rows, [{ stripe_subscription_id: null, subscription_status: null }]);
  const events = await pg.query<{ count: number }>("SELECT count(*)::int AS count FROM stripe_webhook_events WHERE event_id = $1", ["evt_billing_rollback"]);
  assert.deepEqual(events.rows, [{ count: 0 }]);
  const audit = await pg.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM audit_logs WHERE tenant_id = $1 AND action = 'billing.subscription_updated'",
    [TENANT]
  );
  assert.deepEqual(audit.rows, auditBefore.rows);
});

test("seat synchronization updates Stripe quantity and records the firm member count", async () => {
  await pg.exec(`
    INSERT INTO memberships (tenant_id, user_id, role)
    VALUES ('${TENANT}', 'user_billing_second', 'paralegal');
    UPDATE tenant_billing
       SET stripe_subscription_id = '${SUBSCRIPTION}',
           stripe_subscription_item_id = 'si_test_meritdesk',
           subscription_status = 'active', seats = 1
     WHERE tenant_id = '${TENANT}';
  `);
  const updates: Array<{ subscriptionId: string; itemId: string; seats: number }> = [];
  const auditBefore = await pg.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM audit_logs WHERE tenant_id = $1 AND action = 'billing.subscription_updated'",
    [TENANT]
  );
  const result = await syncSeats(TENANT, "user_billing_test", NOW, {
    runService: async <T>(fn: (tx: typeof appDb) => Promise<T>) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_runtime`);
        await tx.execute(sql`SET LOCAL app.is_service_role = 'true'`);
        return fn(tx as unknown as typeof appDb);
      }),
    stripeConfigured: () => true,
    updateSubscription: async (input) => { updates.push(input); },
  });

  assert.deepEqual(result, { seats: 2, changed: true, reason: "synced" });
  assert.deepEqual(updates, [{ subscriptionId: SUBSCRIPTION, itemId: "si_test_meritdesk", seats: 2 }]);
  const billing = await pg.query<{ seats: number }>("SELECT seats FROM tenant_billing WHERE tenant_id = $1", [TENANT]);
  assert.deepEqual(billing.rows, [{ seats: 2 }]);
  const audit = await pg.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM audit_logs WHERE tenant_id = $1 AND action = 'billing.subscription_updated'",
    [TENANT]
  );
  assert.deepEqual(audit.rows, [{ count: auditBefore.rows[0]!.count + 1 }]);
});
