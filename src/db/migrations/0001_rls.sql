-- Row-Level Security: tenant isolation.
--
-- Design note: Neon (like most managed Postgres) typically gives a single
-- application role that owns the tables it creates, and RLS does NOT apply
-- to a table's owner unless FORCE ROW LEVEL SECURITY is also set. We use
-- FORCE so isolation actually holds for the app's normal connection role,
-- and we allow a narrow, explicit "service context" escape hatch (set via
-- `SET LOCAL app.is_service_role = 'true'` from src/db/client.ts's
-- withServiceContext helper) for the small set of legitimately cross-tenant
-- server operations (e.g. the Clerk org-sync webhook creating a new tenant
-- row). Every other code path must go through withTenantContext, which sets
-- `app.tenant_id` instead. RLS here is defense-in-depth: application code
-- must ALSO filter by tenant_id explicitly — never rely on this alone.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants
  USING (
    id = current_setting('app.tenant_id', true)::uuid
    OR current_setting('app.is_service_role', true) = 'true'
  )
  WITH CHECK (
    id = current_setting('app.tenant_id', true)::uuid
    OR current_setting('app.is_service_role', true) = 'true'
  );--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships',
    'practice_profile_versions',
    'clients',
    'matters',
    'matter_parties',
    'documents',
    'skill_runs',
    'audit_logs'
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
END $$;--> statement-breakpoint
-- audit_logs: append-only, enforced with a trigger rather than role GRANTs,
-- since Neon setups commonly run the app through a single DB role and a
-- trigger holds regardless of which role/connection issues the statement.
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();--> statement-breakpoint
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
