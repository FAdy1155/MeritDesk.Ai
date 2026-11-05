import "server-only";
import { auth } from "@clerk/nextjs/server";
import { and, eq, isNull } from "drizzle-orm";
import { withServiceContext } from "@/db/client";
import { tenants } from "@/db/schema";
import { getEntitlement, requireEntitled, type Entitlement } from "@/lib/billing/entitlement";
import { resolveTenantPageAccess } from "@/lib/billing/page-access";
import type { MembershipRole } from "@/lib/roles";
import { getOrganizationMember } from "@/lib/tenants/clerk-members";
import { resolveMembershipRole } from "@/lib/tenants/membership";

export {
  BILLING_ROLES,
  CONNECTOR_SETTINGS_ROLES,
  EDITOR_ROLES,
  FIRM_IDENTITY_EDIT_ROLES,
  MEMBERS_MANAGE_ROLES,
  PROFILE_CONFIRM_ROLES,
  type MembershipRole,
} from "@/lib/roles";

export class NoActiveTenantError extends Error {}

/** Thrown by requireRole; its message is safe to show to the user. */
export class ForbiddenRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenRoleError";
  }
}

const ROLE_LABELS: Record<MembershipRole, string> = {
  owner_admin: "owner/admin",
  attorney: "attorney",
  paralegal: "paralegal",
  read_only: "read-only",
};

export function hasRole(membership: { role: MembershipRole }, allowed: readonly MembershipRole[]): boolean {
  return allowed.includes(membership.role);
}

/**
 * Refuses the action unless the membership's role is one of `allowed`.
 * Every mutating Server Action calls this (after getCurrentEntitledTenant)
 * before it touches data; `action` completes the sentence "Your role cannot ...".
 */
export function requireRole(
  membership: { role: MembershipRole },
  allowed: readonly MembershipRole[],
  action: string
): void {
  if (!hasRole(membership, allowed)) {
    throw new ForbiddenRoleError(
      `Your role in this firm (${ROLE_LABELS[membership.role] ?? membership.role}) cannot ${action}. A firm owner/admin can change your role in the Members section of the Firm page.`
    );
  }
}

/**
 * Resolves the signed-in user's Clerk identity into our internal tenant +
 * membership row. This lookup itself runs in service context (translating
 * Clerk's org id into our tenant_id is a single indexed read keyed by an
 * identity Postgres RLS doesn't know about yet); every subsequent data
 * query must use withTenantContext(tenant.id, ...), never this helper's
 * service context.
 *
 * The role every requireRole decision uses comes from two places
 * (src/lib/roles.ts, resolveAppRole): Clerk's role in the user's session
 * (orgRole) decides whether they are an owner/admin (Clerk's Admin role),
 * and for everyone else the app role stored on their membership row
 * (attorney, paralegal or read_only, set by an owner/admin on the Firm
 * page) applies. Nothing reads a custom Clerk role. A stored owner_admin
 * never makes anyone an owner/admin on its own: only Clerk's live role
 * does.
 *
 * This does not check the firm's billing state: pages render the lock
 * screen themselves (src/app/AppShell.tsx), and the Billing page and its
 * actions must work while the firm is locked. Everything else under
 * src/app/(app) that changes or discloses data starts with
 * getCurrentEntitledTenant below instead.
 */
export async function getCurrentTenant() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error("Not signed in");
  }
  if (!orgId) {
    throw new NoActiveTenantError("No active organization selected");
  }
  return resolveTenantMembership(userId, orgId, orgRole);
}

/**
 * getCurrentTenant plus the billing check (requireEntitled): the first line
 * of every Server Action and route handler under src/app/(app) that
 * changes the firm's data, costs the platform something or discloses data
 * (README "Trial, billing and emails", "The lock"). A locked firm gets an
 * EntitlementLockedError, whose message says to subscribe; the role check
 * (requireRole) follows. `action` completes "... cannot <action> ...".
 */
export async function getCurrentEntitledTenant(action: string) {
  const current = await getCurrentTenant();
  const entitlement: Entitlement = await requireEntitled(current.tenant.id, action);
  return { ...current, entitlement };
}

/**
 * Page-side guard for tenant workspace data. The app layout also renders a
 * lock screen, but page components must gate their own database reads because
 * a parent presentation condition is not an authorization check. Returning
 * null lets the layout render its existing lock screen without running the
 * page's later data queries. Billing remains available through its separate
 * route and continues to use getCurrentTenant directly.
 */
export async function getCurrentTenantIfEntitled(
  resolveCurrentTenant: typeof getCurrentTenant = getCurrentTenant,
  readCurrentEntitlement: typeof getEntitlement = getEntitlement
) {
  return resolveTenantPageAccess(resolveCurrentTenant, readCurrentEntitlement);
}

/**
 * Why resolveTenantMembership found no tenant or no membership; the message
 * is the one getCurrentTenant has always thrown. no_membership now means
 * Clerk itself does not list the user as a member (a session that outlived
 * a removal): a member whose row the org-sync webhook has not written yet
 * gets the row created instead.
 */
export class TenantResolutionError extends Error {
  constructor(
    readonly reason: "no_tenant" | "no_membership",
    message: string
  ) {
    super(message);
    this.name = "TenantResolutionError";
  }
}

/**
 * The lookup behind getCurrentTenant, for a Clerk identity that did not come
 * from a browser session: the connector (src/services/connector/clerk-auth.ts)
 * resolves the user and organization of an OAuth access token through it, so
 * both paths apply the same rules. `orgRole` is the role Clerk gives the user
 * in that organization now (org:admin or org:member), verified by the
 * caller; the app role follows from it and the membership row
 * (resolveMembershipRole). A user with no row yet is confirmed with Clerk's
 * Backend API and gets a row; a user Clerk no longer lists is refused. A
 * tenant whose organization was deleted (tenants.deleted_at) is treated as
 * missing: nothing reaches a deleted firm.
 */
export async function resolveTenantMembership(userId: string, orgId: string, orgRole: string | null | undefined) {
  const tenant = await withServiceContext(async (tx) => {
    const rows = await tx
      .select()
      .from(tenants)
      .where(and(eq(tenants.clerkOrgId, orgId), isNull(tenants.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!tenant) {
    throw new TenantResolutionError(
      "no_tenant",
      `No tenant record for Clerk org ${orgId} yet. Has the org-sync webhook run for this org?`
    );
  }

  const resolved = await resolveMembershipRole({
    tenantId: tenant.id,
    userId,
    clerkRole: orgRole,
    confirmMembership: async () => (await getOrganizationMember(orgId, userId))?.clerkRole ?? null,
  });
  if (!resolved) {
    throw new TenantResolutionError("no_membership", `User ${userId} is not a member of Clerk org ${orgId} (no membership row, and Clerk does not list them)`);
  }

  const membership = { ...resolved.row, role: resolved.role };
  return { tenant, membership, userId };
}
