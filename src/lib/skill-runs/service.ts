import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { withTenantContext, type TenantTransactionRunner } from "@/db/client";
import { skillRuns } from "@/db/schema";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";

export async function listSkillRuns(tenantId: string, matterId: string) {
  return withTenantContext(tenantId, (tx) =>
    tx
      .select()
      .from(skillRuns)
      .where(and(eq(skillRuns.tenantId, tenantId), eq(skillRuns.matterId, matterId)))
      .orderBy(desc(skillRuns.createdAt))
  );
}

export async function getSkillRun(tenantId: string, runId: string) {
  return withTenantContext(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(skillRuns)
      .where(and(eq(skillRuns.id, runId), eq(skillRuns.tenantId, tenantId)))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Why a run was marked failed; stored as `reason` on its skill_run.failed audit entry. */
export type SkillRunFailureReason =
  /** The worker's loop threw (processSkillRun records these itself). */
  | "run_error"
  /** enqueueSkillRun could not put the run's job on the queue. */
  | "enqueue_failed"
  /** Still "running" long past the queue's job expiry. */
  | "stuck_running"
  /** "running", but its queue job ended or no longer exists: the worker died mid-run. */
  | "worker_stopped"
  /** "queued", but no queue job will ever start it. */
  | "never_started"
  /** In progress when its worker shut down (deploy, restart) and not finished within the grace period. */
  | "worker_shutdown"
  /** The worker went to start it and found the firm locked (free month or subscription ended) since it was queued. */
  | "firm_locked";

type UnfinishedStatus = "queued" | "running";

/**
 * Marks a run failed with `errorMessage`, but only while it is still in one
 * of `fromStatuses`: a run that has completed, or was already marked failed
 * by someone else, is left as it is. The status check and the update happen
 * under a row lock, and the skill_run.failed audit row is written in the same
 * transaction. Returns whether this call changed the run.
 *
 * Used for runs that cannot record their own failure: the stuck-run sweep,
 * a shutting-down worker, an enqueue whose job never reached the queue, and
 * the worker's refusal to start a locked firm's run. `inTenant` is the
 * transaction runner (withTenantContext; the check script passes PGlite's).
 */
export async function failUnfinishedSkillRun(
  params: {
    tenantId: string;
    skillRunId: string;
    fromStatuses: UnfinishedStatus[];
    errorMessage: string;
    actor: string;
    reason: SkillRunFailureReason;
  },
  inTenant: TenantTransactionRunner = withTenantContext
): Promise<boolean> {
  const { tenantId, skillRunId } = params;
  return inTenant(tenantId, async (tx) => {
    const [current] = await tx
      .select({
        status: skillRuns.status,
        matterId: skillRuns.matterId,
        skillName: skillRuns.skillName,
        skillVersion: skillRuns.skillVersion,
        requestedBy: skillRuns.requestedBy,
      })
      .from(skillRuns)
      .where(
        and(
          eq(skillRuns.id, skillRunId),
          eq(skillRuns.tenantId, tenantId),
          inArray(skillRuns.status, params.fromStatuses)
        )
      )
      .limit(1)
      .for("update");
    if (!current) return false;

    await tx
      .update(skillRuns)
      .set({ status: "failed", errorMessage: params.errorMessage, completedAt: new Date() })
      .where(and(eq(skillRuns.id, skillRunId), eq(skillRuns.tenantId, tenantId)));

    await recordAuditEvent(tx, {
      tenantId,
      actorUserId: params.actor,
      action: AUDIT_ACTIONS.skillRunFailed,
      resourceType: "skill_run",
      resourceId: skillRunId,
      before: { status: current.status },
      after: {
        status: "failed",
        reason: params.reason,
        matterId: current.matterId,
        skillName: current.skillName,
        skillVersion: current.skillVersion,
        requestedBy: current.requestedBy,
      },
    });
    return true;
  });
}
