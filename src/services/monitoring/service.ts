import "server-only";
import { and, desc, eq, gte, inArray, isNull, notExists, sql, type SQL } from "drizzle-orm";
import { withTenantContext } from "@/db/client";
import { legalUpdateReviews, legalUpdateRuns, legalUpdates, legalUpdateSourceChecks } from "@/db/schema";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";
import type { MembershipRole } from "@/lib/tenant";
import { enqueueLegalUpdateCheck } from "@/services/queue/monitoring-jobs";
import { sourceKeysInGroup, sourceLabel, type SourceGroup } from "./sources";
import { effectiveDate } from "./sql";
import type { DocumentQuote, LegalUpdateAnalysis } from "./types";

// What the app's /updates page and its actions use from the legal-update
// monitor (the skill runner's side is ./skill-runs.ts). legal_updates and its
// run tables are global (any context may read them, only the monitor writes
// them); reads here still go through the caller's tenant context, alongside
// the firm's own reviews.

/** Who may mark an item reviewed: the firm's lawyers and administrators. */
export const LEGAL_UPDATE_REVIEW_ROLES: readonly MembershipRole[] = ["owner_admin", "attorney"];
/** Who may start a check of every source outside the daily schedule. */
export const LEGAL_UPDATE_CHECK_ROLES: readonly MembershipRole[] = ["owner_admin"];

export const REVIEW_NOTE_MAX_CHARS = 4000;
/** The unreviewed count covers items retrieved this many days back. */
export const UNREVIEWED_WINDOW_DAYS = 90;
const PAGE_LIMIT = 100;

/** Statuses shown as legal updates (new items; baseline, screened and duplicate rows are not). */
const FEED_STATUSES = ["published", "summary_failed", "pending_summary"] as const;

export class LegalUpdateRequestError extends Error {}

export type LegalUpdateView = "unreviewed" | "all" | "screened";

export type LegalUpdateListItem = {
  id: string;
  source: string;
  sourceLabel: string;
  itemType: string;
  title: string;
  citation: string | null;
  officialUrl: string;
  listedOnUrl: string;
  publishedDateText: string | null;
  retrievedAt: Date;
  rawExcerpt: string;
  documentQuotes: DocumentQuote[];
  listingFacts: Record<string, string>;
  courtWeight: string | null;
  aiSummary: string | null;
  status: (typeof legalUpdates.$inferSelect)["status"];
  statusReason: string | null;
  affectedSkills: string[];
  analysis: Partial<LegalUpdateAnalysis> | null;
  isRevision: boolean;
  review: { reviewedBy: string; reviewedAt: Date; note: string | null } | null;
};

function sinceDate(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The /updates list for one firm, newest first, with the firm's review of each item. */
export async function listLegalUpdatesForTenant(
  tenantId: string,
  filters: { view: LegalUpdateView; group?: SourceGroup | null; skill?: string | null }
): Promise<LegalUpdateListItem[]> {
  return withTenantContext(tenantId, async (tx) => {
    const conditions: SQL[] = [
      filters.view === "screened" ? eq(legalUpdates.status, "screened") : inArray(legalUpdates.status, [...FEED_STATUSES]),
    ];
    if (filters.group === "library") conditions.push(sql`${legalUpdates.source} like 'library:%'`);
    else if (filters.group) conditions.push(inArray(legalUpdates.source, sourceKeysInGroup(filters.group)));
    if (filters.skill) conditions.push(sql`${legalUpdates.affectedSkills} @> array[${filters.skill}]::text[]`);
    // The same window as the unreviewed count, so the badge and this view agree.
    if (filters.view === "unreviewed") {
      conditions.push(isNull(legalUpdateReviews.id), gte(effectiveDate, sinceDate(UNREVIEWED_WINDOW_DAYS)));
    }
    const rows = await tx
      .select({ item: legalUpdates, review: legalUpdateReviews })
      .from(legalUpdates)
      .leftJoin(
        legalUpdateReviews,
        and(eq(legalUpdateReviews.legalUpdateId, legalUpdates.id), eq(legalUpdateReviews.tenantId, tenantId))
      )
      .where(and(...conditions))
      .orderBy(desc(effectiveDate), desc(legalUpdates.retrievedAt))
      .limit(PAGE_LIMIT);
    return rows.map(({ item, review }) => ({
      id: item.id,
      source: item.source,
      sourceLabel: sourceLabel(item.source, item.listingFacts),
      itemType: item.itemType,
      title: item.title,
      citation: item.citation,
      officialUrl: item.officialUrl,
      listedOnUrl: item.listedOnUrl,
      publishedDateText: item.publishedDateText,
      retrievedAt: item.retrievedAt,
      rawExcerpt: item.rawExcerpt,
      documentQuotes: Array.isArray(item.documentQuotes) ? (item.documentQuotes as DocumentQuote[]) : [],
      listingFacts: (item.listingFacts as Record<string, string> | null) ?? {},
      courtWeight: item.courtWeight,
      aiSummary: item.aiSummary,
      status: item.status,
      statusReason: item.statusReason,
      affectedSkills: item.affectedSkills,
      analysis: (item.analysis as Partial<LegalUpdateAnalysis> | null) ?? null,
      isRevision: item.revisionOf !== null,
      review: review ? { reviewedBy: review.reviewedBy, reviewedAt: review.reviewedAt, note: review.note } : null,
    }));
  });
}

/**
 * New legal updates of the last 90 days (by the date the source states, or
 * the day retrieved) that no one at the firm has marked reviewed: the number
 * for a nav badge.
 */
export async function countUnreviewedLegalUpdates(tenantId: string): Promise<number> {
  return withTenantContext(tenantId, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(legalUpdates)
      .where(
        and(
          inArray(legalUpdates.status, [...FEED_STATUSES]),
          gte(effectiveDate, sinceDate(UNREVIEWED_WINDOW_DAYS)),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(legalUpdateReviews)
              .where(and(eq(legalUpdateReviews.tenantId, tenantId), eq(legalUpdateReviews.legalUpdateId, legalUpdates.id)))
          )
        )
      );
    return row?.n ?? 0;
  });
}

