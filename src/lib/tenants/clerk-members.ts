import "server-only";
import { createClerkClient } from "@clerk/backend";
import { isClerkAdmin } from "@/lib/roles";

// An organization's members as Clerk has them: for the daily job's
// reconciliation of membership rows (src/lib/billing/daily.ts), for the
// Members section of the Firm page (src/lib/tenants/members.ts), and to
// confirm one member live before a row is created or their role changed.
// Read with the Backend API (@clerk/backend, which loads in the worker as
// well as the web app; see src/lib/email/recipients.ts), so it needs
// CLERK_SECRET_KEY. Only Clerk's two default roles are read: an Admin is the
// app's owner/admin, everyone else is a Member whose app role lives in
// memberships.role (README "Clerk").

export type ClerkOrgMember = {
  userId: string;
  /** Clerk's role key for the membership: org:admin or org:member (any other key counts as a member). */
  clerkRole: string;
  /** Clerk's Admin role, the app's owner/admin. */
  isAdmin: boolean;
  /** The member's name as Clerk has it, or null when none is set. */
  name: string | null;
  /** How the member signed up: their email address (or username, when the instance uses those). */
  identifier: string;
};

const PAGE_SIZE = 100;
const MAX_MEMBERS = 2000;

function backendClient() {
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) return null;
  return createClerkClient({ secretKey });
}

function toMember(membership: {
  role: string;
  publicUserData?: { userId: string; firstName: string | null; lastName: string | null; identifier: string } | null;
}): ClerkOrgMember | null {
  const data = membership.publicUserData;
  if (!data?.userId) return null;
  const name = [data.firstName, data.lastName].filter(Boolean).join(" ").trim();
  return { userId: data.userId, clerkRole: membership.role, isAdmin: isClerkAdmin(membership.role), name: name || null, identifier: data.identifier };
}

/**
 * Every member of the organization, or null when the list could not be
 * read whole (no CLERK_SECRET_KEY, an error, or more members than
 * MAX_MEMBERS): the daily job then leaves the rows alone rather than
 * removing members it did not see, and the Firm page says the list is
 * unavailable.
 */
export async function listOrganizationMembers(clerkOrgId: string): Promise<ClerkOrgMember[] | null> {
  const client = backendClient();
  if (!client) return null;
  const members: ClerkOrgMember[] = [];
  let offset = 0;
  for (;;) {
    const page = await client.organizations.getOrganizationMembershipList({ organizationId: clerkOrgId, limit: PAGE_SIZE, offset });
    for (const membership of page.data) {
      const member = toMember(membership);
      if (member) members.push(member);
    }
    offset += page.data.length;
    if (page.data.length < PAGE_SIZE || offset >= page.totalCount) break;
    if (offset >= MAX_MEMBERS) return null;
  }
  return members;
}

/**
 * One user's membership in the organization as Clerk has it now, or null
 * when the user is not a member. Throws when Clerk cannot be asked (no
 * CLERK_SECRET_KEY, or an API error): the callers need a live answer before
 * they write a row or change a role.
 */
export async function getOrganizationMember(clerkOrgId: string, userId: string): Promise<ClerkOrgMember | null> {
  const client = backendClient();
  if (!client) throw new Error("CLERK_SECRET_KEY is not set (needed to read a firm's members from Clerk)");
  const page = await client.organizations.getOrganizationMembershipList({ organizationId: clerkOrgId, userId: [userId], limit: 1 });
  const membership = page.data.find((m) => m.publicUserData?.userId === userId);
  return membership ? toMember(membership) : null;
}
