import { OfficialFetchError } from "./http/fetch";
import { createLibraryHttp, type ListingCache } from "./http/client";
import type { LibraryTransactions } from "./db";
import { feedLegalUpdate } from "./legal-updates";
import { LibraryDocumentError, prepareDocument, type PreparedDocument } from "./prepare";
import { backfillPausedReason, getLibraryAdapter, isManualSource, isSourceDisabled, missingEnv } from "./registry";
import {
  closeInterruptedRuns,
  emptyCounts,
  finishRun,
  loadBackfillState,
  loadHttpCache,
  loadKnownDocuments,
  loadSource,
  markLegalUpdatesBaseline,
  markWithdrawn,
  saveBackfillState,
  saveHttpCache,
  startRun,
  touchDocument,
  touchListed,
  updateSourceAfterRun,
  upsertDocument,
  type KnownDocument,
  type RetryRef,
  type RunCounts,
  type RunFailure,
  type RunKind,
  type RunStatus,
} from "./store";
import {
  LibraryLayoutError,
  type DocumentRef,
  type FetchPriority,
  type LibraryAdapterContext,
  type LibraryHttpResponse,
  type LibrarySourceAdapter,
} from "./types";

// Runs one source: a daily run (listUpdates) or one backfill chunk
// (backfill), then each listed document through fetchDocument, prepare
// (./prepare.ts) and the store (./store.ts), with the run's books kept in
// library_fetch_runs and the source's standing in library_sources.
//
// - One document's failure never fails the run: it is recorded (capped) on
//   the run and, in backfill, tried again before later chunks, up to
//   MAX_RETRY_ATTEMPTS times. A listing that cannot be read or parsed fails
//   the run, and the source shows it.
// - A listed document stored with the same listing fingerprint and fetched
//   within the adapter's recheckAfterDays is not fetched again; after that
//   it is re-fetched with a conditional GET.
// - Each run has a time budget (and a document cap for daily runs); what it
//   does not reach is picked up by the next run (daily) or the next job
//   (backfill, whose cursor only moves once its whole chunk was attempted).
// - Each document is written in its own short transaction (Neon's pooled
//   connections), in service context, the only context RLS lets write the
//   library.

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NOTES = 100;
const MAX_FAILURES_RECORDED = 200;
const MAX_RETRY_ATTEMPTS = 3;

function minutesSetting(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 && value <= 600 ? value : fallback;
}

/** What the pipeline needs from its host: transactions, and (optionally) the original-file store. */
export type PipelineDeps = {
  tx: LibraryTransactions;
  /** Stores an original file and returns its S3 key; absent when LIBRARY_STORE_ORIGINALS is off. */
  storeOriginal?: ((params: { code: string; externalId: string; sha256: string; contentType: string; extension: string; bytes: Buffer }) => Promise<string>) | null;
  log?: (line: string) => void;
};

export type RunOptions = {
  pgBossJobId?: string | null;
  /** Aborted at worker shutdown: the run stops fetching and records what it stored. */
  signal?: AbortSignal;
  /** The adapter to run instead of the registered one with this code (the PGlite check uses it). */
  adapter?: LibrarySourceAdapter;
};

export type RunResult = {
  runId: string | null;
  status: RunStatus | "paused";
  counts: RunCounts;
  message: string | null;
  /** Backfill: another chunk should be queued. */
  more: boolean;
};

class RunNotes {
  readonly list: string[] = [];
  private readonly seen = new Set<string>();
  add(message: string): void {
    const text = message.replace(/\s+/g, " ").trim().slice(0, 500);
    if (!text || this.seen.has(text)) return;
    this.seen.add(text);
    if (this.list.length < MAX_NOTES) this.list.push(text);
    else if (this.list.length === MAX_NOTES) this.list.push("Further notes were left out.");
  }
}

/** A message safe to store and show: no stack, no query values. */
export function describeError(err: unknown): string {
  if (err instanceof OfficialFetchError || err instanceof LibraryLayoutError || err instanceof LibraryDocumentError) return err.message;
  if (err instanceof Error && err.name === "PdfExtractionError") return err.message;
  if (err instanceof Error) return `Unexpected error: ${err.message}`.slice(0, 500);
  return "Unexpected error.";
}

