import "server-only";
import { and, eq } from "drizzle-orm";
import { withServiceContext, type db } from "@/db/client";
import { memberships } from "@/db/schema";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";
import { isClerkAdmin, isMemberAppRole, resolveAppRole, type MemberAppRole, type MembershipRole } from "@/lib/roles";
import { upsertMembershipFromClerk, type MembershipRow } from "./provision";

// A member's app role: how a request resolves it, and how an owner/admin
// changes it. No Clerk import here, so the check script can run both against
// PGlite; the callers (src/lib/tenant.ts, src/lib/tenants/members.ts) bring
// the Clerk role they verified and a way to ask Clerk when a row is missing.
//
// The rule (src/lib/roles.ts, resolveAppRole): Clerk's Admin is owner_admin,
// whatever the row says; a Clerk Member has the app role stored on the
// membership row, and read_only when there is none or the row still says
// owner_admin. The stored role is never trusted to make someone an
// owner/admin: only Clerk's live role does that.

export type ResolvedMembership = { row: MembershipRow; role: MembershipRole };

type ServiceRunner = <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;

/**
 * The membership row and app role for a request, given the Clerk role the
 * caller verified (the session's orgRole, or the connector's read of Clerk's
 * Backend API). When the row is missing (the org-sync webhook has not
 * delivered yet), `confirmMembership` asks Clerk whether the user is a member
 * of the organization now and with which role: null means they are not (a
 * stale session after a removal) and nothing is written; otherwise the row
 * is created as the webhook would create it (owner_admin for an Admin,
 * read_only for a Member) and used. Returns null only when the user is not a
 * member.
 */
export async function resolveMembershipRole(input: {
  tenantId: string;
  userId: string;
  clerkRole: string | null | undefined;
  /** Clerk's current role for the user in the organization, or null when they are not a member. Called only when the row is missing. */
  confirmMembership: () => Promise<string | null>;
  runService?: ServiceRunner;
}): Promise<ResolvedMembership | null> {
  const runService = input.runService ?? withServiceContext;
  const existing = await runService(async (tx) => {
    const [row] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, input.tenantId), eq(memberships.userId, input.userId)))
      .limit(1);
    return row ?? null;
  });
  if (existing) return { row: existing, role: resolveAppRole(input.clerkRole, existing.role) };

  const liveRole = await input.confirmMembership();
  if (liveRole === null) return null;
  const row = await runService((tx) => upsertMembershipFromClerk(tx, input.tenantId, input.userId, liveRole));
  return { row, role: resolveAppRole(liveRole, row.role) };
}

/** A refusal the owner/admin can act on; the action returns its message instead of throwing it. */
export class MemberRoleRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberRoleRequestError";
  }
}

export type SetMemberRoleResult = { changed: boolean; role: MembershipRole; membershipId: string };

/**
 * Sets a member's app role (attorney, paralegal or read_only), in the
 * caller's withTenantContext transaction for the tenant. The caller has
 * checked that the actor is an owner/admin (MEMBERS_MANAGE_ROLES) and read
 * the target's current Clerk membership live: `targetClerkRole` is that
 * role. A Clerk Admin is refused: owner_admin is Clerk's Admin role and is
 * given or taken away in Clerk's organization settings, never here. A member
 * with no row yet gets one. Nothing is written when the role is already the
 * one asked for; otherwise the change is audited as membership.role_changed
 * with the role before (as it resolved for the member) and after.
 */
export async function setMemberAppRole(
  tx: typeof db,
  input: { tenantId: string; actorUserId: string; targetUserId: string; targetClerkRole: string | null | undefined; role: MemberAppRole | string }
): Promise<SetMemberRoleResult> {
  if (isClerkAdmin(input.targetClerkRole)) {
    throw new MemberRoleRequestError(
      "This person is an owner/admin (an Admin of the firm at the sign-in service). Owner/admins are made and unmade in the organization settings (the firm menu at the top), not here."
    );
  }
  if (!isMemberAppRole(input.role)) {
    throw new MemberRoleRequestError("Choose attorney, paralegal or read-only.");
  }
  const role: MemberAppRole = input.role;
  const [existing] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.tenantId, input.tenantId), eq(memberships.userId, input.targetUserId)))
    .limit(1)
    .for("update");
  const before = existing ? resolveAppRole(input.targetClerkRole, existing.role) : null;
  if (existing && existing.role === role) {
    return { changed: false, role, membershipId: existing.id };
  }
  const [row] = existing
    ? await tx
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.id, existing.id), eq(memberships.tenantId, input.tenantId)))
        .returning()
    : await tx
        .insert(memberships)
        .values({ tenantId: input.tenantId, userId: input.targetUserId, role })
        .returning();
  await recordAuditEvent(tx, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: AUDIT_ACTIONS.membershipRoleChanged,
    resourceType: "membership",
    resourceId: row.id,
    before: { role: before },
    after: { role, userId: input.targetUserId },
  });
  return { changed: true, role, membershipId: row.id };
}
