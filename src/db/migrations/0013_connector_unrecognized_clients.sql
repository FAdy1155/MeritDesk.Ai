-- Connector (src/services/connector/, docs/CONNECTORS.md): the OAuth client
-- ids a firm's members connected from that are not on the platform's allow
-- list (CONNECTOR_ALLOWED_CLIENT_IDS / CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES).
-- Those connections get the library tools only; the Firm page lists the ids
-- (with when each was first and last seen) to the firm's owner/admin, so the
-- platform's operator can recognize the real Claude and ChatGPT clients
-- after a first test connection. Only client ids are stored, never tokens.
--
-- Tenant data: the same tenant_isolation policy as every other tenant
-- table, in the nullif form of 0006_rls_tenant_setting.sql, at the end.
CREATE TABLE "connector_unrecognized_clients" (
	"tenant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"last_user_id" text NOT NULL,
	CONSTRAINT "connector_unrecognized_clients_tenant_id_client_id_pk" PRIMARY KEY("tenant_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "connector_unrecognized_clients" ADD CONSTRAINT "connector_unrecognized_clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_unrecognized_clients_last_seen_idx" ON "connector_unrecognized_clients" USING btree ("tenant_id","last_seen_at");--> statement-breakpoint
ALTER TABLE "connector_unrecognized_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connector_unrecognized_clients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "connector_unrecognized_clients"
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.is_service_role', true) = 'true'
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.is_service_role', true) = 'true'
  );
