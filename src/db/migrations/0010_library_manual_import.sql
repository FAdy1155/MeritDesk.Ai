-- Import from the official site (src/services/library/manual-import.ts,
-- /library/import, docs/LIBRARY_SOURCES.md section 1): the library sources
-- whose sites refuse automated tools are kept up to date by a platform
-- operator who saves the page in a browser and gives the app the file.
--
-- - library_source_status 'manual': a source kept up to date that way
--   (LIBRARY_MANUAL_SOURCES), whose daily run and backfill are skipped.
-- - library_run_kind 'manual_import': the library_fetch_runs row of one
--   import. ADD VALUE runs inside the migration's transaction on Postgres 12
--   and later; nothing below uses the new values before it commits.
-- - library_import_log: the audit log of every import attempt. The
--   tenant-scoped audit_logs (0001) cannot hold it: the library is global, so
--   an import changes what every firm reads, and it is made by a platform
--   operator, not by a firm. Like the other library tables it is GLOBAL,
--   with RLS enabled and forced; every context may read it, only service
--   context (withServiceContext) may insert into it, and no context may
--   update or delete it (there is no policy for either), so it is append-only.
ALTER TYPE "public"."library_run_kind" ADD VALUE 'manual_import';--> statement-breakpoint
ALTER TYPE "public"."library_source_status" ADD VALUE 'manual';--> statement-breakpoint
CREATE TABLE "library_import_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_code" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_tenant_id" uuid,
	"official_url" text NOT NULL,
	"linked_url" text,
	"file_sha256" text NOT NULL,
	"file_bytes" integer NOT NULL,
	"file_content_type" text,
	"linked_file_sha256" text,
	"outcome" text NOT NULL,
	"error_message" text,
	"external_id" text,
	"document_id" uuid,
	"document_version" integer,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_import_log" ADD CONSTRAINT "library_import_log_source_code_library_sources_code_fk" FOREIGN KEY ("source_code") REFERENCES "public"."library_sources"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_import_log" ADD CONSTRAINT "library_import_log_document_id_library_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."library_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_import_log" ADD CONSTRAINT "library_import_log_run_id_library_fetch_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."library_fetch_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_import_log_source_created_idx" ON "library_import_log" USING btree ("source_code","created_at");--> statement-breakpoint
ALTER TABLE "library_import_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "library_import_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY global_read ON "library_import_log" FOR SELECT USING (true);--> statement-breakpoint
CREATE POLICY service_insert ON "library_import_log"
  FOR INSERT
  WITH CHECK (current_setting('app.is_service_role', true) = 'true');
