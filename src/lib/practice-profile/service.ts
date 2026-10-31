import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { withTenantContext, type db } from "@/db/client";
import { practiceProfileVersions } from "@/db/schema";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";
import {
  emptyPracticeProfile,
  normalizePracticeProfile,
  readPracticeProfile,
  type PracticeProfile,
} from "./schema";
import { renderPracticeProfileMarkdown } from "./render-markdown";
import { diffPracticeProfiles } from "./diff";
import {
  confirmationBlockers,
  describeEscalationWeakening,
  escalationBaseline,
  findEscalationWeakenings,
  type EscalationWeakening,
} from "./checks";

/** An expected refusal (stale page, validation, unacknowledged weakening); the actions return its message. */
export class PracticeProfileRequestError extends Error {}

// A firm has at most one open version at a time: a draft being edited, or
// the same version once proposed (pending_confirmation). Saving a pending
// version returns it to draft, which withdraws it from confirmation.
const OPEN_STATUSES = ["draft", "pending_confirmation"] as const;

/**
 * Serializes every change to a tenant's profile versions (creating a draft,
 * saving, proposing, confirming) for the rest of the transaction. Each of
 * them reads the versions and then writes based on what it read (one open
 * version, one pending, one active, the reviewed proposal); without the lock
 * a save or proposal committing between a confirmer's read and write would
 * be activated without review. A transaction-level advisory lock, so it is
 * released at commit or rollback and works through Neon's pooler; every read
 * after it sees what the previous holder committed.
 */
