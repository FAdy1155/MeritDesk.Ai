-- documents.s3_version_id: the S3 object version the malware scan read (or
-- the app wrote, for generated documents). Downloads and skill runs read
-- that version only, so bytes PUT to the key after the scan are never
-- served. skill_definitions.reference_files: the references/*.md content of
-- each skill version, stored by the seed so a run sends exactly what the
-- version's content_hash covers. Columns only; the existing RLS policy on
-- documents (0001_rls.sql) covers the new column, and skill_definitions is
-- global (no RLS).
ALTER TABLE "documents" ADD COLUMN "s3_version_id" text;--> statement-breakpoint
ALTER TABLE "skill_definitions" ADD COLUMN "reference_files" jsonb;
