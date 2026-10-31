-- The library (src/services/library/, docs/LIBRARY.md): the app's own copy of
-- the public, official immigration-law sources, collected directly from the
-- government and court sites and refreshed daily. Like the legal-update
-- tables (0005), every table here is GLOBAL: one copy for every firm, no
-- tenant or client data. At the end of this file: every context may SELECT
-- them, and only service context (withServiceContext, which sets
-- app.is_service_role) may INSERT, UPDATE or DELETE them, so app users read
-- the library and only the library worker writes it.
--
-- Search: library_documents.search_vector is a weighted tsvector (title and
-- the document's own citations A, the summary or headnote the source states
-- (metadata.summary) B, court and agency C, text D) kept by the
-- trigger below and indexed with GIN; pg_trgm indexes titles and normalized
-- citations for fuzzy lookups. A tsvector is limited to 1 MB, so the trigger
-- indexes only the first 200,000 characters of a document's text (at most
-- about 600 KB of lexemes and positions even for text of short, unique
-- words); the text itself is always stored whole (large values go to TOAST)
-- and readers page through it. pg_trgm is one of the extensions Neon
-- supports; the owner role that runs migrations may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."library_license" AS ENUM('public_domain', 'link_only');--> statement-breakpoint
CREATE TYPE "public"."library_precedential_status" AS ENUM('precedential', 'non_precedential', 'not_applicable', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."library_run_kind" AS ENUM('daily', 'backfill');--> statement-breakpoint
CREATE TYPE "public"."library_run_status" AS ENUM('running', 'completed', 'partial', 'failed', 'skipped', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."library_source_status" AS ENUM('pending', 'ok', 'partial', 'failed', 'needs_key', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."library_text_kind" AS ENUM('full', 'excerpt', 'none');--> statement-breakpoint
CREATE TABLE "library_backfill_state" (
	"source_code" text PRIMARY KEY NOT NULL,
	"cursor" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"chunks_done" integer DEFAULT 0 NOT NULL,
	"documents_done" integer DEFAULT 0 NOT NULL,
	"retry_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_chunk_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_citations" (
	"document_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"normalized" text NOT NULL,
	"kind" text NOT NULL,
	"raw" text NOT NULL,
	CONSTRAINT "library_citations_document_id_relation_normalized_pk" PRIMARY KEY("document_id","relation","normalized")
);
--> statement-breakpoint
CREATE TABLE "library_document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"citations" text[] DEFAULT '{}'::text[] NOT NULL,
	"official_url" text NOT NULL,
	"original_url" text,
	"original_s3_key" text,
	"text" text NOT NULL,
	"text_kind" "library_text_kind" NOT NULL,
	"text_sha256" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaced_by_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "library_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_code" text NOT NULL,
	"external_id" text NOT NULL,
	"doc_type" text NOT NULL,
	"title" text NOT NULL,
	"citations" text[] DEFAULT '{}'::text[] NOT NULL,
	"court" text,
	"agency" text,
	"decision_date" date,
	"published_date" date,
	"effective_date" date,
	"edition_date" date,
	"document_year" integer,
	"precedential_status" "library_precedential_status" DEFAULT 'unknown' NOT NULL,
	"official_url" text NOT NULL,
	"original_url" text,
	"original_s3_key" text,
	"original_sha256" text,
	"original_content_type" text,
	"text" text NOT NULL,
	"text_kind" "library_text_kind" DEFAULT 'full' NOT NULL,
	"text_sha256" text NOT NULL,
	"text_chars" integer DEFAULT 0 NOT NULL,
	"search_vector" "tsvector",
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetch_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"listing_fingerprint" text,
	"version" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_id" uuid,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"superseded_by_id" uuid,
	"superseded_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_fetch_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_code" text NOT NULL,
	"kind" "library_run_kind" NOT NULL,
	"status" "library_run_status" DEFAULT 'running' NOT NULL,
	"pg_boss_job_id" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"cursor_before" jsonb,
	"cursor_after" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "library_http_cache" (
	"url" text NOT NULL,
	"final_url" text NOT NULL,
	"source_code" text NOT NULL,
	"etag" text,
	"last_modified" text,
	"content_sha256" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_http_cache_source_code_url_pk" PRIMARY KEY("source_code","url")
);
--> statement-breakpoint
CREATE TABLE "library_sources" (
	"code" text PRIMARY KEY NOT NULL,
	"group_code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"coverage" text NOT NULL,
	"cadence" text NOT NULL,
	"official_url" text NOT NULL,
	"license" "library_license" NOT NULL,
	"license_note" text,
	"status" "library_source_status" DEFAULT 'pending' NOT NULL,
	"status_detail" text,
	"last_success_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"document_count" integer DEFAULT 0 NOT NULL,
	"freshness" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"legal_updates_baseline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_backfill_state" ADD CONSTRAINT "library_backfill_state_source_code_library_sources_code_fk" FOREIGN KEY ("source_code") REFERENCES "public"."library_sources"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_citations" ADD CONSTRAINT "library_citations_document_id_library_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."library_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_document_versions" ADD CONSTRAINT "library_document_versions_document_id_library_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."library_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_documents" ADD CONSTRAINT "library_documents_source_code_library_sources_code_fk" FOREIGN KEY ("source_code") REFERENCES "public"."library_sources"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_fetch_runs" ADD CONSTRAINT "library_fetch_runs_source_code_library_sources_code_fk" FOREIGN KEY ("source_code") REFERENCES "public"."library_sources"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_http_cache" ADD CONSTRAINT "library_http_cache_source_code_library_sources_code_fk" FOREIGN KEY ("source_code") REFERENCES "public"."library_sources"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_citations_normalized_idx" ON "library_citations" USING btree ("normalized","relation");--> statement-breakpoint
CREATE INDEX "library_citations_normalized_trgm_idx" ON "library_citations" USING gin ("normalized" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "library_document_versions_document_version_idx" ON "library_document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "library_documents_source_external_idx" ON "library_documents" USING btree ("source_code","external_id");--> statement-breakpoint
CREATE INDEX "library_documents_search_idx" ON "library_documents" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "library_documents_title_trgm_idx" ON "library_documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "library_documents_source_date_idx" ON "library_documents" USING btree ("source_code","decision_date");--> statement-breakpoint
CREATE INDEX "library_documents_official_url_idx" ON "library_documents" USING btree ("official_url");--> statement-breakpoint
CREATE INDEX "library_documents_first_seen_idx" ON "library_documents" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "library_fetch_runs_source_started_idx" ON "library_fetch_runs" USING btree ("source_code","started_at");--> statement-breakpoint
CREATE INDEX "library_sources_group_idx" ON "library_sources" USING btree ("group_code");--> statement-breakpoint
CREATE OR REPLACE FUNCTION library_documents_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(NEW.citations, ' '), '')), 'A') ||
    setweight(to_tsvector('english', left(coalesce(NEW.metadata->>'summary', ''), 20000)), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.court, '') || ' ' || coalesce(NEW.agency, '')), 'C') ||
    setweight(to_tsvector('english', left(coalesce(NEW.text, ''), 200000)), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER library_documents_search_vector_trg
  BEFORE INSERT OR UPDATE OF title, citations, metadata, court, agency, text ON library_documents
  FOR EACH ROW EXECUTE FUNCTION library_documents_search_vector();--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'library_sources',
    'library_documents',
    'library_document_versions',
    'library_citations',
    'library_fetch_runs',
    'library_backfill_state',
    'library_http_cache'
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
