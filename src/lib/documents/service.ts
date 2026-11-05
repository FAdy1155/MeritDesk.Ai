import "server-only";
import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { withTenantContext, type db, type TenantTransactionRunner } from "@/db/client";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { documents, documentTypeEnum, matters } from "@/db/schema";
import { validateDocumentUploadMetadata } from "@/lib/documents/upload-policy";
import { getUploadUrl, getDownloadUrl, putGeneratedDocument, pinnableVersionId, DOWNLOAD_URL_EXPIRES_SECONDS } from "@/lib/s3";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";
import { getBoss } from "@/services/queue/boss";
import { DOCUMENT_INGEST_QUEUE, type DocumentIngestJobData } from "@/services/queue/document-ingest-job";

// A pending document with no ingest result this long after it was last
// queued (or uploaded, if it never was) is treated as stalled: the job was
// never queued, or the worker is down. The matter page offers to queue it again.
const INGEST_STALLED_AFTER_MINUTES = 3;

/**
 * Document metadata for the matter page. Leaves extracted_text itself out
 * (it can run to hundreds of KB per document) and returns its length instead.
 */
export async function listDocuments(tenantId: string, matterId: string) {
  return withTenantContext(tenantId, (tx) =>
    tx
      .select({
        id: documents.id,
        matterId: documents.matterId,
        type: documents.type,
        fileName: documents.fileName,
        mimeType: documents.mimeType,
        sizeBytes: documents.sizeBytes,
        version: documents.version,
        malwareScanStatus: documents.malwareScanStatus,
        pageCount: documents.pageCount,
        ingestionNote: documents.ingestionNote,
        ingestedAt: documents.ingestedAt,
        createdAt: documents.createdAt,
        extractedTextChars: sql<number | null>`length(${documents.extractedText})`,
        // Computed in the database so the page never compares against the
        // render-time clock.
        ingestStalled: sql<boolean>`(${documents.malwareScanStatus} = 'pending' and ${documents.ingestedAt} is null and coalesce(${documents.ingestQueuedAt}, ${documents.createdAt}) < now() - make_interval(mins => ${INGEST_STALLED_AFTER_MINUTES}))`,
      })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.matterId, matterId)))
      .orderBy(desc(documents.createdAt))
  );
}

/**
 * Step 1 of upload: create the Document row (status: malware scan pending)
 * and hand back a presigned PUT URL with the headers the PUT must send
 * (getUploadUrl). The row exists before the bytes do so
 * every document is always traceable in the audit trail even if the
 * browser upload never completes (a document.upload_initiated audit row is
 * written in the same transaction). Step 2 is requestDocumentIngest, which
 * the uploader calls once the PUT has succeeded.
 */
export async function initiateDocumentUpload(params: {
  tenantId: string;
  matterId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  type: (typeof documentTypeEnum.enumValues)[number];
  uploadedBy: string;
}) {
  const upload = validateDocumentUploadMetadata(params);
  return withTenantContext(params.tenantId, async (tx) => {
    // matterId comes from the browser. The foreign key alone would accept
    // another tenant's matter id (FK checks bypass RLS), so check ownership.
    const [matter] = await tx
      .select({ id: matters.id })
      .from(matters)
      .where(and(eq(matters.id, params.matterId), eq(matters.tenantId, params.tenantId)))
      .limit(1);
    if (!matter) throw new Error("Matter not found");

    const [row] = await tx
      .insert(documents)
      .values({
        tenantId: params.tenantId,
        matterId: params.matterId,
        type: upload.type,
        fileName: upload.fileName,
        mimeType: upload.contentType,
        sizeBytes: upload.sizeBytes,
        s3Key: "", // filled in below once we know the document id
        s3Bucket: "",
        uploadedBy: params.uploadedBy,
        malwareScanStatus: "pending",
      })
      .returning();

    const { url, headers, key, bucket } = await getUploadUrl({
      tenantId: params.tenantId,
      matterId: params.matterId,
      documentId: row.id,
      fileName: upload.fileName,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes,
    });

    const [updated] = await tx
      .update(documents)
      .set({ s3Key: key, s3Bucket: bucket })
      .where(and(eq(documents.id, row.id), eq(documents.tenantId, params.tenantId)))
      .returning();

    await recordAuditEvent(tx, {
      tenantId: params.tenantId,
      actorUserId: params.uploadedBy,
      action: AUDIT_ACTIONS.documentUploadInitiated,
      resourceType: "document",
      resourceId: row.id,
      // No file name: audit_logs is permanent (see recordAuditEvent).
      after: {
        matterId: params.matterId,
        type: upload.type,
        mimeType: upload.contentType,
        sizeBytes: upload.sizeBytes,
        version: row.version,
      },
    });

    return { document: updated, uploadUrl: url, uploadHeaders: headers };
  });
}