/** The context an adapter gets; also used by the probe (no database, no listing cache). */
export function createAdapterContext(params: {
  adapter: LibrarySourceAdapter;
  mode: LibraryAdapterContext["mode"];
  signal: AbortSignal;
  note: (message: string) => void;
  listingCache?: ListingCache | null;
  now?: Date;
}): LibraryAdapterContext {
  const priority: FetchPriority = params.mode === "backfill" ? "backfill" : params.mode === "probe" ? "interactive" : "daily";
  const allowedEnv = new Set([...(params.adapter.requiredEnv ?? []), ...(params.adapter.optionalEnv ?? [])]);
  return {
    sourceCode: params.adapter.code,
    mode: params.mode,
    http: createLibraryHttp({ hosts: params.adapter.hosts, priority, signal: params.signal, note: params.note, listingCache: params.listingCache }),
    now: params.now ?? new Date(),
    signal: params.signal,
    note: params.note,
    env: (name) => (allowedEnv.has(name) ? process.env[name] : undefined),
  };
}

function budgetSignal(outer: AbortSignal | undefined, minutes: number): { signal: AbortSignal; deadline: number } {
  const deadline = Date.now() + minutes * 60 * 1000;
  const timeout = AbortSignal.timeout(minutes * 60 * 1000);
  return { signal: outer ? AbortSignal.any([outer, timeout]) : timeout, deadline };
}

type ProcessOutcome = { attemptedAll: boolean; failedRefs: { ref: DocumentRef; error: string }[] };

/** Fetches, prepares and stores each ref in order; see the file comment for the rules. */
async function processRefs(params: {
  adapter: LibrarySourceAdapter;
  ctx: LibraryAdapterContext;
  refs: DocumentRef[];
  runId: string;
  kind: RunKind;
  deadline: number;
  maxFetches: number;
  feedLegalUpdates: boolean;
  counts: RunCounts;
  failures: RunFailure[];
  notes: RunNotes;
  deps: PipelineDeps;
}): Promise<ProcessOutcome> {
  const { adapter, ctx, counts, deps } = params;
  const failedRefs: ProcessOutcome["failedRefs"] = [];
  const unique = new Map<string, DocumentRef>();
  for (const ref of params.refs) if (!unique.has(ref.externalId)) unique.set(ref.externalId, ref);
  if (unique.size < params.refs.length) params.notes.add(`${params.refs.length - unique.size} repeated listing entr(ies) were read once.`);
  const refs = [...unique.values()];
  const known: Map<string, KnownDocument> = await deps.tx.write((tx) => loadKnownDocuments(tx, adapter.code, refs.map((r) => r.externalId)));
  const recheckMs = (adapter.recheckAfterDays ?? 30) * DAY_MS;
  const unchangedIds: string[] = [];
  let fetches = 0;
  let attemptedAll = true;

  const fail = (ref: DocumentRef, error: string) => {
    counts.failed++;
    failedRefs.push({ ref, error });
    if (params.failures.length < MAX_FAILURES_RECORDED) params.failures.push({ externalId: ref.externalId, url: ref.url, error });
  };

  for (const ref of refs) {
    if (ctx.signal.aborted || Date.now() > params.deadline) {
      attemptedAll = false;
      params.notes.add(
        Date.now() > params.deadline
          ? "The run's time budget ran out before every listed document was reached; the rest is picked up by the next run."
          : "The run was stopped (worker shutdown) before every listed document was reached; the rest is picked up by the next run."
      );
      break;
    }
    const stored = known.get(ref.externalId);
    if (
      stored &&
      ref.fingerprint &&
      stored.listingFingerprint === ref.fingerprint &&
      !stored.withdrawnAt &&
      stored.lastFetchedAt &&
      Date.now() - stored.lastFetchedAt.getTime() < recheckMs
    ) {
      counts.skippedUnchanged++;
      unchangedIds.push(stored.id);
      continue;
    }
    if (fetches >= params.maxFetches) {
      attemptedAll = false;
      params.notes.add(`This run's cap of ${params.maxFetches} document fetches was reached; the rest is picked up by the next run.`);
      break;
    }
    fetches++;

    let result;
    try {
      result = await adapter.fetchDocument(ctx, { ...ref, known: stored?.known ?? null });
      counts.fetched++;
    } catch (err) {
      fail(ref, describeError(err));
      continue;
    }

    if (result.kind === "not_modified") {
      counts.notModified++;
      if (stored) await deps.tx.write((tx) => touchDocument(tx, stored.id, { confirmedByFetch: true, listingFingerprint: ref.fingerprint ?? null }));
      continue;
    }
    if (result.kind === "skip") {
      counts.skipped++;
      params.notes.add(result.reason);
      continue;
    }

    let doc: PreparedDocument;
    try {
      doc = prepareDocument(adapter, result.document, ref);
    } catch (err) {
      fail(ref, describeError(err));
      continue;
    }

    let originalKey: string | null = null;
    if (deps.storeOriginal && doc.original && doc.original.sha256 !== stored?.originalSha256) {
      try {
        originalKey = await deps.storeOriginal({ code: adapter.code, externalId: doc.externalId, ...doc.original });
      } catch (err) {
        params.notes.add(`The original file of ${doc.externalId} could not be stored (${describeError(err)}); its text was stored.`);
      }
    }

    try {
      const outcome = await deps.tx.write((tx) => upsertDocument(tx, { code: adapter.code, doc, runId: params.runId, originalS3Key: originalKey }));
      counts[outcome.outcome]++;
      if (outcome.outcome === "inserted" && params.feedLegalUpdates && adapter.legalUpdateItem) {
        const legalUpdateItem = adapter.legalUpdateItem.bind(adapter);
        try {
          const item = legalUpdateItem(result.document);
          if (item) {
            const fed = await deps.tx.write((tx) => feedLegalUpdate(tx, { adapter, documentId: outcome.documentId, doc, item }));
            if (fed === "inserted") counts.legalUpdates++;
          }
        } catch (err) {
          // The document is stored either way; only its legal update is missing.
          params.notes.add(`${doc.externalId} was stored but could not be added to the legal updates (${describeError(err)}).`);
        }
      }
    } catch (err) {
      fail(ref, describeError(err));
    }
  }

  if (unchangedIds.length) await deps.tx.write((tx) => touchListed(tx, unchangedIds));
  return { attemptedAll, failedRefs };
}

