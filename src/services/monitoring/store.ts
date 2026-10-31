import "server-only";
import { and, asc, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { withServiceContext } from "@/db/client";
import { legalUpdateRuns, legalUpdates, legalUpdateSourceChecks } from "@/db/schema";
import type { CollectResult } from "./collectors";
import type { KnownItem, SourceDiff } from "./diff";
import { courtWeightLine } from "./routing";
import { sourceLabel } from "./sources";
import type { LegalUpdateSourceKey } from "./types";

// The monitor's writes. Every one runs in service context (withServiceContext):
// legal_updates and its run tables are global, and their RLS policy
// (0005_legal_updates.sql) lets only service context write them. No tenant
// data is read or written here.

export type RunTrigger = "schedule" | "manual";
export type RunStatus = "running" | "completed" | "failed" | "interrupted";
export type SourceCheckStatus = "baseline" | "ok" | "failed" | "not_checked";

/** A summary is tried this many times (over later runs) before the item stays "summary_failed". */
export const MAX_SUMMARY_ATTEMPTS = 3;

export type RunTotals = {
  sourcesChecked: number;
  sourcesFailed: number;
  sourcesNotChecked: number;
  baselined: number;
  newItems: number;
  revisedItems: number;
  duplicates: number;
  summarized: number;
  screened: number;
  summaryFailed: number;
  leftPending: number;
};

/**
 * Runs still "running" when a new one starts were cut off (the queue runs
 * one check at a time, so none can be live): a worker crash, a deploy, or the
 * job expiring. They are closed as interrupted.
 */
export async function closeInterruptedRuns(): Promise<number> {
  return withServiceContext(async (tx) => {
    const rows = await tx
      .update(legalUpdateRuns)
      .set({
        status: "interrupted",
        finishedAt: new Date(),
        errorMessage: "The check stopped before it finished (worker restart or job expiry). Items it had already recorded were kept.",
      })
      .where(eq(legalUpdateRuns.status, "running"))
      .returning({ id: legalUpdateRuns.id });
    return rows.length;
  });
}

export async function startRun(trigger: RunTrigger, pgBossJobId: string | null): Promise<string> {
  return withServiceContext(async (tx) => {
    const [row] = await tx
      .insert(legalUpdateRuns)
      .values({ trigger, pgBossJobId, status: "running" })
      .returning({ id: legalUpdateRuns.id });
    return row.id;
  });
}

export async function finishRun(runId: string, status: RunStatus, totals: RunTotals, errorMessage?: string): Promise<void> {
  await withServiceContext(async (tx) => {
    await tx
      .update(legalUpdateRuns)
      .set({ status, totals, finishedAt: new Date(), errorMessage: errorMessage ?? null })
      .where(and(eq(legalUpdateRuns.id, runId), eq(legalUpdateRuns.status, "running")));
  });
}

/** Whether the source has had a successful check (its baseline exists), and when it last succeeded. */
export async function loadSourceState(source: LegalUpdateSourceKey): Promise<{ baselineEstablished: boolean; lastSuccessAt: Date | null }> {
  return withServiceContext(async (tx) => {
    const [last] = await tx
      .select({ startedAt: legalUpdateSourceChecks.startedAt })
      .from(legalUpdateSourceChecks)
      .where(and(eq(legalUpdateSourceChecks.source, source), inArray(legalUpdateSourceChecks.status, ["ok", "baseline"])))
      .orderBy(desc(legalUpdateSourceChecks.startedAt))
      .limit(1);
    return { baselineEstablished: Boolean(last), lastSuccessAt: last?.startedAt ?? null };
  });
}

/** Every row stored for the source, oldest first (the diff takes the latest per externalId). */
export async function loadKnownItems(source: LegalUpdateSourceKey): Promise<KnownItem[]> {
  return withServiceContext(async (tx) =>
    tx
      .select({ id: legalUpdates.id, externalId: legalUpdates.externalId, contentHash: legalUpdates.contentHash })
      .from(legalUpdates)
      .where(eq(legalUpdates.source, source))
      .orderBy(asc(legalUpdates.createdAt))
  );
}

/**
 * Records one source's check and the items it found, in one transaction:
 * baseline items as "baseline", new items and revisions as
 * "pending_summary", and a new item another source already listed (same
 * crossSourceKey) as "duplicate". Re-running is safe: an item already
 * stored with the same text is skipped by the unique index.
 */
export async function recordSourceCheck(params: {
  runId: string;
  source: LegalUpdateSourceKey;
  startedAt: Date;
  status: SourceCheckStatus;
  collected?: CollectResult;
  diff?: SourceDiff;
  notes?: string[];
  errorMessage?: string;
}): Promise<{ baselined: number; newItems: number; revisedItems: number; duplicates: number }> {
  return withServiceContext(async (tx) => {
    const counts = { baselined: 0, newItems: 0, revisedItems: 0, duplicates: 0 };
    const retrievedAt = new Date();
    for (const entry of params.diff?.toInsert ?? []) {
      const item = entry.item;
      let status: "baseline" | "pending_summary" | "duplicate" = entry.kind === "baseline" ? "baseline" : "pending_summary";
      let statusReason: string | null = null;
      if (status === "pending_summary" && entry.kind === "new" && item.crossSourceKey) {
        const [other] = await tx
          .select({ source: legalUpdates.source })
          .from(legalUpdates)
          .where(
            and(
              eq(legalUpdates.crossSourceKey, item.crossSourceKey),
              ne(legalUpdates.source, params.source),
              ne(legalUpdates.status, "duplicate")
            )
          )
          .limit(1);
        if (other) {
          status = "duplicate";
          statusReason = `Also listed by ${sourceLabel(other.source)}.`;
        }
      }
      if (status === "pending_summary" && entry.kind === "new") {
        // The library's daily collection may have fed the same document in
        // first (src/services/library/legal-updates.ts); it is matched by
        // its official link, ignoring the scheme and a leading "www.".
        const key = item.officialUrl.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
        const [fed] = await tx
          .select({ source: legalUpdates.source, listingFacts: legalUpdates.listingFacts })
          .from(legalUpdates)
          .where(
            and(
              sql`${legalUpdates.source} like 'library:%'`,
              sql`lower(regexp_replace(regexp_replace(${legalUpdates.officialUrl}, '^https?://(www\\.)?', '', 'i'), '/+$', '')) = ${key}`
            )
          )
          .limit(1);
        if (fed) {
          status = "duplicate";
          statusReason = `Also found by ${sourceLabel(fed.source, fed.listingFacts)}.`;
        }
      }
      const inserted = await tx
        .insert(legalUpdates)
        .values({
          source: params.source,
          externalId: item.externalId,
          crossSourceKey: item.crossSourceKey ?? null,
          itemType: item.itemType,
          title: item.title,
          citation: item.citation ?? null,
          officialUrl: item.officialUrl,
          listedOnUrl: item.listedOnUrl ?? item.officialUrl,
          documentUrl: item.documentUrl ?? null,
          publishedDateText: item.publishedDateText ?? null,
          publishedOn: item.publishedOn ?? null,
          retrievedAt,
          contentHash: entry.contentHash,
          rawExcerpt: item.excerpt,
          listingFacts: item.listingFacts ?? null,
          circuit: item.circuit ?? null,
          courtWeight: item.circuit ? courtWeightLine(item.circuit) : null,
          status,
          statusReason,
          revisionOf: entry.kind === "revision" ? entry.revisionOf : null,
          firstSeenRunId: params.runId,
        })
        .onConflictDoNothing()
        .returning({ id: legalUpdates.id });
      if (inserted.length === 0) continue;
      if (status === "duplicate") counts.duplicates++;
      else if (entry.kind === "baseline") counts.baselined++;
      else if (entry.kind === "revision") counts.revisedItems++;
      else counts.newItems++;
    }
    await tx.insert(legalUpdateSourceChecks).values({
      runId: params.runId,
      source: params.source,
      status: params.status,
      indexUrls: params.collected?.indexUrls ?? [],
      itemsSeen: params.collected?.items.length ?? 0,
      newItems: counts.newItems,
      revisedItems: counts.revisedItems,
      indexContentHash: params.collected?.indexContentHash ?? null,
      notes: [...(params.collected?.notes ?? []), ...(params.diff?.notes ?? []), ...(params.notes ?? [])],
      errorMessage: params.errorMessage ?? null,
      startedAt: params.startedAt,
      finishedAt: new Date(),
    });
    return counts;
  });
}

export type QueuedItem = typeof legalUpdates.$inferSelect;

/** New items waiting for a summary, and failed ones with attempts left, newest first. */
export async function loadSummaryQueue(limit: number): Promise<QueuedItem[]> {
  return withServiceContext(async (tx) =>
    tx
      .select()
      .from(legalUpdates)
      .where(
        or(
          eq(legalUpdates.status, "pending_summary"),
          and(eq(legalUpdates.status, "summary_failed"), lt(legalUpdates.summaryAttempts, MAX_SUMMARY_ATTEMPTS))
        )
      )
      .orderBy(desc(legalUpdates.retrievedAt), sql`${legalUpdates.publishedOn} desc nulls last`)
      .limit(limit)
  );
}

/** How many items still wait for a summary after this run. */
export async function countSummaryBacklog(): Promise<number> {
  return withServiceContext(async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(legalUpdates)
      .where(
        or(
          eq(legalUpdates.status, "pending_summary"),
          and(eq(legalUpdates.status, "summary_failed"), lt(legalUpdates.summaryAttempts, MAX_SUMMARY_ATTEMPTS))
        )
      );
    return row?.n ?? 0;
  });
}

