"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { EDITOR_ROLES, ForbiddenRoleError, PROFILE_CONFIRM_ROLES, getCurrentEntitledTenant, requireRole } from "@/lib/tenant";
import { EntitlementLockedError } from "@/lib/billing/entitlement";
import { practiceProfileSchema } from "@/lib/practice-profile/schema";
import {
  PracticeProfileRequestError,
  startOrGetDraft,
  saveDraft as saveDraftService,
  proposeDraft as proposeDraftService,
  confirmVersion as confirmVersionService,
} from "@/lib/practice-profile/service";

// Each action starts with getCurrentEntitledTenant (a locked firm changes
// nothing), checks the role itself, validates its browser-supplied input,
// and returns expected refusals (role, validation, a stale page, an
// unacknowledged escalation weakening, the lock) as { ok: false } rather
// than throwing them. The service layer audits confirmation and
// acknowledged escalation weakenings.

type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

function issuesMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`).join(" ");
}

async function run<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PracticeProfileRequestError || err instanceof ForbiddenRoleError || err instanceof EntitlementLockedError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

function versionIdOrNull(versionId: unknown): string | null {
  return typeof versionId === "string" && UUID_RE.test(versionId) ? versionId : null;
}

/** Called while rendering the editor page: the open version to edit, created if there is none. */
export async function startOrGetDraftAction() {
  const { tenant, membership, userId } = await getCurrentEntitledTenant("edit the practice profile");
  requireRole(membership, EDITOR_ROLES, "edit the practice profile");
  const row = await startOrGetDraft(tenant.id, userId);
  return { id: row.id, versionNumber: row.versionNumber, status: row.status, profileJson: row.profileJson };
}

export async function saveDraftAction(versionId: unknown, profile: unknown): Promise<ActionResult<{ versionNumber: number }>> {
  return run<{ versionNumber: number }>(async () => {
    const { tenant, membership } = await getCurrentEntitledTenant("edit the practice profile");
    requireRole(membership, EDITOR_ROLES, "edit the practice profile");
    const id = versionIdOrNull(versionId);
    if (!id) return { ok: false, error: "That version was not found." };
    const parsed = practiceProfileSchema.safeParse(profile);
    if (!parsed.success) return { ok: false, error: issuesMessage(parsed.error) };
    const row = await saveDraftService(tenant.id, id, parsed.data);
    revalidatePath("/practice-profile");
    return { ok: true, versionNumber: row.versionNumber };
  });
}

export async function proposeDraftAction(
  versionId: unknown,
  profile: unknown,
  acknowledgeEscalationWeakening: unknown
): Promise<ActionResult<{ versionNumber: number }>> {
  return run<{ versionNumber: number }>(async () => {
    const { tenant, membership, userId } = await getCurrentEntitledTenant("propose a practice profile version");
    requireRole(membership, EDITOR_ROLES, "propose a practice profile version");
    const id = versionIdOrNull(versionId);
    if (!id) return { ok: false, error: "That version was not found." };
    const parsed = practiceProfileSchema.safeParse(profile);
    if (!parsed.success) return { ok: false, error: issuesMessage(parsed.error) };
    const row = await proposeDraftService(tenant.id, id, userId, parsed.data, {
      acknowledgeEscalationWeakening: acknowledgeEscalationWeakening === true,
    });
    revalidatePath("/practice-profile");
    return { ok: true, versionNumber: row.versionNumber };
  });
}

// Confirming makes the version part of the system prompt of every later
// skill run for the firm, so only owners/admins and attorneys may do it.
export async function confirmVersionAction(
  versionId: unknown,
  input: unknown
): Promise<ActionResult<{ versionNumber: number }>> {
  return run<{ versionNumber: number }>(async () => {
    const { tenant, membership, userId } = await getCurrentEntitledTenant("confirm a practice profile version");
    requireRole(membership, PROFILE_CONFIRM_ROLES, "confirm a practice profile version");
    const id = versionIdOrNull(versionId);
    if (!id) return { ok: false, error: "That version was not found." };
    const { fingerprint, acknowledgeEscalationWeakening } = (input ?? {}) as Record<string, unknown>;
    if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
      return { ok: false, error: "Reload the page and review the version before confirming it." };
    }
    const row = await confirmVersionService(tenant.id, id, userId, {
      expectedFingerprint: fingerprint,
      acknowledgeEscalationWeakening: acknowledgeEscalationWeakening === true,
    });
    revalidatePath("/practice-profile");
    return { ok: true, versionNumber: row.versionNumber };
  });
}
