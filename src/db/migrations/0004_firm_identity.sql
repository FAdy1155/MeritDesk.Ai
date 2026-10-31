-- Firm identity (src/lib/firm-identity/service.ts): each tenant's letterhead
-- details (firm_identities, one row per tenant) and its attorney and
-- accredited representative roster (firm_attorneys), with each person's
-- signature image stored in S3 under the tenant's firm-signatures/ prefix.
-- Skill runs and document generators use these instead of the firm the
-- skills were written for. Both tables get the same tenant_isolation RLS
-- policy as every other tenant table (0001_rls.sql), at the end of this file.
CREATE TYPE "public"."firm_attorney_role" AS ENUM('attorney', 'accredited_representative');--> statement-breakpoint
CREATE TABLE "firm_attorneys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"title" text,
	"role" "firm_attorney_role" DEFAULT 'attorney' NOT NULL,
	"bar_state" text,
	"bar_number" text,
	"eoir_id" text,
	"email" text,
	"is_default_signer" boolean DEFAULT false NOT NULL,
	"signature_s3_bucket" text,
	"signature_s3_key" text,
	"signature_s3_version_id" text,
	"signature_media_type" text,
	"signature_size_bytes" integer,
	"signature_sha256" text,
	"signature_width_px" integer,
	"signature_height_px" integer,
	"signature_uploaded_by" text,
	"signature_uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firm_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"address_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phone" text,
	"fax" text,
	"email" text,
	"website" text,
	"licensure_line" text,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "firm_attorneys" ADD CONSTRAINT "firm_attorneys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_identities" ADD CONSTRAINT "firm_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "firm_attorneys_tenant_idx" ON "firm_attorneys" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "firm_attorneys_one_default_signer_idx" ON "firm_attorneys" USING btree ("tenant_id") WHERE "is_default_signer" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "firm_identities_tenant_idx" ON "firm_identities" USING btree ("tenant_id");--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'firm_identities',
    'firm_attorneys'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (
           tenant_id = current_setting(''app.tenant_id'', true)::uuid
           OR current_setting(''app.is_service_role'', true) = ''true''
         )
         WITH CHECK (
           tenant_id = current_setting(''app.tenant_id'', true)::uuid
           OR current_setting(''app.is_service_role'', true) = ''true''
         )',
      t
    );
  END LOOP;
END $$;