"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { EntitlementLockedError } from "@/lib/billing/entitlement";
import { MEMBER_APP_ROLES } from "@/lib/roles";
import { ForbiddenRoleError, MEMBERS_MANAGE_ROLES, getCurrentEntitledTenant, requireRole } from "@/lib/tenant";
import { changeMemberRole, type FirmMemberView } from "@/lib/tenants/members";
import { MemberRoleRequestError } from "@/lib/tenants/membership";

// The Firm page's Members section (src/lib/tenants/members.ts): an
// owner/admin sets a member's app role. A locked firm changes nothing
// (getCurrentEntitledTenant); only an owner/admin may do it
// (MEMBERS_MANAGE_ROLES); the input arrives from the browser and is
// validated here (the member is named by Clerk user id, never by a row the
// browser supplies); the service reads the member from Clerk live, refuses
// a Clerk Admin, and audits the change.

type ActionResult = { ok: true; member: FirmMemberView } | { ok: false; error: string };

const inputSchema = z.object({
  userId: z.string().regex(/^user_[A-Za-z0-9]+$/),
  role: z.enum(MEMBER_APP_ROLES),
});

export async function setMemberRoleAction(input: unknown): Promise<ActionResult> {
  try {
    const { tenant, membership, userId } = await getCurrentEntitledTenant("change a member's role");
    requireRole(membership, MEMBERS_MANAGE_ROLES, "change a member's role");
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Choose a member and one of the roles attorney, paralegal or read-only." };
    const member = await changeMemberRole(tenant, userId, parsed.data);
    revalidatePath("/firm");
    return { ok: true, member };
  } catch (err) {
    if (err instanceof MemberRoleRequestError || err instanceof ForbiddenRoleError || err instanceof EntitlementLockedError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
