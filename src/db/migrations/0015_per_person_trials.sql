-- Billing hardening (README "Trial, billing and emails"):
--
-- user_trials: who has had a free month, one row per Clerk user, written
-- when a firm the user created got its trial. A later firm by the same
-- creator gets none (tenant_billing.trial_ends_at null) and starts locked.
-- firm_creation_attempts: every call of the create-firm action per user,
-- for its per-day limit.
-- tenant_billing: trial_ends_at becomes nullable (no free month),
-- complimentary (the operator's own firm, set by npm run billing:comp),
-- subscription_created_at (Stripe's created of the stored subscription, so
-- an event for an older subscription is ignored whatever order events
-- arrive in) and checkout_session_id (the open Checkout Session, expired
-- before a new one is made).
-- stripe_webhook_events.applied_at: a claim without it after ten minutes is
-- taken over by the next delivery.
-- tenants: created_by_user_id (the creator, for user_trials) and deleted_at
-- (organization.deleted: a soft delete; the rows stay, the firm is
-- unreachable).
--
-- Both new tables are global, service-written only (the create-firm action
-- and the org-sync webhook run in service context), with the same
-- service_only policy as stripe_webhook_events in 0014.
CREATE TABLE "firm_creation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_trials" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_billing" ALTER COLUMN "trial_ends_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_webhook_events" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD COLUMN "complimentary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD COLUMN "subscription_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD COLUMN "checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_trials" ADD CONSTRAINT "user_trials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "firm_creation_attempts_user_time_idx" ON "firm_creation_attempts" USING btree ("clerk_user_id","attempted_at");--> statement-breakpoint
ALTER TABLE "user_trials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_trials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY service_only ON "user_trials"
  FOR ALL
  USING (current_setting('app.is_service_role', true) = 'true')
  WITH CHECK (current_setting('app.is_service_role', true) = 'true');--> statement-breakpoint
ALTER TABLE "firm_creation_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "firm_creation_attempts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY service_only ON "firm_creation_attempts"
  FOR ALL
  USING (current_setting('app.is_service_role', true) = 'true')
  WITH CHECK (current_setting('app.is_service_role', true) = 'true');
