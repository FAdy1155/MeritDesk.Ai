import "server-only";
import type { ConcurrencySetting } from "./concurrency";

export const DOCUMENT_INGEST_QUEUE = "document-ingest";

export type DocumentIngestJobData = {
  documentId: string;
  tenantId: string;
};

// How many uploads one worker process scans and extracts at once (pg-boss
// localConcurrency, src/worker.ts), separate from skill runs so long runs
// never hold up a new upload's scan. Each job holds its file in memory (up
// to 150 MB). clamscan runs are capped on their own (MALWARE_SCAN_CONCURRENCY
// in concurrency.ts), so with the default a second upload downloads and
// extracts while the first is scanned.
export const DOCUMENT_INGEST_CONCURRENCY: ConcurrencySetting = {
  env: "DOCUMENT_INGEST_CONCURRENCY",
  fallback: 2,
  max: 8,
};

// One tenant's share of those slots, as for skill runs (see
// SKILL_RUN_TENANT_CONCURRENCY_ENV in skill-run-job.ts): unset, half of
// DOCUMENT_INGEST_CONCURRENCY rounded up, so one firm's bulk upload leaves a
// slot for everyone else's. Needs group: { id: tenantId } on every send
// (enqueueDocumentIngest in src/lib/documents/service.ts).
export const DOCUMENT_INGEST_TENANT_CONCURRENCY_ENV = "DOCUMENT_INGEST_TENANT_CONCURRENCY";