/** Puts a document on the document-ingest queue (src/worker.ts runs it). */
async function enqueueDocumentIngest(tenantId: string, documentId: string) {
  const boss = await getBoss();
  const data: DocumentIngestJobData = { documentId, tenantId };
  // Retrying is safe here, unlike a skill run: the job is idempotent (it
  // re-downloads, re-scans and re-extracts) and has no outside side effects.
  await boss.send(DOCUMENT_INGEST_QUEUE, data, {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 900,
    // The tenant is the job's pg-boss group: the worker caps each tenant's
    // upload jobs in progress (DOCUMENT_INGEST_TENANT_CONCURRENCY_ENV in
    // src/services/queue/document-ingest-job.ts).
    group: { id: tenantId },
  });
}

/**
 * Step 2 of upload, and the matter page's "scan again": queues the malware
 * scan and text extraction for a document. A document whose scan errored is
 * reset to pending first so the page shows it as queued again (only if it is
 * still "error" at that moment). Infected documents are never re-processed,
 * and a clean one is never rescanned: its pinned, scanned version is what
 * every read uses. Returns the document's matter id so the caller can
 * revalidate the matter page.
 */
export async function requestDocumentIngest(tenantId: string, documentId: string): Promise<{ matterId: string }> {
  const doc = await withTenantContext(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: documents.id, matterId: documents.matterId, malwareScanStatus: documents.malwareScanStatus })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new Error("Document not found");
    if (row.malwareScanStatus === "infected") {
      throw new Error("This document was flagged as infected and is not processed again.");
    }
    await tx
      .update(documents)
      .set(
        row.malwareScanStatus === "error"
          ? {
              malwareScanStatus: "pending",
              s3VersionId: null,
              ingestionNote: null,
              ingestedAt: null,
              ingestQueuedAt: new Date(),
            }
          : { ingestQueuedAt: new Date() }
      )
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.tenantId, tenantId),
          eq(documents.malwareScanStatus, row.malwareScanStatus)
        )
      );
    return row;
  });

  await enqueueDocumentIngest(tenantId, documentId);
  return { matterId: doc.matterId };
}

/**
 * Records a document the app generated itself (e.g. a skill's docx output),
 * as opposed to initiateDocumentUpload's two-step flow for browser uploads.
 * Content is already known and trusted at call time, so this skips the
 * pending-scan state and writes the row and the S3 object together. The
 * ingest job is still queued, for text extraction only (it does not scan a
 * document that is already clean), so later skill runs can read it.
 *
 * `inTransaction` runs in the transaction that inserts the row, with the new
 * document's id: for audit entries that belong with it (a generator that
 * embedded an attorney's signature records firm_signature.applied there).
 */
export async function createGeneratedDocument(params: {
  tenantId: string;
  matterId: string;
  fileName: string;
  contentType: string;
  body: Buffer;
  uploadedBy: string;
  type: (typeof documentTypeEnum.enumValues)[number];
  inTransaction?: (tx: typeof db, documentId: string) => Promise<void>;
}) {
  const documentId = crypto.randomUUID();
  const { key, bucket, versionId } = await putGeneratedDocument({
    tenantId: params.tenantId,
    matterId: params.matterId,
    documentId,
    fileName: params.fileName,
    contentType: params.contentType,
    body: params.body,
  });

  const row = await withTenantContext(params.tenantId, async (tx) => {
    const [inserted] = await tx
      .insert(documents)
      .values({
        id: documentId,
        tenantId: params.tenantId,
        matterId: params.matterId,
        type: params.type,
        fileName: params.fileName,
        mimeType: params.contentType,
        sizeBytes: params.body.length,
        s3Key: key,
        s3Bucket: bucket,
        s3VersionId: versionId,
        uploadedBy: params.uploadedBy,
        malwareScanStatus: "clean",
      })
      .returning();
    await params.inTransaction?.(tx, inserted.id);
    return inserted;
  });

  try {
    await enqueueDocumentIngest(params.tenantId, row.id);
  } catch (err) {
    // The document itself is stored and downloadable; only its extracted text will be missing.
    console.error(`createGeneratedDocument: could not queue text extraction for ${row.id}: ${describeErrorForLog(err)}`);
  }
  return row;
}

/**
 * One document row, only if it belongs to this tenant and this matter (the
 * skill runner's tools look documents up by an id the model supplied, so
 * the matter filter matters as much as the tenant one). Null otherwise.
 */
