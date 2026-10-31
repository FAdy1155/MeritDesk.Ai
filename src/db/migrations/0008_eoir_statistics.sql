-- EOIR court and judge statistics (src/services/library/adapters/
-- eoir-statistics/, docs/LIBRARY.md): aggregate counts the worker computes
-- from EOIR's public case data release (the "EOIR Case Data" file in EOIR's
-- FOIA library). Like the library tables (0007) every table here is GLOBAL:
-- one copy for every firm, no tenant or client data, and no record of any
-- person or case (counts by judge, court, fiscal year, nationality, custody,
-- representation, case type, decision and application only). At the end of
-- this file: every context may SELECT them, and only service context
-- (withServiceContext, which sets app.is_service_role) may write them.
--
-- Every row belongs to a snapshot (one load of one release); readers use the
-- one snapshot whose status is 'current' (eoir_stats_snapshots_one_current_idx),
-- and deleting a snapshot deletes its rows (ON DELETE CASCADE).
CREATE TABLE "eoir_stats_appeals" (
	"snapshot_id" uuid NOT NULL,
	"judge_code" text NOT NULL,
	"court_code" text NOT NULL,
	"fy" smallint NOT NULL,
	"appeal_type" text NOT NULL,
	"filed_by" text NOT NULL,
	"bia_decision" text NOT NULL,
	"decided" boolean NOT NULL,
	"n" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eoir_stats_applications" (
	"snapshot_id" uuid NOT NULL,
	"judge_code" text NOT NULL,
	"court_code" text NOT NULL,
	"fy" smallint NOT NULL,
	"appl_code" text NOT NULL,
	"decision" text NOT NULL,
	"custody" text NOT NULL,
	"represented" boolean NOT NULL,
	"n" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eoir_stats_applications_nat" (
	"snapshot_id" uuid NOT NULL,
	"judge_code" text NOT NULL,
	"court_code" text NOT NULL,
	"fy" smallint NOT NULL,
	"nationality" text NOT NULL,
	"appl_code" text NOT NULL,
	"decision" text NOT NULL,
	"n" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eoir_stats_codes" (
	"snapshot_id" uuid NOT NULL,
	"code_set" text NOT NULL,
	"case_type" text DEFAULT '' NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"active" boolean,
	"grouping" text,
	CONSTRAINT "eoir_stats_codes_snapshot_id_code_set_case_type_code_pk" PRIMARY KEY("snapshot_id","code_set","case_type","code")
);
--> statement-breakpoint
CREATE TABLE "eoir_stats_courts" (
	"snapshot_id" uuid NOT NULL,
	"court_code" text NOT NULL,
	"city" text,
	"state" text,
	"region" text,
	"lookup_active" boolean,
	"completions" integer DEFAULT 0 NOT NULL,
	"first_fy" smallint,
	"last_fy" smallint,
	CONSTRAINT "eoir_stats_courts_snapshot_id_court_code_pk" PRIMARY KEY("snapshot_id","court_code")
);
--> statement-breakpoint
CREATE TABLE "eoir_stats_judges" (
	"snapshot_id" uuid NOT NULL,
	"judge_code" text NOT NULL,
	"name" text,
	"lookup_active" boolean,
	"completions" integer DEFAULT 0 NOT NULL,
	"first_fy" smallint,
	"last_fy" smallint,
	"courts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "eoir_stats_judges_snapshot_id_judge_code_pk" PRIMARY KEY("snapshot_id","judge_code")
);
--> statement-breakpoint
CREATE TABLE "eoir_stats_proceedings" (
	"snapshot_id" uuid NOT NULL,
	"judge_code" text NOT NULL,
	"court_code" text NOT NULL,
	"fy" smallint NOT NULL,
	"case_type" text NOT NULL,
	"custody" text NOT NULL,
	"represented" boolean NOT NULL,
	"outcome_kind" text NOT NULL,
	"outcome_code" text NOT NULL,
	"completions" integer NOT NULL,
	"absentia" integer NOT NULL,
	"days_n" integer NOT NULL,
	"days_sum" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eoir_stats_proceedings_nat" (
	"snapshot_id" uuid NOT NULL,
	"court_code" text NOT NULL,
	"fy" smallint NOT NULL,
	"nationality" text NOT NULL,
	"case_type" text NOT NULL,
	"custody" text NOT NULL,
	"represented" boolean NOT NULL,
	"outcome_kind" text NOT NULL,
	"outcome_code" text NOT NULL,
	"completions" integer NOT NULL,
	"absentia" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eoir_stats_processing" (
	"snapshot_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_code" text NOT NULL,
	"fy" smallint NOT NULL,
	"custody" text NOT NULL,
	"n" integer NOT NULL,
	"mean_days" real NOT NULL,
	"p25" integer NOT NULL,
	"p50" integer NOT NULL,
	"p75" integer NOT NULL,
	CONSTRAINT "eoir_stats_processing_snapshot_id_scope_scope_code_fy_custody_pk" PRIMARY KEY("snapshot_id","scope","scope_code","fy","custody")
);
--> statement-breakpoint
CREATE TABLE "eoir_stats_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_folder" text,
	"data_date" date,
	"listed_label" text,
	"page_url" text NOT NULL,
	"official_url" text NOT NULL,
	"code_key_url" text,
	"archive_etag" text,
	"archive_last_modified" text,
	"archive_bytes" bigint,
	"status" text DEFAULT 'loading' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"loaded_at" timestamp with time zone,
	"table_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"definitions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eoir_stats_appeals" ADD CONSTRAINT "eoir_stats_appeals_snapshot_id_eoir_stats_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."eoir_stats_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eoir_stats_applications" ADD CONSTRAINT "eoir_stats_applications_snapshot_id_eoir_stats_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."eoir_stats_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eoir_stats_applications_nat" ADD CONSTRAINT "eoir_stats_applications_nat_snapshot_id_eoir_stats_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."eoir_stats_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eoir_stats_codes" ADD CONSTRAINT "eoir_stats_codes_snapshot_id_eoir_stats_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."eoir_stats_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eoir_stats_courts" ADD CONSTRAINT "eoir_stats_courts_snapshot_id_eoir_stats_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."eoir_stats_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eoir_stats_judges" ADD CONSTRAINT "eoir_stats_judges_snapshot_id_eoir_stats_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."eoir_stats_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eoir_stats_proceedings" ADD CONSTRAINT "eoir_stats_proceedings_snapshot_id_eoir_stats_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."eoir_stats_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eoir_stats_proceedings_nat" ADD CONSTRAINT "eoir_stats_proceedings_nat_snapshot_id_eoir_stats_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."eoir_stats_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eoir_stats_processing" ADD CONSTRAINT "eoir_stats_processing_snapshot_id_eoir_stats_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."eoir_stats_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eoir_stats_appeals_judge_idx" ON "eoir_stats_appeals" USING btree ("snapshot_id","judge_code");--> statement-breakpoint
