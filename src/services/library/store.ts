import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  libraryBackfillState,
  libraryCitations,
  libraryDocuments,
  libraryDocumentVersions,
  libraryFetchRuns,
  libraryHttpCache,
  libraryImportLog,
  librarySources,
} from "@/db/schema";
import type { LibraryDb } from "./db";
import { redactUrl } from "./http/fetch";
import type { PreparedDocument } from "./prepare";
import type { KnownFetch, LibraryHttpResponse, LibrarySourceAdapter } from "./types";

// The library's writes, each taking the transaction it runs in (the
// pipeline opens them with withServiceContext, the only context RLS lets
// write these tables; the PGlite check opens its own). Global data only:
// nothing here reads or writes a tenant table.

export type RunKind = "daily" | "backfill" | "manual_import";
export type RunStatus = "running" | "completed" | "partial" | "failed" | "skipped" | "interrupted";

export type RunCounts = {
  listed: number;
  skippedUnchanged: number;
  fetched: number;
  notModified: number;
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
  skipped: number;
  withdrawn: number;
  legalUpdates: number;
};

export function emptyCounts(): RunCounts {
  return { listed: 0, skippedUnchanged: 0, fetched: 0, notModified: 0, inserted: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0, withdrawn: 0, legalUpdates: 0 };
}

export type RunFailure = { externalId: string; url: string; error: string };

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** The statuses syncSources sets from the deployment's settings; a source no longer in one goes back to pending. */
const SETTING_STATUSES = sql`('needs_key', 'disabled', 'manual')`;

/**
 * Upserts one library_sources row per registered adapter (display text,
 * license) and its standing in this deployment: needs_key when an API key is
 * missing, disabled when LIBRARY_DISABLED_SOURCES names it, manual when
 * LIBRARY_MANUAL_SOURCES does (its staleness threshold is then its
 * manualImportIntervalDays, so a source not imported within that reads as
 * stale everywhere and overdue on /library), otherwise back to pending if it
 * was one of these. Counts, dates and errors are left alone.
 */
export async function syncSources(
  tx: LibraryDb,
  adapters: readonly { adapter: LibrarySourceAdapter; missingEnv: string[]; disabled: boolean; manual?: boolean }[]
): Promise<void> {
  for (const { adapter, missingEnv, disabled, manual } of adapters) {
    const manualDays = manual && adapter.manualImportIntervalDays ? adapter.manualImportIntervalDays : null;
    const status = disabled ? "disabled" : missingEnv.length ? "needs_key" : manualDays ? "manual" : null;
    const detail = disabled
      ? "Turned off in this deployment (LIBRARY_DISABLED_SOURCES)."
      : missingEnv.length
        ? `Needs ${missingEnv.join(" and ")} to run; set it in the worker's environment.`
        : manualDays
          ? `The official site refuses automated tools, so this source is kept up to date by import from the official site, about every ${manualDays} days; its daily run is skipped (LIBRARY_MANUAL_SOURCES).`
          : null;
    const freshness = {
      staleAfterHours: manualDays ? manualDays * 24 : (adapter.staleAfterHours ?? 48),
      manualImport: manualDays ? { intervalDays: manualDays } : null,
    };
    const display = {
      groupCode: adapter.group,
      name: adapter.name,
      description: adapter.description,
      coverage: adapter.coverage,
      cadence: adapter.cadence,
      officialUrl: adapter.officialUrl,
      license: adapter.license,
      licenseNote: adapter.licenseNote ?? null,
      updatedAt: new Date(),
    };
    await tx
      .insert(librarySources)
      .values({ code: adapter.code, ...display, status: status ?? "pending", statusDetail: detail, freshness })
      .onConflictDoUpdate({
        target: librarySources.code,
        set: {
          ...display,
          status: status
            ? status
            : sql`case when ${librarySources.status} in ${SETTING_STATUSES} then 'pending'::library_source_status else ${librarySources.status} end`,
          statusDetail: status
            ? detail
            : sql`case when ${librarySources.status} in ${SETTING_STATUSES} then null else ${librarySources.statusDetail} end`,
          freshness: sql`${librarySources.freshness} || ${JSON.stringify(freshness)}::jsonb`,
        },
      });
  }
}