export async function getMatterDocument(tenantId: string, matterId: string, documentId: string) {
  return withTenantContext(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId), eq(documents.matterId, matterId)))
      .limit(1);
    return rows[0] ?? null;
  });
}

// Why a download of a document that has not passed the scan is refused, by status.
const DOWNLOAD_BLOCKED_MESSAGES: Record<string, string> = {
  infected: "Download blocked: the malware scan flagged this file as infected.",
  pending:
    "Download not available yet: the file has not been scanned for malware. It can be downloaded once its scan shows clean.",
  error:
    "Download blocked: the file could not be scanned for malware (see the note on the document), so it is not released. Use Scan again, or upload a smaller or unlocked copy.",
  unversioned:
    "Download blocked: storage did not provide an immutable object version for this file. Enable bucket versioning and upload the file again.",
};

/**
 * A presigned download URL for one of the tenant's documents, issued to
 * `actorUserId`. Every URL issued gets a document.download audit row in the
 * same transaction (no URL without its audit row).
 *
 * Fails closed: only a document whose malware scan came back "clean" is
 * released. Infected, not yet scanned ("pending") and unscannable ("error":
 * scanner or signatures missing, ClamAV limits exceeded, file too large)
 * documents are refused, and each refusal is audited too
 * (document.download_blocked, with the status in after.reason). The URL is
 * pinned to the S3 object version the scan read (documents.s3_version_id),
 * so bytes written to the key after the scan are never served.
 */
export async function getDocumentDownloadUrl(
  tenantId: string,
  documentId: string,
  actorUserId: string,
  options: {
    /** Only a document of this matter (the connector names both). */
    matterId?: string;
    /**
     * Issued to Claude or ChatGPT through the connector (src/services/connector/):
     * the document.download or document.download_blocked entry says so
     * (after.via "connector"), and the connector.tool_call entry is written
     * in the same transaction.
     */
    connectorCall?: { tool: string; oauthClientId: string };
    /** Transaction runner override for isolated service-level verification. */
    runTenant?: TenantTransactionRunner;
    /** S3 URL signer override for isolated service-level verification. */
    signDownload?: typeof getDownloadUrl;
  } = {}
) {
  const { matterId, connectorCall, runTenant = withTenantContext, signDownload = getDownloadUrl } = options;
  const result = await runTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.tenantId, tenantId),
          ...(matterId ? [eq(documents.matterId, matterId)] : [])
        )
      )
      .limit(1);
    const doc = rows[0];
    if (!doc) throw new Error("Document not found");
    const auditTarget = {
      tenantId,
      actorUserId,
      resourceType: "document" as const,
      resourceId: doc.id,
    };
    const via = connectorCall ? { via: "connector" } : {};
    const recordConnectorCall = async (outcome: string) => {
      if (!connectorCall) return;
      await recordAuditEvent(tx, {
        tenantId,
        actorUserId,
        action: AUDIT_ACTIONS.connectorToolCall,
        resourceType: "connector_tool",
        resourceId: connectorCall.tool,
        after: { matterId: doc.matterId, documentId: doc.id, oauthClientId: connectorCall.oauthClientId, outcome },
      });
    };
    const versionUnavailable = doc.malwareScanStatus === "clean" && !pinnableVersionId(doc.s3VersionId);
    if (doc.malwareScanStatus !== "clean" || versionUnavailable) {
      // Returned rather than thrown, so the audit row commits.
      await recordAuditEvent(tx, {
        ...auditTarget,
        action: AUDIT_ACTIONS.documentDownloadBlocked,
        after: {
          matterId: doc.matterId,
          version: doc.version,
          reason: versionUnavailable ? "storage_version_unavailable" : `malware_scan_${doc.malwareScanStatus}`,
          ...via,
        },
      });
      await recordConnectorCall("download_blocked");
      return { blocked: true as const, status: versionUnavailable ? "unversioned" : doc.malwareScanStatus };
    }
    const url = await signDownload({ bucket: doc.s3Bucket, key: doc.s3Key, versionId: doc.s3VersionId });
    await recordAuditEvent(tx, {
      ...auditTarget,
      action: AUDIT_ACTIONS.documentDownloadUrlIssued,
      after: { matterId: doc.matterId, version: doc.version, expiresInSeconds: DOWNLOAD_URL_EXPIRES_SECONDS, ...via },
    });
    await recordConnectorCall("download_url_issued");
    return { blocked: false as const, url };
  });
  if (result.blocked) {
    throw new Error(
      DOWNLOAD_BLOCKED_MESSAGES[result.status] ??
        `Download blocked: the file has not passed the malware scan (status "${result.status}").`
    );
  }
  return result.url;
}
