import "server-only";
import { eq } from "drizzle-orm";
import { withTenantContext } from "@/db/client";
import { memberships } from "@/db/schema";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { resolveAppRole, type MembershipRole } from "@/lib/roles";
import { getOrganizationMember, listOrganizationMembers } from "./clerk-members";
import { MemberRoleRequestError, setMemberAppRole } from "./membership";

// The Members section of the Firm page (src/app/(app)/firm/): who the firm's
// members are, with their app role, and the owner/admin's change of a
// member's role. Names and addresses come from Clerk's membership list at
// render time and are never stored; the app role is the memberships row,
// resolved with the member's Clerk role the way every request resolves it
// (src/lib/roles.ts, resolveAppRole).

export type FirmMemberView = {
  userId: string;
  /** The member's name as Clerk has it, or null. */
  name: string | null;
  /** The email address (or username) the member signed in with. */
  identifier: string;
  /** Clerk's Admin role: the app's owner/admin, managed in Clerk's organization settings. */
  clerkAdmin: boolean;
  /** The app role as it resolves for the member now. */
  role: MembershipRole;
};

/**
 * The firm's members, owner/admins first, then by name. Null when Clerk's
 * list could not be read (logged): the page says so instead of failing.
 */
export async function listFirmMembers(tenant: { id: string; clerkOrgId: string }): Promise<FirmMemberView[] | null> {
  let clerkMembers;
  try {
    clerkMembers = await listOrganizationMembers(tenant.clerkOrgId);
  } catch (err) {
    console.error(`[tenants] the members of tenant ${tenant.id} could not be read from Clerk: ${describeErrorForLog(err)}`);
    return null;
  }
  if (!clerkMembers) return null;
  const rows = await withTenantContext(tenant.id, (tx) =>
    tx.select({ userId: memberships.userId, role: memberships.role }).from(memberships).where(eq(memberships.tenantId, tenant.id))
  );
  const stored = new Map(rows.map((r) => [r.userId, r.role]));
  const label = (m: { name: string | null; identifier: string }) => (m.name ?? m.identifier).toLowerCase();
  return clerkMembers
    .map((m) => ({
      userId: m.userId,
      name: m.name,
      identifier: m.identifier,
      clerkAdmin: m.isAdmin,
      role: resolveAppRole(m.clerkRole, stored.get(m.userId) ?? null),
    }))
    .sort((a, b) => Number(b.clerkAdmin) - Number(a.clerkAdmin) || label(a).localeCompare(label(b)));
}

/**
 * Sets a member's app role for the owner/admin's action: the target's
 * membership is read from Clerk live first (not a member: refused; a Clerk
 * Admin: refused by setMemberAppRole), then the row is written and the change
 * audited in one tenant transaction. Returns the member as the page shows
 * them.
 */
export async function changeMemberRole(
  tenant: { id: string; clerkOrgId: string },
  actorUserId: string,
  input: { userId: string; role: string }
): Promise<FirmMemberView> {
  const member = await getOrganizationMember(tenant.clerkOrgId, input.userId);
  if (!member) {
    throw new MemberRoleRequestError("That person is not a member of this firm (they may have just been removed). Reload the page.");
  }
  const result = await withTenantContext(tenant.id, (tx) =>
    setMemberAppRole(tx, { tenantId: tenant.id, actorUserId, targetUserId: member.userId, targetClerkRole: member.clerkRole, role: input.role })
  );
  return { userId: member.userId, name: member.name, identifier: member.identifier, clerkAdmin: member.isAdmin, role: result.role };
}
