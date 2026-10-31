-- Connector (src/services/connector/, docs/CONNECTORS.md): the remote MCP
-- server at /api/mcp that Claude and ChatGPT connect to.
--
-- tenant_connector_settings: each firm's switches, one row per tenant. The
-- case-work tools are off until an owner/admin turns them on after
-- acknowledging the disclosure (src/lib/connector/disclosure.ts), and
-- document download links are off unless turned on separately.
-- connector_rate_buckets: the connector's per-user and per-tenant token
-- buckets (src/services/connector/rate-limit.ts).
--
-- Both are tenant data: the same tenant_isolation policy as every other
-- tenant table, in the nullif form of 0006_rls_tenant_setting.sql, at the
-- end of this file.
CREATE TABLE "connector_rate_buckets" (
	"tenant_id" uuid NOT NULL,
	"bucket_key" text NOT NULL,
	"tokens" double precision NOT NULL,
	"refilled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_rate_buckets_tenant_id_bucket_key_pk" PRIMARY KEY("tenant_id","bucket_key")
);
--> statement-breakpoint
CREATE TABLE "tenant_connector_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_work_enabled" boolean DEFAULT false NOT NULL,
	"disclosure_version" text,
	"disclosure_acknowledged_by" text,
	"disclosure_acknowledged_at" timestamp with time zone,
	"allow_document_downloads" boolean DEFAULT false NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_rate_buckets" ADD CONSTRAINT "connector_rate_buckets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_connector_settings" ADD CONSTRAINT "tenant_connector_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_connector_settings_tenant_idx" ON "tenant_connector_settings" USING btree ("tenant_id");--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_connector_settings',
    'connector_rate_buckets'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (
           tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
           OR current_setting(''app.is_service_role'', true) = ''true''
         )
         WITH CHECK (
           tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
           OR current_setting(''app.is_service_role'', true) = ''true''
         )',
      t
    );
  END LOOP;
END $$;
