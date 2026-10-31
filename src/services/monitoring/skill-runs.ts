import "server-only";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { withTenantContext, type db } from "@/db/client";
import { legalUpdates } from "@/db/schema";
import {
  RECENT_LEGAL_UPDATES_MAX_ITEMS,
  RECENT_LEGAL_UPDATES_WINDOW_DAYS,
  type RecentLegalUpdate,
  type RecentLegalUpdatesSnapshot,
} from "./prompt-section";
import { effectiveDate } from "./sql";
import { sourceLabel } from "./sources";
import type { AffectedSkillBasis, DocumentQuote, LegalUpdateAnalysis } from "./types";

// The skill runner's side of the legal-update monitor: which published
// updates a run of a skill is shown (its RECENT LEGAL UPDATES prompt section,
// rendered by buildRecentLegalUpdatesSection in ./prompt-section.ts).

/**
 * The published legal updates of the last 90 days that routing matched to a
 * skill, newest first: the snapshot a skill run stores and renders as its
 * RECENT LEGAL UPDATES prompt section (buildRecentLegalUpdatesSection in
 * ./prompt-section.ts). Only "published" items qualify: their summary rests
 * on passages checked against the official text.
 */
export async function loadRecentLegalUpdatesForSkill(
  tenantId: string,
  skillName: string,
  options: {
    /** The caller's withTenantContext transaction for tenantId (enqueueSkillRun's); a new one when absent. */
    tx?: typeof db;
    now?: Date;
    windowDays?: number;
    limit?: number;
  } = {}
): Promise<RecentLegalUpdatesSnapshot> {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? RECENT_LEGAL_UPDATES_WINDOW_DAYS;
  const from = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = (tx: typeof db) =>
    tx
      .select()
      .from(legalUpdates)
      .where(
        and(
          eq(legalUpdates.status, "published"),
          sql`${legalUpdates.affectedSkills} @> array[${skillName}]::text[]`,
          gte(effectiveDate, from)
        )
      )
      .orderBy(desc(effectiveDate), desc(legalUpdates.retrievedAt), legalUpdates.id)
      .limit(options.limit ?? RECENT_LEGAL_UPDATES_MAX_ITEMS);
  const rows = options.tx ? await query(options.tx) : await withTenantContext(tenantId, query);
  const items: RecentLegalUpdate[] = rows.map((row) => {
    const analysis = (row.analysis as Partial<LegalUpdateAnalysis> | null) ?? null;
    const bases: AffectedSkillBasis[] = analysis?.affectedSkillBases ?? [];
    return {
      id: row.id,
      itemType: row.itemType,
      title: row.title,
      citation: row.citation,
      sourceLabel: sourceLabel(row.source, row.listingFacts),
      publishedDateText: row.publishedDateText,
      retrievedOn: row.retrievedAt.toISOString().slice(0, 10),
      officialUrl: row.officialUrl,
      listedOnUrl: row.listedOnUrl,
      courtWeight: row.courtWeight,
      rawExcerpt: row.rawExcerpt,
      documentQuotes: Array.isArray(row.documentQuotes) ? (row.documentQuotes as DocumentQuote[]) : [],
      summary: row.aiSummary ?? "",
      matchedBecause: bases.filter((b) => b.skill === skillName).map((b) => b.basis),
    };
  });
  return { skillName, windowDays, capturedAt: now.toISOString(), items };
}
