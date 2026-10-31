import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import { sanitizeDatabaseError } from "@/lib/errors/safe-error";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Unscoped instance — only for operations that are intentionally cross-tenant
// (e.g. the Clerk org-sync webhook creating a new tenant row). Every other
// piece of application code must go through withTenantContext below so that
// Postgres RLS (see src/db/migrations/0001_rls.sql) actually has a
// `app.tenant_id` session variable to check against.
export const db = drizzle(pool, { schema });

/**
 * Thrown on the first transaction when DATABASE_URL connects as a role that
 * row-level security does not apply to. FORCE ROW LEVEL SECURITY binds a
 * table's owner, but never a superuser or a role with BYPASSRLS (Neon's
 * project owner role may be one), and with such a role every policy in the
 * migrations is silently inert.
 */
export class DatabaseRoleBypassesRlsError extends Error {
  constructor(role: string, reason: string) {
    super(
      `DATABASE_URL connects as "${role}", which ${reason}, so row-level security would not isolate tenants. ` +
        "Connect the app and the worker as a role created with NOSUPERUSER NOBYPASSRLS that does not own the tables, " +
        'and keep the owner role for migrations (MIGRATION_DATABASE_URL); see README "Database roles".'
    );
    this.name = "DatabaseRoleBypassesRlsError";
  }
}

let roleCheck: Promise<void> | null = null;

/**
 * Refuses to run tenant queries as a role RLS does not apply to. Checked once
 * per process, on the first transaction (the web app) or at startup (the
 * worker calls it before taking jobs); a failed check fails every later
 * transaction the same way, so nothing runs without the database's
 * isolation layer.
 */
export function assertDatabaseRoleEnforcesRls(): Promise<void> {
  roleCheck ??= (async () => {
    let row: { role: string; rolsuper: boolean; rolbypassrls: boolean } | undefined;
    try {
      const result = await db.execute<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>(
        sql`select current_user as role, rolsuper, rolbypassrls from pg_roles where rolname = current_user`
      );
      row = result.rows[0];
    } catch (err) {
      // The database could not be reached: check again next time instead of failing for good.
      roleCheck = null;
      throw sanitizeDatabaseError(err);
    }
    if (!row) throw new DatabaseRoleBypassesRlsError("(unknown)", "could not be found in pg_roles");
    if (row.rolsuper) throw new DatabaseRoleBypassesRlsError(row.role, "is a superuser");
    if (row.rolbypassrls) throw new DatabaseRoleBypassesRlsError(row.role, "has BYPASSRLS");
  })();
  return roleCheck;
}

/**
 * Runs `callback` inside a transaction with `app.tenant_id` set for that
 * transaction only, so RLS policies scope every query to that tenant. This is
 * defense-in-depth alongside explicit `.where(eq(table.tenantId, tenantId))`
 * filters in query code — never rely on RLS as the only isolation layer.
 *
 * set_config(..., true) rather than SET LOCAL: SET takes no bind parameters,
 * and the tenant id must stay a bound value, never SQL text. It is still
 * transaction-local. Once a connection has had the setting, Postgres reports
 * it as '' (not NULL) in later transactions on that connection; the policies
 * read it through nullif (0006_rls_tenant_setting.sql).
 *
 * Database errors are rethrown without their bound values (sanitizeDatabaseError).
 */
export async function withTenantContext<T>(
  tenantId: string,
  callback: (tx: typeof db) => Promise<T>
): Promise<T> {
  await assertDatabaseRoleEnforcesRls();
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return callback(tx as unknown as typeof db);
    });
  } catch (err) {
    throw sanitizeDatabaseError(err);
  }
}

/**
 * The statement_timeout of a withGlobalReadContext transaction unless the
 * caller sets another. Any signed-in member of any firm, and any skill run,
 * can start these reads, and the database is shared with every tenant's
 * work, so no one read may hold it for long.
 */
export const GLOBAL_READ_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Reads of the global, read-only tables (the library, src/services/library/)
 * that are not tenant data and need no service role: a READ ONLY
 * transaction with neither app.tenant_id nor app.is_service_role set, so
 * only their global_read policy applies, nothing can be written through it,
 * and no tenant table returns a row. Used by the /library pages and the
 * skill runs' library tools.
 *
 * Every statement in it is cancelled after statementTimeoutMs (default
 * GLOBAL_READ_STATEMENT_TIMEOUT_MS; set_config(..., true), so it ends with the
 * transaction). The worker's library jobs and the command-line loaders pass
 * null: they run in the background and are not started by a request.
 */
export async function withGlobalReadContext<T>(
  callback: (tx: typeof db) => Promise<T>,
  options: { statementTimeoutMs?: number | null } = {}
): Promise<T> {
  await assertDatabaseRoleEnforcesRls();
  const timeoutMs = options.statementTimeoutMs === undefined ? GLOBAL_READ_STATEMENT_TIMEOUT_MS : options.statementTimeoutMs;
  try {
    return await db.transaction(
      async (tx) => {
        if (timeoutMs !== null) await tx.execute(sql`select set_config('statement_timeout', ${String(Math.max(1, Math.round(timeoutMs)))}, true)`);
        return callback(tx as unknown as typeof db);
      },
      { accessMode: "read only" }
    );
  } catch (err) {
    throw sanitizeDatabaseError(err);
  }
}

/**
 * Escape hatch for the small set of legitimately cross-tenant server
 * operations (Clerk org-sync webhook creating a new tenant row, admin
 * scripts). Do NOT use this from request-handling code that operates on
 * behalf of a specific tenant's user — use withTenantContext for that.
 */
export async function withServiceContext<T>(
  callback: (tx: typeof db) => Promise<T>
): Promise<T> {
  await assertDatabaseRoleEnforcesRls();
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.is_service_role = 'true'`);
      return callback(tx as unknown as typeof db);
    });
  } catch (err) {
    throw sanitizeDatabaseError(err);
  }
}

/**
 * withTenantContext's shape, for functions that take their transaction
 * runner as a parameter (defaulting to withTenantContext) so a check script
 * can run their SQL in PGlite (src/lib/connector/, src/services/connector/).
 */
export type TenantTransactionRunner = <T>(tenantId: string, callback: (tx: typeof db) => Promise<T>) => Promise<T>;
