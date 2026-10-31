// How /library labels a source and a group: one status from the stored
// standing (library_sources.status), the time since the last successful
// run against the source's staleness threshold, and the backfill's progress.
// Pure, so the page and anything else can share the wording.

import type { LibraryGroup } from "./groups";

export type StatusTone = "green" | "amber" | "red" | "gray";
export type StatusBadge = { label: string; tone: StatusTone; detail?: string | null };

export type SourceStatusInput = {
  status: string;
  stale: boolean;
  lastSuccessAt: Date | null;
  statusDetail: string | null;
  lastError: string | null;
  freshness: Record<string, unknown>;
};

/**
 * A source kept up to date by import from the official site (status
 * "manual", LIBRARY_MANUAL_SOURCES): its expected interval, its last stored
 * import, and whether it is overdue (no import within the interval: the
 * source's staleness threshold is the interval, ./store.ts syncSources).
 * Null for any other source.
 */
export function manualImportStatus(source: SourceStatusInput): { intervalDays: number | null; lastImportAt: Date | null; overdue: boolean } | null {
  if (source.status !== "manual") return null;
  const days = Number((source.freshness.manualImport as { intervalDays?: unknown } | null | undefined)?.intervalDays);
  const at = (source.freshness.lastManualImport as { at?: unknown } | undefined)?.at;
  const lastImportAt = typeof at === "string" && !Number.isNaN(Date.parse(at)) ? new Date(at) : null;
  return { intervalDays: Number.isFinite(days) && days > 0 ? days : null, lastImportAt, overdue: source.stale };
}

export function sourceBadge(source: SourceStatusInput): StatusBadge {
  switch (source.status) {
    case "manual": {
      const manual = manualImportStatus(source)!;
      const every = manual.intervalDays ? `about every ${manual.intervalDays} days` : "regularly";
      const last = manual.lastImportAt ? `last imported ${manual.lastImportAt.toISOString().slice(0, 10)}` : "not imported yet";
      const detail = `The official site refuses automated tools; staff import it from the official site ${every} (${last}).`;
      return manual.overdue ? { label: "Manual import overdue", tone: "amber", detail } : { label: "Manual import", tone: "green", detail };
    }
    case "needs_key":
      return { label: "Needs API key", tone: "amber", detail: source.statusDetail };
    case "disabled":
      return { label: "Turned off", tone: "gray", detail: source.statusDetail };
    case "failed":
      return { label: "Last update failed", tone: "red", detail: source.lastError };
    case "pending":
      return { label: "Not yet updated", tone: "gray", detail: "The first daily run has not finished yet." };
    case "partial":
      return source.stale
        ? { label: "Stale", tone: "amber", detail: source.lastError }
        : { label: "Partly updated", tone: "amber", detail: source.lastError };
    default:
      return source.stale ? { label: "Stale", tone: "amber", detail: "The last successful update is older than this source's refresh interval." } : { label: "Up to date", tone: "green" };
  }
}

/** Whether the source's history (backfill) is still being collected. */
export function backfillInProgress(source: SourceStatusInput): boolean {
  const backfill = source.freshness.backfill as { status?: unknown } | undefined;
  return backfill?.status !== undefined && backfill.status !== "complete";
}

const SEVERITY: Record<StatusTone, number> = { red: 3, amber: 2, gray: 1, green: 0 };

/** One badge for a group: planned, not yet collected, or its sources' worst standing. */
export function groupBadge(group: LibraryGroup, sources: SourceStatusInput[]): StatusBadge {
  if (group.planned) return { label: "Planned", tone: "gray", detail: group.planned };
  if (sources.length === 0) return { label: "Not yet collected", tone: "gray", detail: "No collector for this group is installed yet." };
  const badges = sources.map(sourceBadge);
  const worst = badges.reduce((a, b) => (SEVERITY[b.tone] > SEVERITY[a.tone] ? b : a));
  if (worst.tone === "green") return { label: "Up to date", tone: "green" };
  return sources.length > 1 ? { ...worst, label: `${worst.label} (${badges.filter((b) => b.label === worst.label).length} of ${sources.length} sources)` } : worst;
}
