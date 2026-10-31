-- Billing (src/lib/billing/, src/lib/email/, README "Trial, billing and
-- emails"): every firm gets a free month, then pays per member through
-- Stripe.
--
-- tenant_billing: one row per tenant with the free month's end, the Stripe
-- customer and subscription the webhook keeps in step, the billed seats and
-- when the firm was locked. Backfilled below for every existing tenant with
-- a free month from the day this migration runs (the TRIAL_DAYS default).
-- email_sends: every email the app sent a firm, one row per tenant, kind
-- and dedupe key, which is what makes each reminder go out once.
-- stripe_webhook_events: Stripe event ids already taken, so a redelivered
-- event is answered without being applied twice.
--
-- tenant_billing and email_sends are tenant data: the same tenant_isolation
-- policy as every other tenant table, in the nullif form of
-- 0006_rls_tenant_setting.sql. stripe_webhook_events is global and touched
-- only in service context (the webhook), like the library's write side.
CREATE TABLE "email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text DEFAULT '' NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_billing" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"trial_ends_at" timestamp with time zone NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_subscription_item_id" text,
	"subscription_status" text,
	"seats" integer DEFAULT 1 NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"past_due_since" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD CONSTRAINT "tenant_billing_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_sends_tenant_kind_key_idx" ON "email_sends" USING btree ("tenant_id","kind","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_customer_idx" ON "tenant_billing" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_subscription_idx" ON "tenant_billing" USING btree ("stripe_subscription_id");--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_billing',
    'email_sends'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (
           tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
           OR current_setting(''app.is_service_role'', true) = ''true''
         )
         WITH CHECK (
           tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
           OR current_setting(''app.is_service_role'', true) = ''true''
         )',
      t
    );
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "stripe_webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_webhook_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY service_only ON "stripe_webhook_events"
  FOR ALL
  USING (current_setting('app.is_service_role', true) = 'true')
  WITH CHECK (current_setting('app.is_service_role', true) = 'true');--> statement-breakpoint
-- Every tenant that exists before billing did starts its free month now.
-- tenant_billing has FORCE ROW LEVEL SECURITY, which binds the owner role
-- that runs migrations too (unless it is a superuser or has BYPASSRLS), so
-- the backfill runs as the service role: set_config(..., true) is local to
-- the migration's transaction, and without it the INSERT fails the
-- tenant_isolation policy's WITH CHECK.
SELECT set_config('app.is_service_role', 'true', true);--> statement-breakpoint
INSERT INTO "tenant_billing" ("tenant_id", "trial_ends_at")
  SELECT "id", now() + interval '30 days' FROM "tenants"
  ON CONFLICT ("tenant_id") DO NOTHING;
