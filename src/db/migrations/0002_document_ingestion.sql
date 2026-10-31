-- Document ingestion (src/services/ingest/ingest.ts): PDF page count, the
-- scan/extraction outcome note, and when ingestion was last queued and last
-- finished. Columns only; the existing tenant_isolation RLS policy on
-- documents (0001_rls.sql) already covers them, so no policy changes are needed.
ALTER TABLE "documents" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ingestion_note" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ingest_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ingested_at" timestamp with time zone;
