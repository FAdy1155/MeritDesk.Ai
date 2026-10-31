import "server-only";
import { eq } from "drizzle-orm";
import { withServiceContext, type db } from "@/db/client";
import { tenantBilling, tenants } from "@/db/schema";
import { AUDIT_ACTIONS, SYSTEM_ACTORS, recordAuditEvent } from "@/lib/audit/service";
import { isOpenSubscriptionStatus } from "@/lib/billing/config";
import { syncSeatsQuietly } from "@/lib/billing/seats";
import { lockTenantBilling, readTenantBilling, reconcileLock } from "@/lib/billing/store";
import { getStripe, isStripeConfigured } from "@/lib/billing/stripe";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { markTenantDeleted, queueWelcomeEmail, removeMembership, upsertMembershipFromClerk, upsertTenantFromOrganization } from "./provision";

// What the Clerk webhook (src/app/api/webhooks/clerk/route.ts) does with a
// verified event, apart from the route's own plumbing, so the check script
// can run it against PGlite with constructed events (ClerkEventDeps).
//
// Keeps tenants and memberships in step with Clerk. A membership event
// carries Clerk's role, one of its two default roles: an Admin's row is
// owner_admin; a Member's row keeps the app role the firm gave them on the
// Firm page (attorney, paralegal or read_only) and is read_only when it is
// new or was owner_admin (a demotion). Authorization never trusts a stored
// owner_admin on its own: every request also needs Clerk's live Admin role
// (src/lib/roles.ts, resolveAppRole), so a delivery that fails, is retried
// late or arrives out of order cannot leave anyone an owner/admin Clerk no
// longer makes one. What this decides is whether a row exists and, for a
// Member, nothing about the app role the firm chose.
//
// A new organization gets its tenant and its billing row here
// (src/lib/tenants/provision.ts) unless the create-firm action already
// wrote them; the free month goes to a creator (created_by) who has not had
// one. Its welcome email is queued with a delay so the membership events
// land first. A membership change also sets the firm's Stripe seats to its
// member count when it has a subscription (src/lib/billing/seats.ts), after
// the rows are committed. A deleted organization's tenant is marked deleted
// and its live Stripe subscription canceled at once, prorated.

export type ClerkWebhookEvent = { type: string; data: Record<string, unknown> };

export type ClerkEventDeps = {
  runService: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
  /** Cancels a Stripe subscription at once, prorated; null when Stripe is not configured. */
  cancelSubscription: ((subscriptionId: string) => Promise<void>) | null;
  queueWelcome: (tenant: { id: string; name: string; trialEndsAt: Date | null }) => Promise<void>;
  syncSeats: (tenantId: string) => Promise<void>;
  now?: () => Date;
};

export function defaultClerkEventDeps(): ClerkEventDeps {
  return {
    runService: withServiceContext,
    cancelSubscription: isStripeConfigured()
      ? async (id) => {
          await getStripe().subscriptions.cancel(id, { prorate: true, invoice_now: true });
        }
      : null,
    queueWelcome: (tenant) => queueWelcomeEmail(tenant, { delaySeconds: 60 }),
    syncSeats: (tenantId) => syncSeatsQuietly(tenantId, SYSTEM_ACTORS.orgSync),
  };
}

export type ClerkEventOutcome = "tenant_created" | "tenant_updated" | "membership_changed" | "tenant_deleted" | "ignored";