/**
 * Records that a firm attorney reviewed an item, with an optional note (a
 * later review replaces the note). Audited in the same transaction; the
 * audit entry records whether a note was given, never the note itself,
 * since notes may name the firm's clients or matters.
 */
export async function markLegalUpdateReviewed(
  tenantId: string,
  userId: string,
  legalUpdateId: string,
  note: string | null
): Promise<{ reviewedAt: Date }> {
  const trimmed = note?.trim() ?? "";
  if (trimmed.length > REVIEW_NOTE_MAX_CHARS) {
    throw new LegalUpdateRequestError(`The note is longer than ${REVIEW_NOTE_MAX_CHARS} characters.`);
  }
  return withTenantContext(tenantId, async (tx) => {
    const [item] = await tx
      .select({ id: legalUpdates.id, status: legalUpdates.status })
      .from(legalUpdates)
      .where(eq(legalUpdates.id, legalUpdateId))
      .limit(1);
    const reviewable = item && ((FEED_STATUSES as readonly string[]).includes(item.status) || item.status === "screened");
    if (!item || !reviewable) {
      throw new LegalUpdateRequestError("That legal update was not found.");
    }
    const [existing] = await tx
      .select({ id: legalUpdateReviews.id })
      .from(legalUpdateReviews)
      .where(and(eq(legalUpdateReviews.tenantId, tenantId), eq(legalUpdateReviews.legalUpdateId, legalUpdateId)))
      .limit(1);
    const reviewedAt = new Date();
    const [saved] = await tx
      .insert(legalUpdateReviews)
      .values({ tenantId, legalUpdateId, reviewedBy: userId, note: trimmed || null, reviewedAt })
      .onConflictDoUpdate({
        target: [legalUpdateReviews.tenantId, legalUpdateReviews.legalUpdateId],
        set: { reviewedBy: userId, note: trimmed || null, reviewedAt },
      })
      .returning({ id: legalUpdateReviews.id });
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId: userId,
      action: AUDIT_ACTIONS.legalUpdateReviewed,
      resourceType: "legal_update",
      resourceId: legalUpdateId,
      before: { reviewed: Boolean(existing) },
      after: { reviewed: true, reviewId: saved.id, hasNote: trimmed.length > 0, itemStatus: item.status },
    });
    return { reviewedAt };
  });
}

/**
 * Queues a check of every source now, for an owner/admin. Returns false when
 * a check is already queued or running. The request is audited in the
 * firm's log either way.
 */
export async function requestLegalUpdateCheck(tenantId: string, userId: string): Promise<{ queued: boolean }> {
  return withTenantContext(tenantId, async (tx) => {
    const jobId = await enqueueLegalUpdateCheck("manual");
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId: userId,
      action: AUDIT_ACTIONS.legalUpdateCheckRequested,
      resourceType: "legal_update_run",
      resourceId: jobId ?? "none",
      after: { queued: jobId !== null, reason: jobId ? null : "check_already_queued_or_running" },
    });
    return { queued: jobId !== null };
  });
}

export type MonitorStatus = {
  lastRun: (typeof legalUpdateRuns.$inferSelect) | null;
  lastCompletedRun: (typeof legalUpdateRuns.$inferSelect) | null;
  sources: (typeof legalUpdateSourceChecks.$inferSelect)[];
};

/** The latest run and each source's latest check, for the status panel on /updates. */
export async function getLegalUpdateMonitorStatus(tenantId: string): Promise<MonitorStatus> {
  return withTenantContext(tenantId, async (tx) => {
    const runs = await tx.select().from(legalUpdateRuns).orderBy(desc(legalUpdateRuns.startedAt)).limit(10);
    const sources = await tx
      .selectDistinctOn([legalUpdateSourceChecks.source])
      .from(legalUpdateSourceChecks)
      .orderBy(legalUpdateSourceChecks.source, desc(legalUpdateSourceChecks.startedAt));
    return {
      lastRun: runs[0] ?? null,
      lastCompletedRun: runs.find((r) => r.status === "completed") ?? null,
      sources,
    };
  });
}
