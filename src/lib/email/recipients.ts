import "server-only";
import { createClerkClient } from "@clerk/backend";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { CLERK_ADMIN_ROLE } from "@/lib/roles";

// Who a firm's emails go to: its owner/admin members (the organization's
// Admins at Clerk, its default org:admin role), with a verified email
// address read from Clerk at send time (users.getUser) and never stored
// beyond the count in email_sends. Only addresses Clerk has verified are
// used (the primary one when it is verified, else the first verified one):
// an unverified address is one someone merely typed, and billing mail must
// not go to it. @clerk/backend's createClerkClient rather than
// @clerk/nextjs/server: the worker sends these outside any Next.js request
// (and @clerk/nextjs/server pulls in Next's client-side navigation module,
// which does not load under the worker's react-server condition), so it
// needs CLERK_SECRET_KEY like the web app (DEPLOY.md step 6).

const MAX_RECIPIENTS = 20;

function backendClient() {
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("CLERK_SECRET_KEY is not set (the worker needs it to find a firm's owner/admin addresses)");
  return createClerkClient({ secretKey });
}

type ClerkEmailAddress = { id: string; emailAddress: string; verification: { status: string | null } | null };

/** The address to use for a user: the verified primary, else the first verified one, else null. Exported for the check script. */
export function verifiedAddress(user: { primaryEmailAddressId: string | null; emailAddresses: ClerkEmailAddress[] }): string | null {
  const verified = user.emailAddresses.filter((e) => e.verification?.status === "verified" && e.emailAddress.trim());
  const primary = verified.find((e) => e.id === user.primaryEmailAddressId);
  return (primary ?? verified[0])?.emailAddress.trim() ?? null;
}

/**
 * The verified email address of every owner/admin of the Clerk organization,
 * deduplicated and in membership order; empty when the organization has no
 * owner/admin with a verified address (then nothing is sent and the caller
 * logs it).
 */
export async function ownerAdminEmails(clerkOrgId: string): Promise<string[]> {
  const client = backendClient();
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: clerkOrgId,
    role: [CLERK_ADMIN_ROLE],
    limit: MAX_RECIPIENTS,
  });
  const addresses: string[] = [];
  for (const membership of memberships.data) {
    const userId = membership.publicUserData?.userId;
    if (!userId) continue;
    try {
      const user = await client.users.getUser(userId);
      const address = verifiedAddress(user);
      if (address && !addresses.includes(address)) addresses.push(address);
    } catch (err) {
      console.error(`[email] could not read a member's address from Clerk: ${describeErrorForLog(err)}`);
    }
  }
  return addresses;
}
