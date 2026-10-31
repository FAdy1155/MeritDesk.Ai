-- Two fixes to the isolation and practice-profile invariants.
--
-- 1. Every tenant_isolation policy reads app.tenant_id through nullif.
-- withTenantContext (src/db/client.ts) sets it with
-- set_config('app.tenant_id', $1, true), local to the transaction. After that
-- transaction ends, Postgres keeps the setting defined on the connection with
-- the value '' rather than NULL, and connections are reused (the app's pool
-- and Neon's pooler). The policies cast the setting to uuid, and ''::uuid is
-- an error, so a later service-context transaction on that connection
-- (withServiceContext: the tenant lookup on every request, the Clerk webhook,
-- the stuck-run sweep, the legal-update monitor) would fail before the
-- is_service_role branch of the OR is reached. nullif turns '' into NULL:
-- no tenant matches it, and the service branch decides. ALTER POLICY keeps
-- each policy's name, table and command (FOR ALL); only the expressions
-- change. The global legal-update tables' policies (0005) never read
-- app.tenant_id and are unchanged.
--
-- 2. At most one active practice profile version per tenant: the partial
-- unique index promised in schema.ts and never created. confirmVersion now
-- serializes per tenant (src/lib/practice-profile/service.ts); the index
-- holds even for a path that does not. If this statement fails, a tenant
-- already has two active versions: list them with
--   SELECT tenant_id, id, version_number, confirmed_at FROM practice_profile_versions
--   WHERE status = 'active' ORDER BY tenant_id, confirmed_at;
-- set every one but the version the firm means to keep to 'superseded', and
-- deploy again.
CREATE UNIQUE INDEX "practice_profile_versions_one_active_idx" ON "practice_profile_versions" USING btree ("tenant_id") WHERE "status" = 'active';--> statement-breakpoint
ALTER POLICY tenant_isolation ON tenants
  USING (
    id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.is_service_role', true) = 'true'
  )
  WITH CHECK (
    id = nullif(current_setting('app.tenant_id', true), '')::uuid
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
    'audit_logs',
    'firm_identities',
    'firm_attorneys',
    'legal_update_reviews'
  ]
  LOOP
    EXECUTE format(
      'ALTER POLICY tenant_isolation ON %I
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
