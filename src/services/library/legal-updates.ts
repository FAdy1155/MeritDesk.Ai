import { eq, or, sql } from "drizzle-orm";
import { legalUpdates } from "@/db/schema";
import { contentHashFor } from "@/services/monitoring/diff";
import { courtWeightLine } from "@/services/monitoring/routing";
import type { ParsedItem } from "@/services/monitoring/types";
import type { LibraryDb } from "./db";
import type { PreparedDocument } from "./prepare";
import { excerpt as cutExcerpt } from "./text";
import type { LibraryLegalUpdateItem, LibrarySourceAdapter } from "./types";

// The library's feed into legal_updates (/updates, and the RECENT LEGAL
// UPDATES section of skill runs). A source whose adapter defines
// legalUpdateItem (precedents, opinions, USCIS and EOIR policy, forms, TPS,
// the Federal Register, the Visa Bulletin) adds each document a daily run
// finds for the first time, after that source's first successful daily run
// (the baseline; backfill never feeds the list). The row waits as
// pending_summary for the legal-update check, which summarizes it from the
// quoted text like any other item.
//
// Deduplicated against what the legal-update monitor already recorded: the
// same official URL (as an item's official or document link, ignoring the
// scheme and a leading "www.") or the same cross-source key ("intdec:4259")
// means the item is already on the list, and nothing is added. The monitor
// does the same in reverse (src/services/monitoring/store.ts).

/** Source keys of library-fed rows in legal_updates: "library:<adapter code>". */
export const LIBRARY_LEGAL_UPDATE_PREFIX = "library:";

/** The excerpt the summary step works from, at most this long. */
const MAX_EXCERPT_CHARS = 8_000;

function urlKey(url: string): string {
  return url.trim().replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
}

export type FeedOutcome = "inserted" | "duplicate";

export async function feedLegalUpdate(
  tx: LibraryDb,
  params: {
    adapter: LibrarySourceAdapter;
    documentId: string;
    doc: PreparedDocument;
    item: LibraryLegalUpdateItem;
  }
): Promise<FeedOutcome> {
  const { adapter, doc, item } = params;
  const urls = [doc.officialUrl, doc.originalUrl].filter((u): u is string => Boolean(u)).map(urlKey);
  const matchUrl = (column: typeof legalUpdates.officialUrl | typeof legalUpdates.documentUrl) =>
    sql`lower(regexp_replace(regexp_replace(${column}, '^https?://(www\\.)?', '', 'i'), '/+$', '')) in (${sql.join(
      urls.map((u) => sql`${u}`),
      sql`, `
    )})`;
  const [existing] = await tx
    .select({ id: legalUpdates.id })
    .from(legalUpdates)
    .where(
      or(
        matchUrl(legalUpdates.officialUrl),
        matchUrl(legalUpdates.documentUrl),
        item.crossSourceKey ? eq(legalUpdates.crossSourceKey, item.crossSourceKey) : undefined
      )
    )
    .limit(1);
  if (existing) return "duplicate";

  const source = `${LIBRARY_LEGAL_UPDATE_PREFIX}${adapter.code}`;
  const text =
    item.excerpt?.trim() ||
    [typeof doc.metadata.summary === "string" ? doc.metadata.summary : null, doc.text].filter(Boolean).join("\n\n");
  const rawExcerpt = cutExcerpt(text || doc.title, MAX_EXCERPT_CHARS);
  const parsed: ParsedItem = {
    externalId: doc.externalId,
    crossSourceKey: item.crossSourceKey ?? null,
    itemType: item.itemType,
    title: doc.title,
    citation: doc.citations[0] ?? null,
    officialUrl: doc.officialUrl,
    publishedDateText: item.publishedDateText ?? null,
    excerpt: rawExcerpt,
  };
  const inserted = await tx
    .insert(legalUpdates)
    .values({
      source,
      externalId: doc.externalId,
      crossSourceKey: item.crossSourceKey ?? null,
      itemType: item.itemType,
      title: doc.title,
      citation: doc.citations.join("; ") || null,
      officialUrl: doc.officialUrl,
      listedOnUrl: item.listedOnUrl ?? adapter.officialUrl,
      documentUrl: null,
      publishedDateText: item.publishedDateText ?? null,
      publishedOn: doc.decisionDate ?? doc.publishedDate ?? doc.effectiveDate ?? null,
      retrievedAt: new Date(),
      contentHash: contentHashFor(parsed),
      rawExcerpt,
      listingFacts: { librarySource: adapter.name, libraryDocumentId: params.documentId },
      circuit: item.circuit ?? null,
      courtWeight: item.circuit ? courtWeightLine(item.circuit) : null,
      status: "pending_summary",
    })
    .onConflictDoNothing()
    .returning({ id: legalUpdates.id });
  return inserted.length > 0 ? "inserted" : "duplicate";
}

/** Whether a legal_updates row came from the library's feed. */
export function isLibraryLegalUpdateSource(source: string): boolean {
  return source.startsWith(LIBRARY_LEGAL_UPDATE_PREFIX);
}
