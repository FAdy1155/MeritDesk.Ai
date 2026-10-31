"use server";

import { revalidatePath } from "next/cache";
import { ForbiddenRoleError, getCurrentEntitledTenant, requireRole } from "@/lib/tenant";
import { EntitlementLockedError } from "@/lib/billing/entitlement";
import {
  LEGAL_UPDATE_CHECK_ROLES,
  LEGAL_UPDATE_REVIEW_ROLES,
  LegalUpdateRequestError,
  markLegalUpdateReviewed,
  requestLegalUpdateCheck,
} from "@/services/monitoring/service";

// The two things a firm can do on /updates. Each starts with
// getCurrentEntitledTenant (a locked firm does neither), checks the role
// itself, validates its browser-supplied input, and returns expected
// refusals as { ok: false } rather than throwing them. The service layer
// audits both in the firm's tenant transaction.

type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LegalUpdateRequestError || err instanceof ForbiddenRoleError || err instanceof EntitlementLockedError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

/** An attorney or owner/admin marks a legal update reviewed for the firm, with an optional note. */
export async function markLegalUpdateReviewedAction(
  legalUpdateId: unknown,
  note: unknown
): Promise<ActionResult<{ reviewedAt: string }>> {
  return run<{ reviewedAt: string }>(async () => {
    const { tenant, membership, userId } = await getCurrentEntitledTenant("mark legal updates reviewed");
    requireRole(membership, LEGAL_UPDATE_REVIEW_ROLES, "mark legal updates reviewed");
    if (typeof legalUpdateId !== "string" || !UUID_RE.test(legalUpdateId)) {
      return { ok: false, error: "That legal update was not found." };
    }
    if (note !== null && note !== undefined && typeof note !== "string") {
      return { ok: false, error: "The note must be text." };
    }
    const { reviewedAt } = await markLegalUpdateReviewed(tenant.id, userId, legalUpdateId, note ?? null);
    revalidatePath("/updates");
    return { ok: true, reviewedAt: reviewedAt.toISOString() };
  });
}

/** An owner/admin starts a check of every official source now, outside the daily schedule. */
export async function checkLegalUpdatesNowAction(): Promise<ActionResult<{ queued: boolean }>> {
  return run<{ queued: boolean }>(async () => {
    const { tenant, membership, userId } = await getCurrentEntitledTenant("start a legal update check");
    requireRole(membership, LEGAL_UPDATE_CHECK_ROLES, "start a legal update check");
    const { queued } = await requestLegalUpdateCheck(tenant.id, userId);
    revalidatePath("/updates");
    return { ok: true, queued };
  });
}
