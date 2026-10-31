"use server";

import { revalidatePath } from "next/cache";
import { EDITOR_ROLES, ForbiddenRoleError, getCurrentEntitledTenant, requireRole } from "@/lib/tenant";
import { EntitlementLockedError } from "@/lib/billing/entitlement";
import { MAX_ATTORNEY_NOTE_CHARS } from "@/lib/skill-runs/snapshot";
import { enqueueSkillRun, retrySkillRun, SkillRunRequestError } from "@/services/skill-runner/run";
import { getSkillModule, isSupportedSkillName } from "@/services/skill-runner/skills";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * The run form's Run button: queues a run of `skillName` on the matter.
 * Expected refusals (an unknown skill, a note over the limit, a role that may
 * not run skills, a locked firm, a full queue) come back as
 * { ok: false, error } rather than as a thrown error, whose message
 * production builds would hide; anything else still throws.
 */
export async function triggerSkillRunAction(
  matterId: string,
  skillName: string,
  attorneyNote?: string
): Promise<ActionResult> {
  // Server Action arguments come straight from the browser; validate them
  // against the registry instead of trusting the client's types.
  if (typeof matterId !== "string" || !UUID_RE.test(matterId)) {
    return { ok: false, error: "Invalid matter id." };
  }
  if (typeof skillName !== "string" || !isSupportedSkillName(skillName)) {
    return { ok: false, error: `Unknown skill "${String(skillName)}".` };
  }
  // Only skills that ask for a case note get one; anything else is dropped.
  const note =
    getSkillModule(skillName).needsNote && typeof attorneyNote === "string" ? attorneyNote.trim() || undefined : undefined;
  if (note && note.length > MAX_ATTORNEY_NOTE_CHARS) {
    return {
      ok: false,
      error: `The case note is too long (${note.length} characters; the limit is ${MAX_ATTORNEY_NOTE_CHARS}).`,
    };
  }

  try {
    // A locked firm (free month or subscription ended) queues no runs: they spend the platform's model budget.
    const { tenant, membership, userId } = await getCurrentEntitledTenant("run skills");
    requireRole(membership, EDITOR_ROLES, "run skills");
    await enqueueSkillRun({
      tenantId: tenant.id,
      matterId,
      skillName,
      requestedBy: userId,
      requesterRole: membership.role,
      attorneyNote: note,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof SkillRunRequestError || err instanceof ForbiddenRoleError || err instanceof EntitlementLockedError) {
      return { ok: false, error: err.message };
    }
    throw err;
  } finally {
    // Revalidate even on failure to enqueue: a failed row still belongs in the list.
    revalidatePath(`/matters/${matterId}`);
  }
}

/**
 * The Retry button on a failed run: queues a new run of the same skill with
 * the same case note (see retrySkillRun). Expected refusals (the run is not
 * failed, a retry is already in progress, the user's role may not run
 * skills, a locked firm) come back as { ok: false, error } rather than as a
 * thrown error; anything else still throws.
 */
export async function retrySkillRunAction(skillRunId: string): Promise<ActionResult> {
  // Arrives from the browser: check the shape before it reaches a uuid column.
  if (typeof skillRunId !== "string" || !UUID_RE.test(skillRunId)) {
    return { ok: false, error: "Invalid run id." };
  }
  try {
    const { tenant, membership, userId } = await getCurrentEntitledTenant("retry skill runs");
    requireRole(membership, EDITOR_ROLES, "retry skill runs");
    const { matterId } = await retrySkillRun({
      tenantId: tenant.id,
      skillRunId,
      requestedBy: userId,
      requesterRole: membership.role,
    });
    revalidatePath(`/matters/${matterId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof SkillRunRequestError || err instanceof ForbiddenRoleError || err instanceof EntitlementLockedError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