function failureSummary(counts: RunCounts, attemptedAll: boolean): string | null {
  const parts: string[] = [];
  if (counts.failed) parts.push(`${counts.failed} document(s) could not be stored (see the run's failures)`);
  if (!attemptedAll) parts.push("the run stopped before every listed document was reached");
  return parts.length ? `${parts.join("; ")}.` : null;
}

/** One daily run of a source. Never throws for a source problem: the run and the source record it. */
export async function runDaily(code: string, opts: RunOptions, deps: PipelineDeps): Promise<RunResult> {
  const adapter = opts.adapter ?? getLibraryAdapter(code);
  if (!adapter) throw new Error(`No library adapter is registered with code "${code}".`);
  const counts = emptyCounts();
  const missing = missingEnv(adapter);
  // A manual source's site refuses the collector: a daily run would only record the same HTTP 403 every day.
  const manual = !opts.adapter && isManualSource(code);
  if (isSourceDisabled(code) || missing.length || manual) {
    const message = missing.length
      ? `Needs ${missing.join(" and ")}; skipped.`
      : manual
        ? "Kept up to date by import from the official site (LIBRARY_MANUAL_SOURCES); skipped."
        : "Turned off (LIBRARY_DISABLED_SOURCES); skipped.";
    deps.log?.(`[library] ${code}: ${message}`);
    return { runId: null, status: "skipped", counts, message, more: false };
  }

  const notes = new RunNotes();
  const failures: RunFailure[] = [];
  const { run, source, cache } = await deps.tx.write(async (tx) => {
    const closed = await closeInterruptedRuns(tx, code, "daily");
    if (closed) notes.add(`${closed} earlier daily run(s) had been cut off and were closed as interrupted.`);
    return {
      run: await startRun(tx, { code, kind: "daily", pgBossJobId: opts.pgBossJobId ?? null }),
      source: await loadSource(tx, code),
      cache: await loadHttpCache(tx, code),
    };
  });

  const seenListings = new Map<string, LibraryHttpResponse>();
  const listingCache: ListingCache = {
    get: (url) => cache.get(url),
    record: (url, response) => {
      seenListings.set(url, response);
    },
  };
  const { signal, deadline } = budgetSignal(opts.signal, minutesSetting("LIBRARY_DAILY_RUN_MINUTES", 100));
  const ctx = createAdapterContext({ adapter, mode: "daily", signal, note: (m) => notes.add(m), listingCache });

  let status: RunStatus;
  let errorMessage: string | null = null;
  try {
    const listing = await adapter.listUpdates(ctx, source?.lastSuccessAt ?? null);
    counts.listed = listing.refs.length;
    const outcome = await processRefs({
      adapter,
      ctx,
      refs: listing.refs,
      runId: run.id,
      kind: "daily",
      deadline,
      maxFetches: adapter.maxDocumentsPerDailyRun ?? 500,
      feedLegalUpdates: Boolean(source?.legalUpdatesBaselineAt),
      counts,
      failures,
      notes,
      deps,
    });
    if (listing.withdrawn?.length) counts.withdrawn = await deps.tx.write((tx) => markWithdrawn(tx, code, listing.withdrawn!));
    errorMessage = failureSummary(counts, outcome.attemptedAll);
    status = errorMessage ? "partial" : "completed";
  } catch (err) {
    status = "failed";
    errorMessage = describeError(err);
  }

  await deps.tx.write(async (tx) => {
    const finishedAt = await finishRun(tx, run.id, { status, counts, notes: notes.list, failures, errorMessage });
    await updateSourceAfterRun(tx, { code, kind: "daily", status, startedAt: run.startedAt, finishedAt, counts, errorMessage });
    if (status === "completed") {
      // Validators are kept only after a run that stored everything it
      // listed, so a 304 never hides a page an earlier run did not finish.
      await saveHttpCache(tx, code, seenListings);
      await markLegalUpdatesBaseline(tx, code, finishedAt);
    }
  });
  deps.log?.(`[library] ${code} daily: ${status} ${JSON.stringify(counts)}${errorMessage ? ` (${errorMessage})` : ""}`);
  return { runId: run.id, status, counts, message: errorMessage, more: false };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}


