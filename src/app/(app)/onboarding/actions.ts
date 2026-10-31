"use server";

import { revalidatePath } from "next/cache";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { withServiceContext } from "@/db/client";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { getOrganizationMember } from "@/lib/tenants/clerk-members";
import { CreateFirmError, createFirm } from "@/lib/tenants/create-firm";
import { upsertMembershipFromClerk, upsertTenantFromOrganization } from "@/lib/tenants/provision";

// The two actions behind the app's "before the pages" states
// (src/app/AppShell.tsx). Both act for the signed-in user only: the firm is
// created with that user as owner, and the repair writes the rows for the
// organization active in that user's session, after Clerk confirms they
// are a member of it now, with the role Clerk gives them there (Admin:
// owner_admin; Member: the stored app role, or read_only for a new row).

type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** Creates the firm (a Clerk organization, the tenant, the free month); the browser then makes it the active organization. */
export async function createFirmAction(name: unknown): Promise<ActionResult<{ clerkOrgId: string }>> {
  const { userId } = await auth();
  if (!userId) return { ok: false, error: "Sign in first." };
  if (typeof name !== "string") return { ok: false, error: "Enter the firm's name." };
  try {
    const { clerkOrgId } = await createFirm({ name, userId });
    revalidatePath("/");
    return { ok: true, clerkOrgId };
  } catch (err) {
    if (err instanceof CreateFirmError) return { ok: false, error: err.message };
    console.error(`[tenants] createFirmAction failed: ${describeErrorForLog(err)}`);
    return { ok: false, error: "The firm could not be created. Try again." };
  }
}

/** Writes the tenant and membership rows for the session's organization when the org-sync webhook has not. */
export async function repairTenantAction(): Promise<ActionResult<object>> {
  const { userId, orgId } = await auth();
  if (!userId) return { ok: false, error: "Sign in first." };
  if (!orgId) return { ok: false, error: "Choose a firm first." };
  try {
    const client = await clerkClient();
    const [org, member] = await Promise.all([client.organizations.getOrganization({ organizationId: orgId }), getOrganizationMember(orgId, userId)]);
    if (!member) {
      return { ok: false, error: "You are not a member of this firm any more. Reload the page and choose another firm." };
    }
    await withServiceContext(async (tx) => {
      const { tenant } = await upsertTenantFromOrganization(tx, { id: org.id, name: org.name, slug: org.slug }, userId);
      await upsertMembershipFromClerk(tx, tenant.id, userId, member.clerkRole);
    });
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    console.error(`[tenants] repairTenantAction failed: ${describeErrorForLog(err)}`);
    return { ok: false, error: "The firm could not be set up. Try again; if it keeps failing, ask the platform's operator." };
  }
}