export type SummaryOutcome =
  | {
      status: "published" | "screened";
      statusReason: string | null;
      aiSummary: string;
      summaryModel: string;
      topics: string[];
      affectedSkills: string[];
      analysis: unknown;
      documentQuotes: unknown;
    }
  | { status: "summary_failed"; statusReason: string; documentQuotes?: unknown; analysis?: unknown };

/** Stores a summary step's outcome, only while the item still waits for one. */
export async function saveSummaryOutcome(id: string, outcome: SummaryOutcome): Promise<void> {
  await withServiceContext(async (tx) => {
    const waiting = or(eq(legalUpdates.status, "pending_summary"), eq(legalUpdates.status, "summary_failed"));
    if (outcome.status === "summary_failed") {
      await tx
        .update(legalUpdates)
        .set({
          status: "summary_failed",
          statusReason: outcome.statusReason,
          summaryAttempts: sql`${legalUpdates.summaryAttempts} + 1`,
          ...(outcome.documentQuotes !== undefined ? { documentQuotes: outcome.documentQuotes } : {}),
          ...(outcome.analysis !== undefined ? { analysis: outcome.analysis } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(legalUpdates.id, id), waiting));
      return;
    }
    await tx
      .update(legalUpdates)
      .set({
        status: outcome.status,
        statusReason: outcome.statusReason,
        aiSummary: outcome.aiSummary,
        summaryModel: outcome.summaryModel,
        summarizedAt: new Date(),
        topics: outcome.topics,
        affectedSkills: outcome.affectedSkills,
        analysis: outcome.analysis,
        documentQuotes: outcome.documentQuotes,
        summaryAttempts: sql`${legalUpdates.summaryAttempts} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(legalUpdates.id, id), waiting));
  });
}