/**
 * Backfill states (library_backfill_state.status): pending (the walk goes
 * on from cursor), retrying (the walk is done, failed documents are being
 * tried again), complete, failed (the last chunk failed; the next one
 * resumes from the same cursor).
 */
type BackfillStatus = "pending" | "retrying" | "complete" | "failed";

/** One backfill chunk of a source. Returns more: true when another chunk should follow. */
export async function runBackfillChunk(code: string, opts: RunOptions, deps: PipelineDeps): Promise<RunResult> {
  const adapter = opts.adapter ?? getLibraryAdapter(code);
  if (!adapter) throw new Error(`No library adapter is registered with code "${code}".`);
  const counts = emptyCounts();
  const paused = backfillPausedReason(code);
  const missing = missingEnv(adapter);
  const manual = !opts.adapter && isManualSource(code);
  if (paused || isSourceDisabled(code) || missing.length || manual) {
    const message = paused
      ? `Backfill paused (${paused}).`
      : missing.length
        ? `Needs ${missing.join(" and ")}; skipped.`
        : manual
          ? "Kept up to date by import from the official site; skipped."
          : "Turned off; skipped.";
    return { runId: null, status: paused ? "paused" : "skipped", counts, message, more: false };
  }

  const notes = new RunNotes();
  const failures: RunFailure[] = [];
  const begin = await deps.tx.write(async (tx) => {
    const state = await loadBackfillState(tx, code);
    const retries = (state.retryRefs as RetryRef[] | null) ?? [];
    if (state.status === "complete") return null;
    const closed = await closeInterruptedRuns(tx, code, "backfill");
    if (closed) notes.add(`${closed} earlier backfill chunk(s) had been cut off and were closed as interrupted.`);
    const run = await startRun(tx, { code, kind: "backfill", pgBossJobId: opts.pgBossJobId ?? null, cursorBefore: state.cursor });
    return { run, state, retries };
  });
  if (!begin) return { runId: null, status: "completed", counts, message: "Backfill is complete.", more: false };
  const { run, state, retries } = begin;
  const walkWasDone = state.status === "retrying";

  const { signal, deadline } = budgetSignal(opts.signal, minutesSetting("LIBRARY_BACKFILL_CHUNK_MINUTES", 50));
  const ctx = createAdapterContext({ adapter, mode: "backfill", signal, note: (m) => notes.add(m) });
  const processBatch = (refs: DocumentRef[]) =>
    processRefs({
      adapter,
      ctx,
      refs,
      runId: run.id,
      kind: "backfill",
      deadline,
      maxFetches: Number.MAX_SAFE_INTEGER,
      feedLegalUpdates: false,
      counts,
      failures,
      notes,
      deps,
    });

  let status: RunStatus = "completed";
  let errorMessage: string | null = null;
  let cursorAfter: unknown = state.cursor;
  let backfillStatus: BackfillStatus = walkWasDone ? "retrying" : "pending";
  let nextRetries: RetryRef[] = retries;
  let more = false;

  try {
    // Documents that failed in earlier chunks go first.
    let attemptedAll = true;
    if (retries.length) {
      const outcome = await processBatch(retries.map((r) => r.ref as unknown as DocumentRef));
      attemptedAll = outcome.attemptedAll;
      if (attemptedAll) {
        const stillFailing = new Map(outcome.failedRefs.map((f) => [f.ref.externalId, f.error]));
        nextRetries = retries
          .filter((r) => stillFailing.has(String(r.ref.externalId)))
          .map((r) => ({ ...r, attempts: r.attempts + 1, error: stillFailing.get(String(r.ref.externalId)) ?? r.error }));
        for (const r of nextRetries.filter((x) => x.attempts >= MAX_RETRY_ATTEMPTS)) {
          notes.add(`${String(r.ref.externalId)} failed ${r.attempts} times and is no longer retried: ${r.error}`);
        }
        nextRetries = nextRetries.filter((r) => r.attempts < MAX_RETRY_ATTEMPTS);
      }
    }

    if (attemptedAll && !walkWasDone) {
      const chunk = await adapter.backfill(ctx, state.cursor ?? null);
      if (chunk.progress) notes.add(`Chunk: ${chunk.progress}.`);
      counts.listed = chunk.refs.length;
      const outcome = await processBatch(chunk.refs);
      attemptedAll = outcome.attemptedAll;
      // The cursor moves only once the whole chunk was attempted; an
      // interrupted chunk runs again, skipping what it already stored.
      if (attemptedAll) {
        cursorAfter = chunk.nextCursor;
        if (chunk.refs.length === 0 && chunk.nextCursor !== null && sameJson(chunk.nextCursor, state.cursor)) {
          notes.add("The collector returned no documents and the same cursor; the history walk was ended so it cannot loop.");
          cursorAfter = null;
        }
        nextRetries = [...nextRetries, ...outcome.failedRefs.map((f) => ({ ref: f.ref as unknown as Record<string, unknown>, attempts: 1, error: f.error }))];
      }
    }

    const walkDone = walkWasDone || (attemptedAll && cursorAfter === null);
    backfillStatus = walkDone ? (nextRetries.length ? "retrying" : "complete") : "pending";
    errorMessage = failureSummary(counts, attemptedAll);
    status = errorMessage ? "partial" : "completed";
    more = backfillStatus !== "complete";
  } catch (err) {
    status = "failed";
    errorMessage = describeError(err);
    backfillStatus = walkWasDone ? "retrying" : "failed";
    // The next scheduled kick resumes from the same cursor; no chunk is queued at once.
    more = false;
  }

  const stored = counts.inserted + counts.updated;
  await deps.tx.write(async (tx) => {
    const finishedAt = await finishRun(tx, run.id, { status, counts, notes: notes.list, failures, errorMessage, cursorAfter });
    await saveBackfillState(tx, code, {
      cursor: cursorAfter,
      status: backfillStatus,
      addChunks: 1,
      addDocuments: stored,
      retryRefs: nextRetries,
      lastError: status === "failed" ? errorMessage : null,
    });
    await updateSourceAfterRun(tx, {
      code,
      kind: "backfill",
      status,
      startedAt: run.startedAt,
      finishedAt,
      counts,
      errorMessage,
      backfill: { status: backfillStatus, documentsDone: state.documentsDone + stored },
    });
  });
  deps.log?.(`[library] ${code} backfill chunk: ${status}, backfill ${backfillStatus} ${JSON.stringify(counts)}${errorMessage ? ` (${errorMessage})` : ""}`);
  return { runId: run.id, status, counts, message: errorMessage, more };
}
