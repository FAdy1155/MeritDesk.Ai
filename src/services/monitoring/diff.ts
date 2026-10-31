import crypto from "node:crypto";
import type { ParsedItem } from "./types";

// Detects what is new at a source by comparing what its listing shows now
// with what the monitor stored before: an item is identified by its
// externalId (stable within the source) and versioned by a hash of the
// listing text. Pure, so it can be tested on saved pages.
//
// - First successful check of a source: everything listed is recorded as
//   "baseline" (already published before the monitor watched), so turning
//   the monitor on never floods firms with a backlog.
// - Afterwards: an unseen externalId is new; a known one whose text changed
//   is a revision (a corrected headnote, a reissued opinion), stored as a new
//   row pointing at the earlier one.
// - Flood guard: when the text of many known items changes at once, the page
//   was reformatted (or the parser changed), not revised item by item; those
//   changes are not reported as revisions, and the check says so.

/** A row already stored for the source (oldest first). */
export type KnownItem = { id: string; externalId: string; contentHash: string };

export type DiffEntry =
  | { kind: "baseline"; item: ParsedItem; contentHash: string }
  | { kind: "new"; item: ParsedItem; contentHash: string }
  | { kind: "revision"; item: ParsedItem; contentHash: string; revisionOf: string };

export type SourceDiff = {
  toInsert: DiffEntry[];
  unchanged: number;
  /** Revisions not reported because too many known items changed at once. */
  suppressedRevisions: number;
  notes: string[];
};

/** Revisions in one check above max(this, REVISION_FLOOD_SHARE of the known items listed) trip the flood guard. */
export const REVISION_FLOOD_MIN = 5;
export const REVISION_FLOOD_SHARE = 0.3;
/** More new items than this in one check is called out in the check's notes (they are all still stored). */
export const NEW_ITEMS_NOTICE_THRESHOLD = 30;

function normalizeField(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

/** sha256 over the item's listed text: title, citation, link, stated date and excerpt. */
export function contentHashFor(item: ParsedItem): string {
  const fields = [item.title, item.citation, item.officialUrl, item.publishedDateText, item.excerpt].map(normalizeField);
  return crypto.createHash("sha256").update(fields.join("\u0000")).digest("hex");
}

/** sha256 of a listing's visible text (whitespace normalized). */
export function listingHash(text: string): string {
  return crypto.createHash("sha256").update(normalizeField(text)).digest("hex");
}

export function diffSourceItems(params: {
  current: readonly ParsedItem[];
  known: readonly KnownItem[];
  baselineEstablished: boolean;
}): SourceDiff {
  const notes: string[] = [];

  // One entry per externalId: a listing that shows the same item twice
  // (two docket numbers on one opinion, a repeated row) keeps the first.
  const current: ParsedItem[] = [];
  const seenIds = new Set<string>();
  let repeated = 0;
  for (const item of params.current) {
    if (seenIds.has(item.externalId)) {
      repeated++;
      continue;
    }
    seenIds.add(item.externalId);
    current.push(item);
  }
  if (repeated) notes.push(`${repeated} repeated listing row(s) were read once.`);

  const knownById = new Map<string, KnownItem[]>();
  for (const row of params.known) {
    const rows = knownById.get(row.externalId) ?? [];
    rows.push(row);
    knownById.set(row.externalId, rows);
  }

  const toInsert: DiffEntry[] = [];
  const revisions: DiffEntry[] = [];
  let unchanged = 0;
  let knownListed = 0;
  for (const item of current) {
    const contentHash = contentHashFor(item);
    const rows = knownById.get(item.externalId);
    if (rows) knownListed++;
    if (rows?.some((r) => r.contentHash === contentHash)) {
      unchanged++;
      continue;
    }
    if (!params.baselineEstablished) {
      toInsert.push({ kind: "baseline", item, contentHash });
    } else if (!rows) {
      toInsert.push({ kind: "new", item, contentHash });
    } else {
      revisions.push({ kind: "revision", item, contentHash, revisionOf: rows[rows.length - 1].id });
    }
  }

  let suppressedRevisions = 0;
  const floodLimit = Math.max(REVISION_FLOOD_MIN, Math.ceil(knownListed * REVISION_FLOOD_SHARE));
  if (revisions.length > floodLimit) {
    suppressedRevisions = revisions.length;
    notes.push(
      `The listed text of ${revisions.length} already-known item(s) changed at once, which points to a page format change rather than revised items; they were not reported as revisions. Compare the source page by hand if in doubt.`
    );
  } else {
    toInsert.push(...revisions);
  }

  const newCount = toInsert.filter((e) => e.kind === "new").length;
  if (newCount > NEW_ITEMS_NOTICE_THRESHOLD) {
    notes.push(
      `${newCount} new items appeared in one check (a long gap since the last successful check, or a change in how the source identifies items); all were recorded, and summaries are spread over later runs.`
    );
  }
  return { toInsert, unchanged, suppressedRevisions, notes };
}
