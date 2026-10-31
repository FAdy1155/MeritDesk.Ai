-- Legal-update monitoring (src/services/monitoring/), the platform version of
-- the eoir-weekly-update skill. Three GLOBAL tables hold what the weekly
-- check finds at the official sources: legal_update_runs (one row per check),
-- legal_update_source_checks (what each source returned in a run) and
-- legal_updates (one row per item, with its quoted source text and summary).
-- They are not tenant data, so they get no tenant_isolation policy. Instead,
-- at the end of this file: every context may SELECT them, and only service
-- context (withServiceContext, which sets app.is_service_role) may INSERT,
-- UPDATE or DELETE them, so app users can read but never change them.
-- legal_update_reviews is tenant data (a firm's review of an item, with the
-- attorney's note) and gets the same tenant_isolation policy as every other
-- tenant table (0001_rls.sql).
CREATE TYPE "public"."legal_update_status" AS ENUM('baseline', 'pending_summary', 'published', 'summary_failed', 'screened', 'duplicate');--> statement-breakpoint
CREATE TABLE "legal_update_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_update_id" uuid NOT NULL,
	"reviewed_by" text NOT NULL,
	"note" text,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_update_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"pg_boss_job_id" text,
	"totals" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "legal_update_source_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"index_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"new_items" integer DEFAULT 0 NOT NULL,
	"revised_items" integer DEFAULT 0 NOT NULL,
	"index_content_hash" text,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "legal_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"cross_source_key" text,
	"item_type" text NOT NULL,
	"title" text NOT NULL,
	"citation" text,
	"official_url" text NOT NULL,
	"listed_on_url" text NOT NULL,
	"document_url" text,
	"published_date_text" text,
	"published_on" date,
	"retrieved_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"raw_excerpt" text NOT NULL,
	"document_quotes" jsonb,
	"listing_facts" jsonb,
	"circuit" text,
	"court_weight" text,
	"ai_summary" text,
	"summary_model" text,
	"summarized_at" timestamp with time zone,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"affected_skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"analysis" jsonb,
	"status" "legal_update_status" DEFAULT 'pending_summary' NOT NULL,
	"status_reason" text,
	"summary_attempts" integer DEFAULT 0 NOT NULL,
	"revision_of" uuid,
	"first_seen_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legal_update_reviews" ADD CONSTRAINT "legal_update_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_update_reviews" ADD CONSTRAINT "legal_update_reviews_legal_update_id_legal_updates_id_fk" FOREIGN KEY ("legal_update_id") REFERENCES "public"."legal_updates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_update_source_checks" ADD CONSTRAINT "legal_update_source_checks_run_id_legal_update_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."legal_update_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_updates" ADD CONSTRAINT "legal_updates_first_seen_run_id_legal_update_runs_id_fk" FOREIGN KEY ("first_seen_run_id") REFERENCES "public"."legal_update_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_update_reviews_tenant_idx" ON "legal_update_reviews" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_update_reviews_tenant_item_idx" ON "legal_update_reviews" USING btree ("tenant_id","legal_update_id");--> statement-breakpoint
CREATE INDEX "legal_update_runs_started_at_idx" ON "legal_update_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "legal_update_source_checks_source_started_idx" ON "legal_update_source_checks" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "legal_update_source_checks_run_idx" ON "legal_update_source_checks" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_updates_source_item_hash_idx" ON "legal_updates" USING btree ("source","external_id","content_hash");--> statement-breakpoint
CREATE INDEX "legal_updates_status_retrieved_idx" ON "legal_updates" USING btree ("status","retrieved_at");--> statement-breakpoint
CREATE INDEX "legal_updates_affected_skills_idx" ON "legal_updates" USING gin ("affected_skills");--> statement-breakpoint
CREATE INDEX "legal_updates_cross_source_idx" ON "legal_updates" USING btree ("cross_source_key");--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'legal_update_runs',
    'legal_update_source_checks',
    'legal_updates'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY global_read ON %I FOR SELECT USING (true)', t);
    EXECUTE format(
      'CREATE POLICY service_write ON %I
         FOR ALL
         USING (current_setting(''app.is_service_role'', true) = ''true'')
         WITH CHECK (current_setting(''app.is_service_role'', true) = ''true'')',
      t
    );
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE legal_update_reviews ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE legal_update_reviews FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON legal_update_reviews
  USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    OR current_setting('app.is_service_role', true) = 'true'
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    OR current_setting('app.is_service_role', true) = 'true'
  );
