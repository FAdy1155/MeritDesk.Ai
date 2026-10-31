import type { membershipRoleEnum } from "@/db/schema";

// The membership roles and what each may do, and how a Clerk organization
// membership becomes one of them. Kept apart from src/lib/tenant.ts (which
// reads the Clerk session) so the worker can check a run's recorded role
// without importing Clerk's Next.js server module.
//
// Where a role lives (README "Clerk"): Clerk keeps only its two default
// organization roles, which need no paid add-on. Clerk's Admin (org:admin)
// is the app's owner_admin. Every other member is Clerk's Member
// (org:member), and their app role (attorney, paralegal or read_only) is
// the memberships.role column, set by an owner/admin on the Firm page. The
// app reads no custom Clerk role.

export type MembershipRole = (typeof membershipRoleEnum.enumValues)[number];

/**
 * Roles that may change a firm's data: create matters, clients and parties,
 * upload and rescan documents, queue and retry skill runs (which spend API
 * budget and write generated documents onto matters), and draft the
 * practice profile. read_only, which every new member starts as, may only
 * read: open pages and download documents.
 */
export const EDITOR_ROLES: readonly MembershipRole[] = ["owner_admin", "attorney", "paralegal"];

/**
 * Roles that may confirm a practice profile version. The confirmed profile
 * becomes part of the system prompt of every later skill run for the firm,
 * so this is limited to the firm's lawyers and administrators.
 */
export const PROFILE_CONFIRM_ROLES: readonly MembershipRole[] = ["owner_admin", "attorney"];

/**
 * Roles that may edit the firm identity: letterhead details, the attorney
 * roster and its signature images (and see a signature's preview). What is
 * stored there goes onto every document the app generates for the firm, under
 * an attorney's name and signature, so it is limited like profile confirmation.
 * The same roles are the only ones whose skill runs embed a stored signature
 * image in a generated document (src/services/skill-runner/tools/shared/signer.ts).
 */
export const FIRM_IDENTITY_EDIT_ROLES: readonly MembershipRole[] = ["owner_admin", "attorney"];

/**
 * Roles that may change the firm's connector switches (src/lib/connector/settings.ts).
 * Turning the case-work tools on sends client data into members' Claude or
 * ChatGPT conversations under those providers' terms, so only an
 * owner/admin may decide it, after acknowledging the disclosure.
 */
export const CONNECTOR_SETTINGS_ROLES: readonly MembershipRole[] = ["owner_admin"];

/**
 * Roles that may subscribe the firm and manage its billing (src/lib/billing/):
 * start Stripe Checkout and open the Customer Portal. Paying for the firm's
 * seats is the owner/admin's decision; every member sees the Billing page's
 * state and is told to ask the owner.
 */
export const BILLING_ROLES: readonly MembershipRole[] = ["owner_admin"];

/**
 * Roles that may set another member's app role on the Firm page
 * (src/lib/tenants/membership.ts). Who may run skills, confirm the practice
 * profile or edit the firm identity follows from the role, so giving one is
 * the owner/admin's decision, like billing and the connector switches.
 */
export const MEMBERS_MANAGE_ROLES: readonly MembershipRole[] = ["owner_admin"];

const MEMBERSHIP_ROLES: readonly MembershipRole[] = ["owner_admin", "attorney", "paralegal", "read_only"];

export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

/**
 * The app roles a Clerk Member can hold, which an owner/admin chooses on the
 * Firm page. owner_admin is not one: it is Clerk's Admin role, given and
 * taken away in Clerk's organization settings.
 */
export const MEMBER_APP_ROLES = ["attorney", "paralegal", "read_only"] as const satisfies readonly MembershipRole[];

export type MemberAppRole = (typeof MEMBER_APP_ROLES)[number];

/** What a new member is until an owner/admin gives them a role. */
export const DEFAULT_MEMBER_ROLE: MemberAppRole = "read_only";

export function isMemberAppRole(value: unknown): value is MemberAppRole {
  return typeof value === "string" && (MEMBER_APP_ROLES as readonly string[]).includes(value);
}

/** Clerk's default Admin organization role: the app's owner_admin. */
export const CLERK_ADMIN_ROLE = "org:admin";

/** Clerk's default Member organization role: every member who is not an owner/admin. */
export const CLERK_MEMBER_ROLE = "org:member";

/**
 * Whether a Clerk organization role key is Clerk's Admin role. Any other key
 * (org:member, or one the app does not know) counts as a member: nothing is
 * ever promoted by an unexpected role.
 */
export function isClerkAdmin(clerkRole: string | null | undefined): boolean {
  return clerkRole === CLERK_ADMIN_ROLE;
}

/**
 * The app role of a membership from the two things that decide it: the role
 * Clerk gives the user in the organization now, and the app role stored on
 * the membership row (null when there is no row yet).
 *
 * - Clerk Admin: owner_admin, whatever the row says.
 * - Clerk Member with a stored attorney, paralegal or read_only: that role.
 * - Clerk Member with no row, or a row that still says owner_admin (an
 *   admin demoted in Clerk before the sync wrote it): read_only.
 */
export function resolveAppRole(clerkRole: string | null | undefined, storedRole: MembershipRole | null | undefined): MembershipRole {
  if (isClerkAdmin(clerkRole)) return "owner_admin";
  if (storedRole && isMemberAppRole(storedRole)) return storedRole;
  return DEFAULT_MEMBER_ROLE;
}