export type SourceRow = typeof librarySources.$inferSelect;

export async function loadSource(tx: LibraryDb, code: string): Promise<SourceRow | null> {
  const [row] = await tx.select().from(librarySources).where(eq(librarySources.code, code)).limit(1);
  return row ?? null;
}

/** Records a run's outcome on the source: status, dates, error, document count, freshness. */
export async function updateSourceAfterRun(
  tx: LibraryDb,
  params: {
    code: string;
    kind: RunKind;
    status: RunStatus;
    startedAt: Date;
    finishedAt: Date;
    counts: RunCounts;
    errorMessage: string | null;
    /** The source needs an API key it does not have (status needs_key). */
    needsKey?: string | null;
    backfill?: { status: string; documentsDone: number } | null;
  }
): Promise<void> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(libraryDocuments)
    .where(and(eq(libraryDocuments.sourceCode, params.code), isNull(libraryDocuments.withdrawnAt)));
  const [{ latest }] = await tx
    .select({ latest: sql<string | null>`max(coalesce(${libraryDocuments.decisionDate}, ${libraryDocuments.publishedDate}, ${libraryDocuments.effectiveDate}))::text` })
    .from(libraryDocuments)
    .where(eq(libraryDocuments.sourceCode, params.code));
  const freshness: Record<string, unknown> = { latestDocumentDate: latest };
  if (params.kind === "daily") {
    freshness.lastDailyRun = { at: params.finishedAt.toISOString(), status: params.status, counts: params.counts };
  } else if (params.backfill) {
    freshness.backfill = { ...params.backfill, at: params.finishedAt.toISOString() };
  }

  const set: Partial<typeof librarySources.$inferInsert> & Record<string, unknown> = {
    documentCount: n,
    lastAttemptAt: params.finishedAt,
    updatedAt: new Date(),
    freshness: sql`${librarySources.freshness} || ${JSON.stringify(freshness)}::jsonb`,
  };
  if (params.needsKey) {
    set.status = "needs_key";
    set.statusDetail = params.needsKey;
  } else if (params.kind === "daily") {
    // The source's standing follows its daily runs; backfill problems show on the run and in freshness.backfill.
    if (params.status === "completed") {
      set.status = "ok";
      set.statusDetail = null;
      set.lastSuccessAt = params.startedAt;
      set.lastError = null;
    } else if (params.status === "partial") {
      set.status = "partial";
      set.statusDetail = params.errorMessage;
      set.lastError = params.errorMessage;
    } else if (params.status === "failed") {
      set.status = "failed";
      set.statusDetail = null;
      set.lastError = params.errorMessage;
    }
  }
  await tx.update(librarySources).set(set).where(eq(librarySources.code, params.code));
}

