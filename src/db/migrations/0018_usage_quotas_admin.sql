-- Usage metering, storage/AI quotas, and operator suspension.
--
-- skill_runs: per-run model usage, recorded when the worker finishes a run.
-- tenant_usage_monthly: one row per tenant and UTC month, incremented with
-- each finished run (src/lib/billing/usage.ts). Storage is summed from
-- documents at read time.
-- tenant_billing: operator_suspended locks the firm regardless of trial,
-- subscription, or complimentary access (/platform).
--
-- tenant_usage_monthly is tenant data: the same tenant_isolation policy as
-- every other tenant table, in the nullif form of 0006_rls_tenant_setting.sql.
ALTER TABLE "skill_runs" ADD COLUMN "input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "cache_read_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "cache_creation_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "web_search_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "web_fetch_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD COLUMN "operator_suspended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD COLUMN "operator_suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD COLUMN "operator_suspended_reason" text;--> statement-breakpoint
CREATE TABLE "tenant_usage_monthly" (
	"tenant_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" bigint DEFAULT 0 NOT NULL,
	"web_search_requests" integer DEFAULT 0 NOT NULL,
	"web_fetch_requests" integer DEFAULT 0 NOT NULL,
	"completed_run_count" integer DEFAULT 0 NOT NULL,
	"failed_run_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_usage_monthly_tenant_id_period_start_pk" PRIMARY KEY("tenant_id","period_start")
);--> statement-breakpoint
ALTER TABLE "tenant_usage_monthly" ADD CONSTRAINT "tenant_usage_monthly_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_usage_monthly_tenant_idx" ON "tenant_usage_monthly" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "tenant_usage_monthly" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_usage_monthly" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "tenant_usage_monthly"
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.is_service_role', true) = 'true'
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.is_service_role', true) = 'true'
  );
