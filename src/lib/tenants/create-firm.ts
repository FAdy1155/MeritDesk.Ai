import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { withServiceContext } from "@/db/client";
import { FIRM_CREATION_DAILY_LIMIT } from "@/lib/billing/config";
import { readTenantBilling } from "@/lib/billing/store";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { queueWelcomeEmail, recordFirmCreationAttempt, upsertMembership, upsertTenantFromOrganization, userBelongsToAnyFirm } from "./provision";

// Self-serve firm creation (the form the app shows a signed-in user with no
// firm, src/app/(app)/onboarding/). In order: the caller may not belong to
// a firm already (neither in the app's rows nor in Clerk) and may call this
// at most FIRM_CREATION_DAILY_LIMIT times a day (firm_creation_attempts);
// the organization is created in Clerk through its Backend API with the
// user as creator, who gets Clerk's creator role, its default Admin role
// (org:admin, the app's owner/admin; README "Clerk" says to leave the
// creator role at that default), and the tenant, its membership
// (owner_admin) and its billing row are written here and now, so the user
// lands in a working firm without waiting for the org-sync webhook (which
// then finds the rows). The free month goes to a creator who has not had
// one (src/lib/billing/store.ts, startBilling); otherwise the firm starts
// locked and the Billing page says so. The browser sets the new
// organization active in the session and goes to /connect.
//
// This is the one way a user creates a firm: in Clerk, "Allow user-created
// organizations" is off (README "Clerk"), so nobody gets around these
// checks through Clerk's own components.

/** A refusal the user can act on; the action returns its message instead of throwing it. */
export class CreateFirmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateFirmError";
  }
}

export const FIRM_NAME_MAX_CHARS = 120;

export type CreateFirmResult = { clerkOrgId: string; tenantId: string; trialGranted: boolean };

export async function createFirm(params: { name: string; userId: string }): Promise<CreateFirmResult> {
  const name = params.name.trim();
  if (name.length < 2) throw new CreateFirmError("Enter the firm's name.");
  if (name.length > FIRM_NAME_MAX_CHARS) throw new CreateFirmError(`The firm's name is limited to ${FIRM_NAME_MAX_CHARS} characters.`);

  const client = await clerkClient();

  // One firm per person, and a handful of attempts a day.
  const refusal = await withServiceContext(async (tx) => {
    if (await userBelongsToAnyFirm(tx, params.userId)) return "member" as const;
    const attempt = await recordFirmCreationAttempt(tx, params.userId);
    return attempt.allowed ? null : ("limit" as const);
  });
  if (refusal === "member") {
    throw new CreateFirmError("You already belong to a firm. Choose it in the menu above; a person can create one firm.");
  }
  if (refusal === "limit") {
    throw new CreateFirmError(`The firm could not be created: this account has tried ${FIRM_CREATION_DAILY_LIMIT} times today. Try again tomorrow, or ask the platform's operator.`);
  }
  const clerkMemberships = await client.users.getOrganizationMembershipList({ userId: params.userId, limit: 1 });
  if (clerkMemberships.data.length > 0) {
    throw new CreateFirmError("You already belong to a firm. Choose it in the menu above; a person can create one firm.");
  }

  let org;
  try {
    org = await client.organizations.createOrganization({ name, createdBy: params.userId });
  } catch (err) {
    console.error(`[tenants] Clerk refused to create the organization: ${describeErrorForLog(err)}`);
    throw new CreateFirmError("The firm could not be created at the sign-in service. Try again; if it keeps failing, ask the platform's operator.");
  }

  // The creator holds Clerk's creator role, org:admin, which is owner_admin
  // here; the row is written with it so the firm works before the webhook's
  // organizationMembership.created (which finds the row) arrives.
  const tenant = await withServiceContext(async (tx) => {
    const { tenant, trialGranted } = await upsertTenantFromOrganization(tx, { id: org.id, name: org.name, slug: org.slug, createdBy: params.userId }, params.userId);
    await upsertMembership(tx, tenant.id, params.userId, "owner_admin");
    const billing = await readTenantBilling(tx, tenant.id);
    return { id: tenant.id, name: tenant.name, trialEndsAt: billing?.trialEndsAt ?? null, trialGranted };
  });
  await queueWelcomeEmail(tenant);
  return { clerkOrgId: org.id, tenantId: tenant.id, trialGranted: tenant.trialGranted };
}
