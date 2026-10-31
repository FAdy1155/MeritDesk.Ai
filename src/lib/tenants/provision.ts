import "server-only";
import { and, count, eq, getTableColumns, gt, isNull, notInArray, sql } from "drizzle-orm";
import type { db } from "@/db/client";
import { firmCreationAttempts, memberships, tenants } from "@/db/schema";
import { appOrigin, billingUrl, connectUrl, DAY_MS, FIRM_CREATION_DAILY_LIMIT } from "@/lib/billing/config";
import { startBilling } from "@/lib/billing/store";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { DEFAULT_MEMBER_ROLE, isClerkAdmin, resolveAppRole, type MembershipRole } from "@/lib/roles";
import { MCP_ENDPOINT_PATH } from "@/services/connector/config";
import { enqueueBillingEmail } from "@/services/queue/billing-jobs";

// A tenant and its memberships from a Clerk organization, in a caller's
// service-context transaction. Two paths lead here: the org-sync webhook
// (src/lib/tenants/clerk-events.ts) for every organization event, and
// the create-firm action (src/lib/tenants/create-firm.ts) right after it
// created the organization, so a new firm is usable before the webhook has
// arrived. Both are idempotent: whichever runs second finds the rows.

export type OrganizationSnapshot = {
  id: string;
  name: string;
  slug: string | null;
  /** The Clerk user who created the organization, when known (the create-firm caller; organization.created's created_by). */
  createdBy?: string | null;
};

function fallbackSlug(name: string, clerkOrgId: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "firm";
  return `${base}-${clerkOrgId.replace(/^org_/, "").slice(-8).toLowerCase()}`;
}

export type UpsertTenantResult = {
  tenant: typeof tenants.$inferSelect;
  created: boolean;
  /** Whether a created firm got the free month (false: its creator had used one, and it starts locked). */
  trialGranted: boolean;
};

/**
 * Inserts the tenant for a Clerk organization and its billing row (the
 * free month, or none when the creator already had one: startBilling), or
 * updates the name and slug of one that exists: one INSERT ... ON CONFLICT
 * (clerk_org_id) DO UPDATE ... RETURNING, so two callers racing for the
 * same new organization both get the one row and exactly one sees
 * `created`. A tenant whose organization was deleted is left as it is.
 */
export async function upsertTenantFromOrganization(tx: typeof db, org: OrganizationSnapshot, actorUserId: string): Promise<UpsertTenantResult> {
  const slug = org.slug || fallbackSlug(org.name, org.id);
  const [row] = await tx
    .insert(tenants)
    .values({ name: org.name, slug, clerkOrgId: org.id, createdByUserId: org.createdBy ?? null })
    .onConflictDoUpdate({
      target: tenants.clerkOrgId,
      set: { name: org.name, slug, updatedAt: new Date() },
      setWhere: isNull(tenants.deletedAt),
    })
    .returning({ ...getTableColumns(tenants), inserted: sql<boolean>`(xmax = 0)` });
  if (!row) {
    // The row exists and is deleted (the DO UPDATE's WHERE excluded it): nothing changes.
    const [deleted] = await tx.select().from(tenants).where(eq(tenants.clerkOrgId, org.id)).limit(1);
    return { tenant: deleted, created: false, trialGranted: deleted.createdByUserId !== null };
  }
  const { inserted, ...tenant } = row;
  if (!inserted) {
    return { tenant, created: false, trialGranted: true };
  }
  const billing = await startBilling(tx, { tenantId: tenant.id, creatorUserId: tenant.createdByUserId, actorUserId });
  return { tenant, created: true, trialGranted: billing.trialGranted };
}

export type MembershipRow = typeof memberships.$inferSelect;

/** Inserts the membership row with the given app role, or sets the stored role of one that exists. */
export async function upsertMembership(tx: typeof db, tenantId: string, userId: string, role: MembershipRole): Promise<void> {
  await tx
    .insert(memberships)
    .values({ tenantId, userId, role })
    .onConflictDoUpdate({ target: [memberships.tenantId, memberships.userId], set: { role } });
}

/**
 * Writes the membership row for a Clerk membership as the org sync sees it
 * (the webhook's organizationMembership.created and .updated, the repair
 * action, a request that finds no row yet): Clerk's Admin is owner_admin; a
 * Member keeps the app role the firm gave them (attorney, paralegal or
 * read_only) and gets read_only when the row is new or still says
 * owner_admin (a demotion). One INSERT ... ON CONFLICT DO UPDATE, decided
 * against the row as it is at that moment, so a concurrent writer cannot
 * lose the stored role. Returns the row as written.
 */
export async function upsertMembershipFromClerk(tx: typeof db, tenantId: string, userId: string, clerkRole: string | null | undefined): Promise<MembershipRow> {
  const admin = isClerkAdmin(clerkRole);
  const [row] = await tx
    .insert(memberships)
    .values({ tenantId, userId, role: admin ? "owner_admin" : DEFAULT_MEMBER_ROLE })
    .onConflictDoUpdate({
      target: [memberships.tenantId, memberships.userId],
      set: {
        role: admin
          ? "owner_admin"
          : sql`case when ${memberships.role} = 'owner_admin' then ${DEFAULT_MEMBER_ROLE}::membership_role else ${memberships.role} end`,
      },
    })
    .returning();
  return row;
}