CREATE INDEX "eoir_stats_appeals_court_idx" ON "eoir_stats_appeals" USING btree ("snapshot_id","court_code","fy");--> statement-breakpoint
CREATE INDEX "eoir_stats_applications_judge_idx" ON "eoir_stats_applications" USING btree ("snapshot_id","judge_code","appl_code");--> statement-breakpoint
CREATE INDEX "eoir_stats_applications_court_idx" ON "eoir_stats_applications" USING btree ("snapshot_id","court_code","appl_code");--> statement-breakpoint
CREATE INDEX "eoir_stats_applications_appl_idx" ON "eoir_stats_applications" USING btree ("snapshot_id","appl_code","fy");--> statement-breakpoint
CREATE INDEX "eoir_stats_applications_nat_judge_idx" ON "eoir_stats_applications_nat" USING btree ("snapshot_id","judge_code","nationality");--> statement-breakpoint
CREATE INDEX "eoir_stats_applications_nat_nat_idx" ON "eoir_stats_applications_nat" USING btree ("snapshot_id","nationality","appl_code","fy");--> statement-breakpoint
CREATE INDEX "eoir_stats_applications_nat_court_idx" ON "eoir_stats_applications_nat" USING btree ("snapshot_id","court_code","nationality");--> statement-breakpoint
CREATE INDEX "eoir_stats_proceedings_judge_idx" ON "eoir_stats_proceedings" USING btree ("snapshot_id","judge_code","fy");--> statement-breakpoint
CREATE INDEX "eoir_stats_proceedings_court_idx" ON "eoir_stats_proceedings" USING btree ("snapshot_id","court_code","fy");--> statement-breakpoint
CREATE INDEX "eoir_stats_proceedings_nat_nat_idx" ON "eoir_stats_proceedings_nat" USING btree ("snapshot_id","nationality","fy");--> statement-breakpoint
CREATE INDEX "eoir_stats_proceedings_nat_court_idx" ON "eoir_stats_proceedings_nat" USING btree ("snapshot_id","court_code","fy");--> statement-breakpoint
CREATE UNIQUE INDEX "eoir_stats_snapshots_one_current_idx" ON "eoir_stats_snapshots" USING btree ("status") WHERE status = 'current';--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'eoir_stats_snapshots',
    'eoir_stats_judges',
    'eoir_stats_courts',
    'eoir_stats_codes',
    'eoir_stats_proceedings',
    'eoir_stats_proceedings_nat',
    'eoir_stats_applications',
    'eoir_stats_applications_nat',
    'eoir_stats_appeals',
    'eoir_stats_processing'
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
END $$;
