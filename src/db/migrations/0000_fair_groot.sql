CREATE TYPE "public"."document_type" AS ENUM('uploaded_evidence', 'generated_draft', 'final_docx', 'receipt_notice', 'other');--> statement-breakpoint
CREATE TYPE "public"."matter_party_role" AS ENUM('petitioner', 'beneficiary', 'respondent', 'derivative', 'witness');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner_admin', 'attorney', 'paralegal', 'read_only');--> statement-breakpoint
CREATE TYPE "public"."practice_profile_status" AS ENUM('draft', 'pending_confirmation', 'active', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."skill_rollout_status" AS ENUM('draft', 'canary', 'ga', 'deprecated');--> statement-breakpoint
CREATE TYPE "public"."skill_run_status" AS ENUM('queued', 'running', 'needs_input', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"a_number" text,
	"date_of_birth" text,
	"country_of_birth" text,
	"primary_language" text,
	"contact_email" text,
	"contact_phone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"type" "document_type" NOT NULL,
	"file_name" text NOT NULL,
	"s3_key" text NOT NULL,
	"s3_bucket" text NOT NULL,
	"mime_type" text,
	"size_bytes" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"extracted_text" text,
	"sensitivity_tag" text,
	"malware_scan_status" text DEFAULT 'pending' NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matter_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"role" "matter_party_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"venue" text,
	"circuit" text,
	"court" text,
	"nta_date" text,
	"one_year_clock_date" text,
	"next_hearing_date" text,
	"assigned_attorney_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "membership_role" DEFAULT 'paralegal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "practice_profile_status" DEFAULT 'draft' NOT NULL,
	"profile_json" jsonb NOT NULL,
	"rendered_markdown" text,
	"diff_from_previous" jsonb,
	"proposed_by" text,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"skill_markdown" text NOT NULL,
	"output_json_schema" jsonb NOT NULL,
	"required_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rollout_status" "skill_rollout_status" DEFAULT 'draft' NOT NULL,
	"canary_percentage" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"skill_definition_id" uuid NOT NULL,
	"skill_name" text NOT NULL,
	"skill_version" integer NOT NULL,
	"status" "skill_run_status" DEFAULT 'queued' NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"structured_output" jsonb,
	"verification_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"escalation_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transcript_s3_key" text,
	"error_message" text,
	"requested_by" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"clerk_org_id" text NOT NULL,
	"subscription_tier" text DEFAULT 'standard' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_parties" ADD CONSTRAINT "matter_parties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_parties" ADD CONSTRAINT "matter_parties_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_parties" ADD CONSTRAINT "matter_parties_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_profile_versions" ADD CONSTRAINT "practice_profile_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_definition_id_skill_definitions_id_fk" FOREIGN KEY ("skill_definition_id") REFERENCES "public"."skill_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_idx" ON "audit_logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "clients_tenant_idx" ON "clients" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "documents_tenant_idx" ON "documents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "documents_matter_idx" ON "documents" USING btree ("matter_id");--> statement-breakpoint
CREATE INDEX "matter_parties_tenant_idx" ON "matter_parties" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "matter_parties_matter_idx" ON "matter_parties" USING btree ("matter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "matter_parties_matter_client_role_idx" ON "matter_parties" USING btree ("matter_id","client_id","role");--> statement-breakpoint
CREATE INDEX "matters_tenant_idx" ON "matters" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_user_idx" ON "memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_tenant_idx" ON "memberships" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "practice_profile_versions_tenant_idx" ON "practice_profile_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "practice_profile_versions_tenant_version_idx" ON "practice_profile_versions" USING btree ("tenant_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_definitions_name_version_idx" ON "skill_definitions" USING btree ("name","version");--> statement-breakpoint
CREATE INDEX "skill_runs_tenant_idx" ON "skill_runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "skill_runs_matter_idx" ON "skill_runs" USING btree ("matter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_idx" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_clerk_org_idx" ON "tenants" USING btree ("clerk_org_id");