/** The membership row of a user in a tenant, or null. */
export async function readMembership(tx: typeof db, tenantId: string, userId: string): Promise<MembershipRow | null> {
  const [row] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function removeMembership(tx: typeof db, tenantId: string, userId: string): Promise<void> {
  await tx.delete(memberships).where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
}

/**
 * Makes the firm's membership rows match Clerk's list of members (the
 * daily job, src/lib/billing/daily.ts): a row is added for every listed
 * member without one (owner_admin for a Clerk Admin, read_only for a
 * Member), an existing row follows the same rule as the webhook (an Admin
 * becomes owner_admin, a Member keeps their app role or drops from
 * owner_admin to read_only), and rows of anyone not listed are removed.
 * Returns how many rows changed. The caller passes a complete, non-empty
 * list.
 */
export async function replaceMemberships(tx: typeof db, tenantId: string, members: { userId: string; clerkRole: string }[]): Promise<number> {
  if (members.length === 0) return 0;
  const existing = await tx.select({ userId: memberships.userId, role: memberships.role }).from(memberships).where(eq(memberships.tenantId, tenantId));
  const current = new Map(existing.map((m) => [m.userId, m.role]));
  let changed = 0;
  for (const member of members) {
    const role = resolveAppRole(member.clerkRole, current.get(member.userId) ?? null);
    if (current.get(member.userId) === role) continue;
    await upsertMembership(tx, tenantId, member.userId, role);
    changed++;
  }
  const keep = members.map((m) => m.userId);
  const removed = await tx
    .delete(memberships)
    .where(and(eq(memberships.tenantId, tenantId), notInArray(memberships.userId, keep)))
    .returning({ id: memberships.id });
  return changed + removed.length;
}

/** Whether the user belongs to any firm that still exists (the create-firm action refuses a second firm). */
export async function userBelongsToAnyFirm(tx: typeof db, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(and(eq(memberships.userId, userId), isNull(tenants.deletedAt)))
    .limit(1);
  return Boolean(row);
}

/** How many times the user called the create-firm action in the last day. */
export async function countRecentFirmCreationAttempts(tx: typeof db, userId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - DAY_MS);
  const [row] = await tx
    .select({ n: count() })
    .from(firmCreationAttempts)
    .where(and(eq(firmCreationAttempts.clerkUserId, userId), gt(firmCreationAttempts.attemptedAt, since)));
  return Number(row?.n ?? 0);
}

/**
 * Records one call of the create-firm action and says whether it may go
 * ahead: false once the user has made FIRM_CREATION_DAILY_LIMIT attempts in
 * the last day (the refused call is not recorded, so the limit lifts as the
 * earlier attempts age out).
 */
export async function recordFirmCreationAttempt(tx: typeof db, userId: string, now = new Date()): Promise<{ allowed: boolean; attempts: number }> {
  const attempts = await countRecentFirmCreationAttempts(tx, userId, now);
  if (attempts >= FIRM_CREATION_DAILY_LIMIT) return { allowed: false, attempts };
  await tx.insert(firmCreationAttempts).values({ clerkUserId: userId, attemptedAt: now });
  return { allowed: true, attempts: attempts + 1 };
}

/**
 * Marks a tenant deleted (organization.deleted): deleted_at set, its
 * membership rows removed. The tenant row, its data, its audit log and its
 * billing row stay; getCurrentTenant, the connector and the daily job skip
 * it. Returns the row, or null when there is no such tenant or it was
 * already marked.
 */
export async function markTenantDeleted(tx: typeof db, clerkOrgId: string, now = new Date()): Promise<typeof tenants.$inferSelect | null> {
  const [updated] = await tx
    .update(tenants)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(tenants.clerkOrgId, clerkOrgId), isNull(tenants.deletedAt)))
    .returning();
  if (!updated) return null;
  await tx.delete(memberships).where(eq(memberships.tenantId, updated.id));
  return updated;
}

/**
 * Queues the welcome email (the free month, or that there is none, and how
 * to add the connector to Claude) for a new firm's owner/admins.
 * `delaySeconds` lets Clerk's membership events land first when the
 * organization was created outside the app. A queue failure is logged,
 * never thrown: the firm is created.
 */
export async function queueWelcomeEmail(
  tenant: { id: string; name: string; trialEndsAt: Date | null },
  options: { delaySeconds?: number } = {}
): Promise<void> {
  const origin = appOrigin();
  try {
    await enqueueBillingEmail(
      {
        tenantId: tenant.id,
        kind: "welcome",
        dedupeKey: "",
        params: {
          firmName: tenant.name,
          trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null,
          connectUrl: connectUrl(origin),
          connectorUrl: origin ? `${origin}${MCP_ENDPOINT_PATH}` : null,
          billingUrl: billingUrl(origin),
        },
      },
      { startAfterSeconds: options.delaySeconds }
    );
  } catch (err) {
    console.error(`[billing] the welcome email for tenant ${tenant.id} could not be queued: ${describeErrorForLog(err)}`);
  }
}