async function lockTenantProfile(tx: typeof db, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"practice_profile_versions:" + tenantId}, 0))`);
}

export async function getActiveProfileVersion(tenantId: string) {
  return withTenantContext(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(practiceProfileVersions)
      .where(and(eq(practiceProfileVersions.tenantId, tenantId), eq(practiceProfileVersions.status, "active")))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function getDraftVersion(tenantId: string) {
  return withTenantContext(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(practiceProfileVersions)
      .where(and(eq(practiceProfileVersions.tenantId, tenantId), eq(practiceProfileVersions.status, "draft")))
      .orderBy(desc(practiceProfileVersions.versionNumber))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function getPendingVersion(tenantId: string) {
  return withTenantContext(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(practiceProfileVersions)
      .where(
        and(
          eq(practiceProfileVersions.tenantId, tenantId),
          eq(practiceProfileVersions.status, "pending_confirmation")
        )
      )
      .orderBy(desc(practiceProfileVersions.versionNumber))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function listProfileVersions(tenantId: string) {
  return withTenantContext(tenantId, async (tx) => {
    return tx
      .select()
      .from(practiceProfileVersions)
      .where(eq(practiceProfileVersions.tenantId, tenantId))
      .orderBy(desc(practiceProfileVersions.versionNumber));
  });
}

/**
 * Identifies the exact proposal a confirmer reviewed: the Practice Profile
 * page renders it into the confirm form, and confirmVersion refuses when the
 * stored proposal no longer matches (it was edited and proposed again after
 * the page was opened).
 */
export function proposalFingerprint(renderedMarkdown: string | null): string {
  return createHash("sha256").update(renderedMarkdown ?? "").digest("hex");
}

/**
 * The version to edit: the open draft, else the version waiting for
 * confirmation (so proposing and then editing again keeps the proposed
 * answers), else a fresh draft seeded from the active version, or for a
 * firm's first run an empty profile (the cold-start-interview case).
 */
export async function startOrGetDraft(tenantId: string, userId: string) {
  return withTenantContext(tenantId, async (tx) => {
    // Under the lock, so two tabs opening the editor at once get one draft.
    await lockTenantProfile(tx, tenantId);
    const latestWithStatus = async (status: "draft" | "pending_confirmation" | "active") => {
      const [row] = await tx
        .select()
        .from(practiceProfileVersions)
        .where(and(eq(practiceProfileVersions.tenantId, tenantId), eq(practiceProfileVersions.status, status)))
        .orderBy(desc(practiceProfileVersions.versionNumber))
        .limit(1);
      return row ?? null;
    };
    const existingDraft = await latestWithStatus("draft");
    if (existingDraft) return existingDraft;
    const pending = await latestWithStatus("pending_confirmation");
    if (pending) return pending;

    const active = await latestWithStatus("active");
    const seedProfile = active
      ? readPracticeProfile(active.profileJson) ?? (active.profileJson as PracticeProfile)
      : emptyPracticeProfile();

    const maxVersion = await tx
      .select({ max: sql<number>`coalesce(max(${practiceProfileVersions.versionNumber}), 0)` })
      .from(practiceProfileVersions)
      .where(eq(practiceProfileVersions.tenantId, tenantId));
    const nextVersion = (maxVersion[0]?.max ?? 0) + 1;

    const [row] = await tx
      .insert(practiceProfileVersions)
      .values({
        tenantId,
        versionNumber: nextVersion,
        status: "draft",
        profileJson: seedProfile,
        proposedBy: userId,
      })
      .returning();
    return row;
  });
}

/**
 * Saves in-progress edits to the open version. A pending version goes back
 * to draft (its rendered Markdown and diff are cleared), so it cannot be
 * confirmed until it is proposed again with these edits. Only an open
 * version can be saved: confirmed and superseded versions are history.
 */
export async function saveDraft(tenantId: string, versionId: string, profile: PracticeProfile) {
  const normalized = normalizePracticeProfile(profile);
  return withTenantContext(tenantId, async (tx) => {
    // Waits for a confirmation in progress; once it commits the version is
    // active, not open, and the status condition below refuses the save.
    await lockTenantProfile(tx, tenantId);
    const [row] = await tx
      .update(practiceProfileVersions)
      .set({ profileJson: normalized, status: "draft", diffFromPrevious: null, renderedMarkdown: null })
      .where(
        and(
          eq(practiceProfileVersions.id, versionId),
          eq(practiceProfileVersions.tenantId, tenantId),
          inArray(practiceProfileVersions.status, [...OPEN_STATUSES])
        )
      )
      .returning();
    if (!row) {
      throw new PracticeProfileRequestError(
        "This version is no longer open for editing (it was confirmed or replaced). Reload the page."
      );
    }
    return row;
  });
}

function weakeningRefusal(weakenings: EscalationWeakening[], who: string): PracticeProfileRequestError {
  return new PracticeProfileRequestError(
    `This version weakens an escalation rule: ${weakenings.map(describeEscalationWeakening).join(" ")} Escalation rules are a safety and unauthorized-practice boundary, so ${who} has to tick the acknowledgment first.`
  );
}

/**
 * Saves the edits and moves the version to pending_confirmation in one
 * transaction, recording its diff against the active version and the
 * Markdown skills will read once it is confirmed: the customize skill's
 * "show current -> proposed" step. Refuses while another version is
 * waiting for confirmation, when a confirmation blocker remains (checks.ts),
 * or when the version weakens an escalation rule and the proposer has not
 * acknowledged it; an acknowledged weakening is audited.
 */
export async function proposeDraft(
  tenantId: string,
  versionId: string,
  userId: string,
  profile: PracticeProfile,
  options: { acknowledgeEscalationWeakening: boolean }
) {
  const normalized = normalizePracticeProfile(profile);
  const blockers = confirmationBlockers(normalized);
  if (blockers.length) throw new PracticeProfileRequestError(blockers.join(" "));

  return withTenantContext(tenantId, async (tx) => {
    await lockTenantProfile(tx, tenantId);
    const [target] = await tx
      .select()
      .from(practiceProfileVersions)
      .where(and(eq(practiceProfileVersions.id, versionId), eq(practiceProfileVersions.tenantId, tenantId)))
      .limit(1)
      .for("update");
    if (!target || !(OPEN_STATUSES as readonly string[]).includes(target.status)) {
      throw new PracticeProfileRequestError(
        "This version is no longer open for editing (it was confirmed or replaced). Reload the page."
      );
    }

    const [otherPending] = await tx
      .select({ versionNumber: practiceProfileVersions.versionNumber })
      .from(practiceProfileVersions)
      .where(
        and(
          eq(practiceProfileVersions.tenantId, tenantId),
          eq(practiceProfileVersions.status, "pending_confirmation"),
          ne(practiceProfileVersions.id, versionId)
        )
      )
      .limit(1);
    if (otherPending) {
      throw new PracticeProfileRequestError(
        `Version ${otherPending.versionNumber} is already waiting for confirmation. An owner/admin or attorney confirms it on the Practice Profile page before another version can be proposed.`
      );
    }

    const [active] = await tx
      .select()
      .from(practiceProfileVersions)
      .where(and(eq(practiceProfileVersions.tenantId, tenantId), eq(practiceProfileVersions.status, "active")))
      .limit(1);
    const activeProfile = active ? readPracticeProfile(active.profileJson) : null;

    const weakenings = findEscalationWeakenings(escalationBaseline(activeProfile), normalized.escalationRules);
    if (weakenings.length && !options.acknowledgeEscalationWeakening) {
      throw weakeningRefusal(weakenings, "the person proposing it");
    }

    const diff = diffPracticeProfiles(
      (activeProfile ?? active?.profileJson ?? {}) as Record<string, unknown>,
      normalized as Record<string, unknown>
    );

    const [row] = await tx
      .update(practiceProfileVersions)
      .set({
        status: "pending_confirmation",
        profileJson: normalized,
        diffFromPrevious: diff,
        proposedBy: userId,
        renderedMarkdown: renderPracticeProfileMarkdown(normalized),
      })
      .where(
        and(
          eq(practiceProfileVersions.id, versionId),
          eq(practiceProfileVersions.tenantId, tenantId),
          inArray(practiceProfileVersions.status, [...OPEN_STATUSES])
        )
      )
      .returning();
    if (!row) {
      throw new PracticeProfileRequestError(
        "This version is no longer open for editing (it was confirmed or replaced). Reload the page."
      );
    }

    if (weakenings.length) {
      // Decision names and the kind of change only: firm configuration.
      await recordAuditEvent(tx, {
        tenantId,
        actorUserId: userId,
        action: AUDIT_ACTIONS.practiceProfileEscalationWeakeningAcknowledged,
        resourceType: "practice_profile_version",
        resourceId: versionId,
        after: { stage: "propose", versionNumber: row.versionNumber, weakenings },
      });
    }

    return row;
  });
}

/**
 * Activates a pending_confirmation version: supersedes the current active
 * version (if any) and marks this one active + confirmed. Writes an
 * AuditLog entry (AUDIT_ACTIONS.practiceProfileActivated) in the same
 * transaction so every practice-profile change is reviewable later.
 *
 * Refuses when the proposal changed since the confirmer's page rendered it
 * (expectedFingerprint), when a confirmation blocker remains, or when it
 * weakens an escalation rule against the version it replaces (or, for the
 * first version, against the plugin defaults) and the confirmer has not
 * acknowledged that; the acknowledgment gets its own audit entry.
 */
export async function confirmVersion(
  tenantId: string,
  versionId: string,
  userId: string,
  options: { expectedFingerprint: string; acknowledgeEscalationWeakening: boolean }
) {
  return withTenantContext(tenantId, async (tx) => {
    // Every read below sees what an earlier save, proposal or confirmation
    // committed, and none can commit until this one has.
    await lockTenantProfile(tx, tenantId);
    const [target] = await tx
      .select()
      .from(practiceProfileVersions)
      .where(and(eq(practiceProfileVersions.id, versionId), eq(practiceProfileVersions.tenantId, tenantId)))
      .limit(1)
      .for("update");
    if (!target) throw new PracticeProfileRequestError("That version was not found.");
    if (target.status !== "pending_confirmation") {
      throw new PracticeProfileRequestError(
        `Only a version waiting for confirmation can be activated (this one is ${target.status.replace(/_/g, " ")}). Reload the page.`
      );
    }
    if (proposalFingerprint(target.renderedMarkdown) !== options.expectedFingerprint) {
      throw new PracticeProfileRequestError(
        "This version was changed after you opened the page. Reload and review it again before confirming."
      );
    }
    const reviewedMarkdown = target.renderedMarkdown;
    if (reviewedMarkdown === null) {
      // Skill runs read the rendered Markdown; a version without it would run with no profile.
      throw new PracticeProfileRequestError(
        "This version has no rendered profile. Open it in the editor and propose it again."
      );
    }

    const profile = readPracticeProfile(target.profileJson);
    if (!profile) {
      throw new PracticeProfileRequestError(
        "This version no longer matches the practice profile format. Open it in the editor and propose it again."
      );
    }
    const blockers = confirmationBlockers(profile);
    if (blockers.length) throw new PracticeProfileRequestError(blockers.join(" "));

    const [previousActive] = await tx
      .select()
      .from(practiceProfileVersions)
      .where(and(eq(practiceProfileVersions.tenantId, tenantId), eq(practiceProfileVersions.status, "active")))
      .limit(1);

    const weakenings = findEscalationWeakenings(
      escalationBaseline(previousActive ? readPracticeProfile(previousActive.profileJson) : null),
      profile.escalationRules
    );
    if (weakenings.length && !options.acknowledgeEscalationWeakening) {
      throw weakeningRefusal(weakenings, "the confirming owner/admin or attorney");
    }

    if (previousActive) {
      await tx
        .update(practiceProfileVersions)
        .set({ status: "superseded" })
        .where(
          and(
            eq(practiceProfileVersions.id, previousActive.id),
            eq(practiceProfileVersions.tenantId, tenantId),
            eq(practiceProfileVersions.status, "active")
          )
        );
    }

    // Activates exactly the proposal that was reviewed: still pending, with
    // the Markdown the confirmer's fingerprint covers.
    const [activated] = await tx
      .update(practiceProfileVersions)
      .set({ status: "active", confirmedBy: userId, confirmedAt: new Date() })
      .where(
        and(
          eq(practiceProfileVersions.id, versionId),
          eq(practiceProfileVersions.tenantId, tenantId),
          eq(practiceProfileVersions.status, "pending_confirmation"),
          eq(practiceProfileVersions.renderedMarkdown, reviewedMarkdown)
        )
      )
      .returning();
    if (!activated) {
      throw new PracticeProfileRequestError(
        "This version was changed after you opened the page. Reload and review it again before confirming."
      );
    }

    // The full profile before and after: firm configuration, not client data.
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId: userId,
      action: AUDIT_ACTIONS.practiceProfileActivated,
      resourceType: "practice_profile_version",
      resourceId: versionId,
      before: previousActive?.profileJson ?? null,
      after: activated.profileJson,
    });

    if (weakenings.length) {
      await recordAuditEvent(tx, {
        tenantId,
        actorUserId: userId,
        action: AUDIT_ACTIONS.practiceProfileEscalationWeakeningAcknowledged,
        resourceType: "practice_profile_version",
        resourceId: versionId,
        after: { stage: "confirm", versionNumber: activated.versionNumber, weakenings },
      });
    }

    return activated;
  });
}