export async function applyClerkEvent(evt: ClerkWebhookEvent, deps: ClerkEventDeps): Promise<ClerkEventOutcome> {
  const now = deps.now?.() ?? new Date();
  switch (evt.type) {
    case "organization.created":
    case "organization.updated": {
      const org = evt.data as { id: string; name: string; slug: string | null; created_by?: string | null };
      const result = await deps.runService(async (tx) => {
        const { tenant, created } = await upsertTenantFromOrganization(tx, { id: org.id, name: org.name, slug: org.slug, createdBy: org.created_by ?? null }, SYSTEM_ACTORS.orgSync);
        if (!created) return { created: false as const };
        const billing = await readTenantBilling(tx, tenant.id);
        return { created: true as const, welcome: { id: tenant.id, name: tenant.name, trialEndsAt: billing?.trialEndsAt ?? null } };
      });
      if (!result.created) return "tenant_updated";
      await deps.queueWelcome(result.welcome);
      return "tenant_created";
    }

    case "organizationMembership.created":
    case "organizationMembership.updated": {
      const data = evt.data as { organization: { id: string }; public_user_data: { user_id: string }; role: string };
      const tenantId = await deps.runService(async (tx) => {
        const [tenant] = await tx.select({ id: tenants.id, deletedAt: tenants.deletedAt }).from(tenants).where(eq(tenants.clerkOrgId, data.organization.id)).limit(1);
        if (!tenant || tenant.deletedAt) {
          console.error(`[tenants] organizationMembership event for ${tenant ? "deleted" : "unknown"} org ${data.organization.id}; ignoring`);
          return null;
        }
        await upsertMembershipFromClerk(tx, tenant.id, data.public_user_data.user_id, data.role);
        return tenant.id;
      });
      if (!tenantId) return "ignored";
      await deps.syncSeats(tenantId);
      return "membership_changed";
    }

    case "organizationMembership.deleted": {
      const data = evt.data as { organization: { id: string }; public_user_data: { user_id: string } };
      const tenantId = await deps.runService(async (tx) => {
        const [tenant] = await tx.select({ id: tenants.id, deletedAt: tenants.deletedAt }).from(tenants).where(eq(tenants.clerkOrgId, data.organization.id)).limit(1);
        if (!tenant || tenant.deletedAt) return null;
        await removeMembership(tx, tenant.id, data.public_user_data.user_id);
        return tenant.id;
      });
      if (!tenantId) return "ignored";
      await deps.syncSeats(tenantId);
      return "membership_changed";
    }

    case "organization.deleted": {
      const data = evt.data as { id?: string; deleted?: boolean };
      if (!data.id) return "ignored";
      // 1. Mark the tenant deleted and find the subscription to cancel; the row is locked while it is read.
      const deleted = await deps.runService(async (tx) => {
        const tenant = await markTenantDeleted(tx, data.id!, now);
        if (!tenant) return null;
        const billing = await lockTenantBilling(tx, tenant.id);
        const subscriptionId = billing && isOpenSubscriptionStatus(billing.subscriptionStatus) ? billing.stripeSubscriptionId : null;
        await recordAuditEvent(tx, {
          tenantId: tenant.id,
          actorUserId: SYSTEM_ACTORS.orgSync,
          action: AUDIT_ACTIONS.tenantDeleted,
          resourceType: "tenant",
          resourceId: tenant.id,
          after: { clerkOrgId: data.id, hadSubscription: subscriptionId !== null, subscriptionId },
        });
        return { tenantId: tenant.id, subscriptionId };
      });
      if (!deleted) return "ignored";
      console.warn(`[tenants] organization ${data.id} was deleted: tenant ${deleted.tenantId} is marked deleted`);
      // 2. Stripe, outside the transaction: cancel at once with proration.
      if (deleted.subscriptionId) {
        if (!deps.cancelSubscription) {
          console.error(`[billing] tenant ${deleted.tenantId} was deleted with subscription ${deleted.subscriptionId} live, and Stripe is not configured: cancel it in the Stripe dashboard`);
          return "tenant_deleted";
        }
        try {
          await deps.cancelSubscription(deleted.subscriptionId);
        } catch (err) {
          console.error(`[billing] subscription ${deleted.subscriptionId} of deleted tenant ${deleted.tenantId} could not be canceled: ${describeErrorForLog(err)}. Cancel it in the Stripe dashboard.`);
          return "tenant_deleted";
        }
        // 3. Record the cancellation; the subscription.deleted event that follows finds the row already canceled.
        await deps.runService(async (tx) => {
          const row = await lockTenantBilling(tx, deleted.tenantId);
          if (row && row.stripeSubscriptionId === deleted.subscriptionId) {
            const [updated] = await tx
              .update(tenantBilling)
              .set({ subscriptionStatus: "canceled", cancelAtPeriodEnd: false, updatedAt: now })
              .where(eq(tenantBilling.tenantId, deleted.tenantId))
              .returning();
            await reconcileLock(tx, updated, SYSTEM_ACTORS.orgSync, now);
          }
          await recordAuditEvent(tx, {
            tenantId: deleted.tenantId,
            actorUserId: SYSTEM_ACTORS.orgSync,
            action: AUDIT_ACTIONS.billingSubscriptionCanceled,
            resourceType: "billing",
            resourceId: deleted.subscriptionId!,
            after: { reason: "organization_deleted", canceledAt: now.toISOString() },
          });
        });
      }
      return "tenant_deleted";
    }

    default:
      // Event types the app does not act on (user.created, session.*, ...).
      return "ignored";
  }
}