/** The first successful daily run is the baseline: documents found after it feed legal updates. */
export async function markLegalUpdatesBaseline(tx: LibraryDb, code: string, at: Date): Promise<void> {
  await tx
    .update(librarySources)
    .set({ legalUpdatesBaselineAt: at })
    .where(and(eq(librarySources.code, code), isNull(librarySources.legalUpdatesBaselineAt)));
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * Runs of this source and kind still "running" when a new one starts were
 * cut off (the queue runs one per source and kind): closed as interrupted.
 */
export async function closeInterruptedRuns(tx: LibraryDb, code: string, kind: RunKind): Promise<number> {
  const rows = await tx
    .update(libraryFetchRuns)
    .set({ status: "interrupted", finishedAt: new Date(), errorMessage: "The run stopped before it finished (worker restart or job expiry). Documents it had stored were kept." })
    .where(and(eq(libraryFetchRuns.sourceCode, code), eq(libraryFetchRuns.kind, kind), eq(libraryFetchRuns.status, "running")))
    .returning({ id: libraryFetchRuns.id });
  return rows.length;
}

export async function startRun(
  tx: LibraryDb,
  params: { code: string; kind: RunKind; pgBossJobId: string | null; cursorBefore?: unknown; status?: RunStatus }
): Promise<{ id: string; startedAt: Date }> {
  const [row] = await tx
    .insert(libraryFetchRuns)
    .values({
      sourceCode: params.code,
      kind: params.kind,
      status: params.status ?? "running",
      pgBossJobId: params.pgBossJobId,
      cursorBefore: params.cursorBefore ?? null,
    })
    .returning({ id: libraryFetchRuns.id, startedAt: libraryFetchRuns.startedAt });
  return row;
}

export async function finishRun(
  tx: LibraryDb,
  runId: string,
  params: { status: RunStatus; counts: RunCounts; notes: string[]; failures: RunFailure[]; errorMessage: string | null; cursorAfter?: unknown }
): Promise<Date> {
  const finishedAt = new Date();
  await tx
    .update(libraryFetchRuns)
    .set({
      status: params.status,
      counts: params.counts,
      notes: params.notes,
      failures: params.failures,
      errorMessage: params.errorMessage,
      cursorAfter: params.cursorAfter ?? null,
      finishedAt,
    })
    .where(and(eq(libraryFetchRuns.id, runId), eq(libraryFetchRuns.status, "running")));
  return finishedAt;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type KnownDocument = {
  id: string;
  externalId: string;
  listingFingerprint: string | null;
  withdrawnAt: Date | null;
  /** When the stored copy was last fetched (or confirmed with a 304). */
  lastFetchedAt: Date | null;
  known: KnownFetch | null;
  /** The stored original file's sha256, when one is stored. */
  originalSha256: string | null;
};

/** What is stored for these external ids: enough to skip unchanged refs and send conditional requests. */
export async function loadKnownDocuments(tx: LibraryDb, code: string, externalIds: string[]): Promise<Map<string, KnownDocument>> {
  const out = new Map<string, KnownDocument>();
  for (let i = 0; i < externalIds.length; i += 500) {
    const batch = externalIds.slice(i, i + 500);
    const rows = await tx
      .select({
        id: libraryDocuments.id,
        externalId: libraryDocuments.externalId,
        listingFingerprint: libraryDocuments.listingFingerprint,
        withdrawnAt: libraryDocuments.withdrawnAt,
        fetchInfo: libraryDocuments.fetchInfo,
        originalSha256: libraryDocuments.originalSha256,
        originalS3Key: libraryDocuments.originalS3Key,
      })
      .from(libraryDocuments)
      .where(and(eq(libraryDocuments.sourceCode, code), inArray(libraryDocuments.externalId, batch)));
    for (const row of rows) {
      const info = (row.fetchInfo ?? {}) as Record<string, unknown>;
      const checked = typeof info.checkedAt === "string" ? info.checkedAt : typeof info.retrievedAt === "string" ? info.retrievedAt : null;
      const finalUrl = typeof info.finalUrl === "string" ? info.finalUrl : null;
      out.set(row.externalId, {
        id: row.id,
        externalId: row.externalId,
        listingFingerprint: row.listingFingerprint,
        withdrawnAt: row.withdrawnAt,
        lastFetchedAt: checked ? new Date(checked) : null,
        known:
          finalUrl && (info.etag || info.lastModified)
            ? { url: finalUrl, etag: (info.etag as string | null) ?? null, lastModified: (info.lastModified as string | null) ?? null }
            : null,
        originalSha256: row.originalS3Key ? row.originalSha256 : null,
      });
    }
  }
  return out;
}

/** Listed documents skipped as unchanged: still listed, so their check time moves. */
export async function touchListed(tx: LibraryDb, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 500) {
    await tx.update(libraryDocuments).set({ lastCheckedAt: new Date() }).where(inArray(libraryDocuments.id, ids.slice(i, i + 500)));
  }
}

/** A listed document was skipped as unchanged, or a conditional GET said it is current. */
export async function touchDocument(tx: LibraryDb, id: string, params: { confirmedByFetch: boolean; listingFingerprint?: string | null }): Promise<void> {
  const now = new Date();
  await tx
    .update(libraryDocuments)
    .set({
      lastCheckedAt: now,
      ...(params.listingFingerprint !== undefined ? { listingFingerprint: params.listingFingerprint } : {}),
      ...(params.confirmedByFetch ? { fetchInfo: sql`${libraryDocuments.fetchInfo} || ${JSON.stringify({ checkedAt: now.toISOString() })}::jsonb` } : {}),
    })
    .where(eq(libraryDocuments.id, id));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Metadata that records how the stored copy was obtained, not what the
 * source states (metadata.importedManually: who imported the file, when, its
 * hash). It is left out of the comparison below, so importing the same page
 * again, or the automatic run later reading the same page, is not a change.
 */
const PROVENANCE_KEYS = ["importedManually"] as const;

function withoutProvenance(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return metadata;
  const copy = { ...(metadata as Record<string, unknown>) };
  for (const key of PROVENANCE_KEYS) delete copy[key];
  return copy;
}

export type UpsertOutcome = { outcome: "inserted" | "updated" | "unchanged"; documentId: string; version: number };

/**
 * Stores one prepared document, deduplicated by (source, external id): a new
 * one is inserted as version 1; a stored one whose text, title, citations,
 * dates, status, official URL or metadata changed gets the next version, with
 * the replaced state copied to library_document_versions; an identical one
 * only has its check time updated. The row is locked while it is compared, so
 * a daily run and a backfill chunk meeting the same document cannot both
 * write it. Citations are rewritten with the document.
 */
export async function upsertDocument(
  tx: LibraryDb,
  params: { code: string; doc: PreparedDocument; runId: string; originalS3Key: string | null }
): Promise<UpsertOutcome> {
  const { doc } = params;
  const now = new Date();
  const lock = () =>
    tx
      .select({
        id: libraryDocuments.id,
        version: libraryDocuments.version,
        title: libraryDocuments.title,
        citations: libraryDocuments.citations,
        docType: libraryDocuments.docType,
        court: libraryDocuments.court,
        agency: libraryDocuments.agency,
        decisionDate: libraryDocuments.decisionDate,
        publishedDate: libraryDocuments.publishedDate,
        effectiveDate: libraryDocuments.effectiveDate,
        editionDate: libraryDocuments.editionDate,
        documentYear: libraryDocuments.documentYear,
        precedentialStatus: libraryDocuments.precedentialStatus,
        officialUrl: libraryDocuments.officialUrl,
        originalUrl: libraryDocuments.originalUrl,
        originalS3Key: libraryDocuments.originalS3Key,
        textKind: libraryDocuments.textKind,
        textSha256: libraryDocuments.textSha256,
        metadata: libraryDocuments.metadata,
        lastChangedAt: libraryDocuments.lastChangedAt,
        withdrawnAt: libraryDocuments.withdrawnAt,
      })
      .from(libraryDocuments)
      .where(and(eq(libraryDocuments.sourceCode, params.code), eq(libraryDocuments.externalId, doc.externalId)))
      .for("update")
      .limit(1);

  const columns = {
    docType: doc.docType,
    title: doc.title,
    citations: doc.citations,
    court: doc.court,
    agency: doc.agency,
    decisionDate: doc.decisionDate,
    publishedDate: doc.publishedDate,
    effectiveDate: doc.effectiveDate,
    editionDate: doc.editionDate,
    documentYear: doc.documentYear,
    precedentialStatus: doc.precedentialStatus,
    officialUrl: doc.officialUrl,
    originalUrl: doc.originalUrl,
    text: doc.text,
    textKind: doc.textKind,
    textSha256: doc.textSha256,
    textChars: doc.text.length,
    metadata: doc.metadata,
    fetchInfo: doc.fetchInfo,
    listingFingerprint: doc.listingFingerprint,
    withdrawnAt: doc.withdrawn ? now : null,
    withdrawnReason: doc.withdrawn?.reason ?? null,
  };

  let [existing] = await lock();
  if (!existing) {
    const inserted = await tx
      .insert(libraryDocuments)
      .values({
        sourceCode: params.code,
        externalId: doc.externalId,
        ...columns,
        originalS3Key: params.originalS3Key,
        originalSha256: params.originalS3Key ? doc.original?.sha256 ?? null : null,
        originalContentType: params.originalS3Key ? doc.original?.contentType ?? null : null,
        version: 1,
        firstSeenAt: now,
        lastCheckedAt: now,
        lastChangedAt: now,
        lastRunId: params.runId,
      })
      .onConflictDoNothing({ target: [libraryDocuments.sourceCode, libraryDocuments.externalId] })
      .returning({ id: libraryDocuments.id });
    if (inserted.length > 0) {
      await writeCitations(tx, inserted[0].id, doc);
      await linkSupersession(tx, params.code, inserted[0].id, doc);
      return { outcome: "inserted", documentId: inserted[0].id, version: 1 };
    }
    // Another run inserted it a moment ago: compare against that row.
    [existing] = await lock();
    if (!existing) throw new Error(`library document ${doc.externalId} vanished during upsert`);
  }

  const before = stableJson({
    title: existing.title,
    citations: existing.citations,
    docType: existing.docType,
    court: existing.court,
    agency: existing.agency,
    dates: [existing.decisionDate, existing.publishedDate, existing.effectiveDate, existing.editionDate, existing.documentYear],
    precedentialStatus: existing.precedentialStatus,
    officialUrl: existing.officialUrl,
    textKind: existing.textKind,
    textSha256: existing.textSha256,
    metadata: withoutProvenance(existing.metadata),
    withdrawn: Boolean(existing.withdrawnAt),
  });
  const after = stableJson({
    title: doc.title,
    citations: doc.citations,
    docType: doc.docType,
    court: doc.court,
    agency: doc.agency,
    dates: [doc.decisionDate, doc.publishedDate, doc.effectiveDate, doc.editionDate, doc.documentYear],
    precedentialStatus: doc.precedentialStatus,
    officialUrl: doc.officialUrl,
    textKind: doc.textKind,
    textSha256: doc.textSha256,
    metadata: withoutProvenance(doc.metadata),
    withdrawn: Boolean(doc.withdrawn),
  });

  if (before === after) {
    // An identical import still records who imported it last, and when.
    const provenance = Object.fromEntries(PROVENANCE_KEYS.filter((k) => doc.metadata[k] !== undefined).map((k) => [k, doc.metadata[k]]));
    await tx
      .update(libraryDocuments)
      .set({
        ...(Object.keys(provenance).length ? { metadata: sql`${libraryDocuments.metadata} || ${JSON.stringify(provenance)}::jsonb` } : {}),
        lastCheckedAt: now,
        fetchInfo: doc.fetchInfo,
        listingFingerprint: doc.listingFingerprint,
        originalUrl: doc.originalUrl,
        lastRunId: params.runId,
        ...(params.originalS3Key && !existing.originalS3Key
          ? { originalS3Key: params.originalS3Key, originalSha256: doc.original?.sha256 ?? null, originalContentType: doc.original?.contentType ?? null }
          : {}),
      })
      .where(eq(libraryDocuments.id, existing.id));
    return { outcome: "unchanged", documentId: existing.id, version: existing.version };
  }

  // Keep the state being replaced.
  const [old] = await tx.select({ text: libraryDocuments.text }).from(libraryDocuments).where(eq(libraryDocuments.id, existing.id));
  await tx
    .insert(libraryDocumentVersions)
    .values({
      documentId: existing.id,
      version: existing.version,
      title: existing.title,
      citations: existing.citations,
      officialUrl: existing.officialUrl,
      originalUrl: existing.originalUrl,
      originalS3Key: existing.originalS3Key,
      text: old?.text ?? "",
      textKind: existing.textKind,
      textSha256: existing.textSha256,
      metadata: {
        metadata: existing.metadata,
        docType: existing.docType,
        court: existing.court,
        agency: existing.agency,
        decisionDate: existing.decisionDate,
        publishedDate: existing.publishedDate,
        effectiveDate: existing.effectiveDate,
        editionDate: existing.editionDate,
        documentYear: existing.documentYear,
        precedentialStatus: existing.precedentialStatus,
        withdrawn: Boolean(existing.withdrawnAt),
      },
      validFrom: existing.lastChangedAt,
      replacedByRunId: params.runId,
    })
    .onConflictDoNothing();
  const version = existing.version + 1;
  await tx
    .update(libraryDocuments)
    .set({
      ...columns,
      ...(params.originalS3Key
        ? { originalS3Key: params.originalS3Key, originalSha256: doc.original?.sha256 ?? null, originalContentType: doc.original?.contentType ?? null }
        : {}),
      version,
      lastCheckedAt: now,
      lastChangedAt: now,
      lastRunId: params.runId,
      updatedAt: now,
    })
    .where(eq(libraryDocuments.id, existing.id));
  await writeCitations(tx, existing.id, doc);
  await linkSupersession(tx, params.code, existing.id, doc);
  return { outcome: "updated", documentId: existing.id, version };
}

async function writeCitations(tx: LibraryDb, documentId: string, doc: PreparedDocument): Promise<void> {
  await tx.delete(libraryCitations).where(eq(libraryCitations.documentId, documentId));
  const rows = [
    ...doc.selfCitations.map((c) => ({ documentId, relation: "self", normalized: c.normalized, kind: c.kind, raw: c.raw.slice(0, 500) })),
    ...doc.citedCitations.map((c) => ({ documentId, relation: "cites", normalized: c.normalized, kind: c.kind, raw: c.raw.slice(0, 500) })),
  ];
  for (let i = 0; i < rows.length; i += 500) {
    await tx.insert(libraryCitations).values(rows.slice(i, i + 500)).onConflictDoNothing();
  }
}

/** The source names the document that replaces this one: link them when it is stored. */
async function linkSupersession(tx: LibraryDb, code: string, documentId: string, doc: PreparedDocument): Promise<void> {
  if (!doc.supersededBy) return;
  const [target] = await tx
    .select({ id: libraryDocuments.id })
    .from(libraryDocuments)
    .where(and(eq(libraryDocuments.sourceCode, code), eq(libraryDocuments.externalId, doc.supersededBy.externalId)))
    .limit(1);
  await tx
    .update(libraryDocuments)
    .set({ supersededById: target?.id ?? null, supersededNote: doc.supersededBy.note ?? `Superseded by ${doc.supersededBy.externalId}, as the source states.` })
    .where(eq(libraryDocuments.id, documentId));
}

/** Documents the source no longer lists: flagged as withdrawn, never deleted. */
export async function markWithdrawn(tx: LibraryDb, code: string, items: { externalId: string; reason: string }[]): Promise<number> {
  let n = 0;
  for (const item of items) {
    const rows = await tx
      .update(libraryDocuments)
      .set({ withdrawnAt: new Date(), withdrawnReason: item.reason, updatedAt: new Date() })
      .where(and(eq(libraryDocuments.sourceCode, code), eq(libraryDocuments.externalId, item.externalId), isNull(libraryDocuments.withdrawnAt)))
      .returning({ id: libraryDocuments.id });
    n += rows.length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Backfill state
// ---------------------------------------------------------------------------

export type BackfillRow = typeof libraryBackfillState.$inferSelect;

export type RetryRef = { ref: Record<string, unknown>; attempts: number; error: string };

export async function loadBackfillState(tx: LibraryDb, code: string): Promise<BackfillRow> {
  await tx.insert(libraryBackfillState).values({ sourceCode: code }).onConflictDoNothing();
  const [row] = await tx.select().from(libraryBackfillState).where(eq(libraryBackfillState.sourceCode, code)).for("update");
  return row;
}

export async function saveBackfillState(
  tx: LibraryDb,
  code: string,
  params: { cursor: unknown; status: string; addChunks: number; addDocuments: number; retryRefs: RetryRef[]; lastError: string | null }
): Promise<void> {
  await tx
    .update(libraryBackfillState)
    .set({
      cursor: params.cursor ?? null,
      status: params.status,
      chunksDone: sql`${libraryBackfillState.chunksDone} + ${params.addChunks}`,
      documentsDone: sql`${libraryBackfillState.documentsDone} + ${params.addDocuments}`,
      retryRefs: params.retryRefs,
      lastChunkAt: new Date(),
      completedAt: params.status === "complete" ? new Date() : null,
      lastError: params.lastError,
      updatedAt: new Date(),
    })
    .where(eq(libraryBackfillState.sourceCode, code));
}

// ---------------------------------------------------------------------------
// HTTP validators for listing pages
// ---------------------------------------------------------------------------

export async function loadHttpCache(tx: LibraryDb, code: string): Promise<Map<string, KnownFetch>> {
  const rows = await tx.select().from(libraryHttpCache).where(eq(libraryHttpCache.sourceCode, code));
  return new Map(rows.map((r) => [r.url, { url: r.finalUrl, etag: r.etag, lastModified: r.lastModified }]));
}

export async function saveHttpCache(tx: LibraryDb, code: string, entries: Map<string, LibraryHttpResponse>): Promise<void> {
  for (const [url, response] of entries) {
    if (!response.etag && !response.lastModified) continue;
    // The validators belong to the URL the content came from; the request is
    // conditional only when it reaches that URL again (./http/fetch.ts).
    const values = {
      sourceCode: code,
      // Redacted like every stored URL: a key put in a URL by mistake is never kept.
      finalUrl: redactUrl(response.url),
      etag: response.etag,
      lastModified: response.lastModified,
      contentSha256: response.sha256 || null,
      checkedAt: new Date(),
    };
    await tx
      .insert(libraryHttpCache)
      .values({ url: redactUrl(url), ...values })
      .onConflictDoUpdate({ target: [libraryHttpCache.sourceCode, libraryHttpCache.url], set: values });
  }
}

// ---------------------------------------------------------------------------
// Manual imports (./manual-import.ts)
// ---------------------------------------------------------------------------

/**
 * Records a stored import on its source: the document count, the latest
 * document date and freshness.lastManualImport (what /library shows as the
 * last import). For a manual source (LIBRARY_MANUAL_SOURCES) a stored import
 * is its successful update: last_success_at moves, so staleness (and the
 * overdue badge) counts from it. An automatic source's standing is left to
 * its daily runs.
 */
export async function updateSourceAfterImport(
  tx: LibraryDb,
  params: { code: string; at: Date; manual: boolean; externalId: string; outcome: UpsertOutcome["outcome"] }
): Promise<void> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(libraryDocuments)
    .where(and(eq(libraryDocuments.sourceCode, params.code), isNull(libraryDocuments.withdrawnAt)));
  const [{ latest }] = await tx
    .select({ latest: sql<string | null>`max(coalesce(${libraryDocuments.decisionDate}, ${libraryDocuments.publishedDate}, ${libraryDocuments.effectiveDate}))::text` })
    .from(libraryDocuments)
    .where(eq(libraryDocuments.sourceCode, params.code));
  const freshness = {
    latestDocumentDate: latest,
    lastManualImport: { at: params.at.toISOString(), externalId: params.externalId, outcome: params.outcome },
  };
  await tx
    .update(librarySources)
    .set({
      documentCount: n,
      lastAttemptAt: params.at,
      updatedAt: new Date(),
      freshness: sql`${librarySources.freshness} || ${JSON.stringify(freshness)}::jsonb`,
      ...(params.manual ? { lastSuccessAt: params.at, lastError: null } : {}),
    })
    .where(eq(librarySources.code, params.code));
}

export type ImportLogEntry = typeof libraryImportLog.$inferInsert;

/** One row of the import audit log (append-only: RLS allows inserts in service context and nothing else). */
export async function insertImportLog(tx: LibraryDb, entry: ImportLogEntry): Promise<void> {
  await tx.insert(libraryImportLog).values({ ...entry, errorMessage: entry.errorMessage?.slice(0, 1000) ?? null });
}
