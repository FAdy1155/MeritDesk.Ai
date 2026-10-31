import "server-only";
import crypto from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { withTenantContext, type db } from "@/db/client";
import { firmAttorneys, firmIdentities } from "@/db/schema";
import { AUDIT_ACTIONS, SYSTEM_ACTORS, recordAuditEvent } from "@/lib/audit/service";
import {
  getFirmSignaturePreviewUrl,
  getObjectBytes,
  putFirmSignature,
  SIGNATURE_PREVIEW_URL_EXPIRES_SECONDS,
} from "@/lib/s3";
import {
  SIGNATURE_MAX_BYTES,
  type FirmAttorneyValues,
  type FirmAttorneyView,
  type FirmIdentitySnapshot,
  type FirmIdentityValues,
  type FirmIdentityView,
  type SignatureMediaType,
} from "./schema";
import { sanitizeSignatureImage } from "./signature-image";

/**
 * The firm identity: each tenant's letterhead details (firm_identities) and
 * its attorney / accredited representative roster with signature images
 * (firm_attorneys). Skill runs put a snapshot of it in their system prompt
 * (src/services/skill-runner/prompt.ts) in place of the firm the skills were
 * written for, and generator tools fill letterhead and signer fields from it
 * server-side. Every change is audited in the same transaction.
 *
 * Callers check the role first (FIRM_IDENTITY_EDIT_ROLES in src/lib/tenant.ts);
 * every query here also filters by tenant_id inside withTenantContext.
 */

type Tx = typeof db;
type FirmIdentityRow = typeof firmIdentities.$inferSelect;
type FirmAttorneyRow = typeof firmAttorneys.$inferSelect;

/** A refusal the user can act on; Server Actions return its message instead of throwing it. */
export class FirmIdentityRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirmIdentityRequestError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres unique_violation, as the driver reports it (possibly wrapped by Drizzle). */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

async function retryOnConcurrentChange<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new FirmIdentityRequestError(
        "Someone else changed the firm identity at the same time. Reload the page and try again."
      );
    }
    throw err;
  }
}

// Default signer first, then by name, then id: a fixed order, so the prompt
// section rendered from it is identical across runs while nothing changes.
const ROSTER_ORDER = [desc(firmAttorneys.isDefaultSigner), asc(firmAttorneys.fullName), asc(firmAttorneys.id)] as const;

const IDENTITY_FIELDS = ["legalName", "addressLines", "phone", "fax", "email", "website", "licensureLine"] as const;
const ATTORNEY_FIELDS = ["fullName", "title", "role", "barState", "barNumber", "eoirId", "email", "isDefaultSigner"] as const;

function emptyToNull(value: string): string | null {
  return value.length > 0 ? value : null;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function identityColumns(values: FirmIdentityValues) {
  return {
    legalName: values.legalName,
    addressLines: values.addressLines,
    phone: emptyToNull(values.phone),
    fax: emptyToNull(values.fax),
    email: emptyToNull(values.email),
    website: emptyToNull(values.website),
    licensureLine: emptyToNull(values.licensureLine),
  };
}

function attorneyColumns(values: FirmAttorneyValues) {
  return {
    fullName: values.fullName,
    title: emptyToNull(values.title),
    role: values.role,
    barState: emptyToNull(values.barState),
    barNumber: emptyToNull(values.barNumber),
    eoirId: emptyToNull(values.eoirId),
    email: emptyToNull(values.email),
    isDefaultSigner: values.isDefaultSigner,
  };
}

function toIdentityView(row: FirmIdentityRow): FirmIdentityView {
  return {
    legalName: row.legalName,
    addressLines: row.addressLines,
    phone: row.phone,
    fax: row.fax,
    email: row.email,
    website: row.website,
    licensureLine: row.licensureLine,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAttorneyView(row: FirmAttorneyRow): FirmAttorneyView {
  return {
    id: row.id,
    fullName: row.fullName,
    title: row.title,
    role: row.role,
    barState: row.barState,
    barNumber: row.barNumber,
    eoirId: row.eoirId,
    email: row.email,
    isDefaultSigner: row.isDefaultSigner,
    signature:
      row.signatureS3Key && row.signatureMediaType && row.signatureUploadedAt
        ? {
            mediaType: row.signatureMediaType,
            sizeBytes: row.signatureSizeBytes ?? 0,
            widthPx: row.signatureWidthPx,
            heightPx: row.signatureHeightPx,
            uploadedAt: row.signatureUploadedAt.toISOString(),
          }
        : null,
  };
}

/** What the Firm page shows: the identity (null until first saved) and the roster, without storage keys. */
export async function getFirmIdentityPageData(
  tenantId: string
): Promise<{ identity: FirmIdentityView | null; attorneys: FirmAttorneyView[] }> {
  return withTenantContext(tenantId, async (tx) => {
    const [identity] = await tx.select().from(firmIdentities).where(eq(firmIdentities.tenantId, tenantId)).limit(1);
    const attorneys = await tx
      .select()
      .from(firmAttorneys)
      .where(eq(firmAttorneys.tenantId, tenantId))
      .orderBy(...ROSTER_ORDER);
    return { identity: identity ? toIdentityView(identity) : null, attorneys: attorneys.map(toAttorneyView) };
  });
}

/**
 * Creates or updates the tenant's letterhead details. The audit entry names
 * the fields that changed, not their values (audit_logs is permanent).
 */
export async function saveFirmIdentity(
  tenantId: string,
  actorUserId: string,
  values: FirmIdentityValues
): Promise<FirmIdentityView> {
  return retryOnConcurrentChange(() =>
    withTenantContext(tenantId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(firmIdentities)
        .where(eq(firmIdentities.tenantId, tenantId))
        .limit(1)
        .for("update");
      const next = identityColumns(values);
      const changedFields = IDENTITY_FIELDS.filter((f) => !sameValue(existing?.[f], next[f]));
      if (existing && changedFields.length === 0) return toIdentityView(existing);

      const [row] = existing
        ? await tx
            .update(firmIdentities)
            .set({ ...next, updatedBy: actorUserId, updatedAt: new Date() })
            .where(and(eq(firmIdentities.id, existing.id), eq(firmIdentities.tenantId, tenantId)))
            .returning()
        : await tx
            .insert(firmIdentities)
            .values({ tenantId, ...next, updatedBy: actorUserId })
            .returning();

      await recordAuditEvent(tx, {
        tenantId,
        actorUserId,
        action: AUDIT_ACTIONS.firmIdentityUpdated,
        resourceType: "firm_identity",
        resourceId: row.id,
        before: existing ? { exists: true } : null,
        after: { created: !existing, changedFields },
      });
      return toIdentityView(row);
    })
  );
}

/** Clears the current default signer (other than `exceptId`), auditing the change on that entry. */
async function clearDefaultSigner(tx: Tx, tenantId: string, actorUserId: string, exceptId: string | null) {
  const cleared = await tx
    .update(firmAttorneys)
    .set({ isDefaultSigner: false, updatedAt: new Date() })
    .where(and(eq(firmAttorneys.tenantId, tenantId), eq(firmAttorneys.isDefaultSigner, true)))
    .returning({ id: firmAttorneys.id });
  for (const { id } of cleared) {
    if (id === exceptId) continue;
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId,
      action: AUDIT_ACTIONS.firmAttorneyUpdated,
      resourceType: "firm_attorney",
      resourceId: id,
      before: { isDefaultSigner: true },
      after: { changedFields: ["isDefaultSigner"], isDefaultSigner: false },
    });
  }
}

/**
 * Adds a person to the roster. The first person added becomes the default
 * signer even if not marked, so a one-attorney firm never runs without one;
 * marking a later entry as default moves the default to it.
 */
export async function addFirmAttorney(
  tenantId: string,
  actorUserId: string,
  values: FirmAttorneyValues
): Promise<FirmAttorneyView> {
  return retryOnConcurrentChange(() =>
    withTenantContext(tenantId, async (tx) => {
      const [anyEntry] = await tx
        .select({ id: firmAttorneys.id })
        .from(firmAttorneys)
        .where(eq(firmAttorneys.tenantId, tenantId))
        .limit(1);
      const columns = attorneyColumns(values);
      if (!anyEntry) columns.isDefaultSigner = true;
      if (columns.isDefaultSigner) await clearDefaultSigner(tx, tenantId, actorUserId, null);

      const [row] = await tx
        .insert(firmAttorneys)
        .values({ tenantId, ...columns })
        .returning();
      await recordAuditEvent(tx, {
        tenantId,
        actorUserId,
        action: AUDIT_ACTIONS.firmAttorneyAdded,
        resourceType: "firm_attorney",
        resourceId: row.id,
        after: { role: row.role, isDefaultSigner: row.isDefaultSigner },
      });
      return toAttorneyView(row);
    })
  );
}

/** One of the tenant's roster entries (row-locked unless lock is false); refuses an unknown id. */
async function lockAttorney(tx: Tx, tenantId: string, attorneyId: string, lock = true): Promise<FirmAttorneyRow> {
  if (!UUID_RE.test(attorneyId)) throw new FirmIdentityRequestError("That roster entry was not found.");
  const query = tx
    .select()
    .from(firmAttorneys)
    .where(and(eq(firmAttorneys.id, attorneyId), eq(firmAttorneys.tenantId, tenantId)))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw new FirmIdentityRequestError("That roster entry was not found. Reload the page.");
  return row;
}

/** Updates a roster entry; marking it default signer moves the default to it. */
export async function updateFirmAttorney(
  tenantId: string,
  actorUserId: string,
  attorneyId: string,
  values: FirmAttorneyValues
): Promise<FirmAttorneyView> {
  return retryOnConcurrentChange(() =>
    withTenantContext(tenantId, async (tx) => {
      const existing = await lockAttorney(tx, tenantId, attorneyId);
      const next = attorneyColumns(values);
      const changedFields = ATTORNEY_FIELDS.filter((f) => !sameValue(existing[f], next[f]));
      if (changedFields.length === 0) return toAttorneyView(existing);
      if (next.isDefaultSigner && !existing.isDefaultSigner) {
        await clearDefaultSigner(tx, tenantId, actorUserId, existing.id);
      }
      const [row] = await tx
        .update(firmAttorneys)
        .set({ ...next, updatedAt: new Date() })
        .where(and(eq(firmAttorneys.id, existing.id), eq(firmAttorneys.tenantId, tenantId)))
        .returning();
      await recordAuditEvent(tx, {
        tenantId,
        actorUserId,
        action: AUDIT_ACTIONS.firmAttorneyUpdated,
        resourceType: "firm_attorney",
        resourceId: row.id,
        before: { role: existing.role, isDefaultSigner: existing.isDefaultSigner },
        after: { changedFields, role: row.role, isDefaultSigner: row.isDefaultSigner },
      });
      return toAttorneyView(row);
    })
  );
}

/**
 * Removes a roster entry. Its signature image is no longer reachable from
 * the app (nothing references the key); the S3 object itself stays, since
 * the app's IAM policy has no delete permission (see README, "Firm identity").
 */
export async function removeFirmAttorney(tenantId: string, actorUserId: string, attorneyId: string): Promise<void> {
  await withTenantContext(tenantId, async (tx) => {
    const existing = await lockAttorney(tx, tenantId, attorneyId);
    await tx
      .delete(firmAttorneys)
      .where(and(eq(firmAttorneys.id, existing.id), eq(firmAttorneys.tenantId, tenantId)));
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId,
      action: AUDIT_ACTIONS.firmAttorneyRemoved,
      resourceType: "firm_attorney",
      resourceId: existing.id,
      before: {
        role: existing.role,
        isDefaultSigner: existing.isDefaultSigner,
        hadSignature: Boolean(existing.signatureS3Key),
      },
    });
  });
}

/**
 * Validates, sanitizes and stores a signature image for a roster entry,
 * replacing any earlier one (see signature-image.ts for why this is used
 * instead of the upload malware scan). The sanitized bytes are what is
 * stored, pinned to the S3 version written, with their sha256.
 */
export async function uploadFirmSignature(
  tenantId: string,
  actorUserId: string,
  attorneyId: string,
  fileBytes: Uint8Array
): Promise<FirmAttorneyView> {
  const check = sanitizeSignatureImage(fileBytes);
  if (!check.ok) throw new FirmIdentityRequestError(check.error);
  const image = check.image;

  // Refuse a bad id before writing anything to storage.
  await withTenantContext(tenantId, (tx) => lockAttorney(tx, tenantId, attorneyId, false));
  const stored = await putFirmSignature({ tenantId, attorneyId, mediaType: image.mediaType, body: image.bytes });

  return withTenantContext(tenantId, async (tx) => {
    // Removed meanwhile: the object just written is left unreferenced.
    const existing = await lockAttorney(tx, tenantId, attorneyId);
    const [row] = await tx
      .update(firmAttorneys)
      .set({
        signatureS3Bucket: stored.bucket,
        signatureS3Key: stored.key,
        signatureS3VersionId: stored.versionId,
        signatureMediaType: image.mediaType,
        signatureSizeBytes: image.bytes.length,
        signatureSha256: image.sha256,
        signatureWidthPx: image.widthPx,
        signatureHeightPx: image.heightPx,
        signatureUploadedBy: actorUserId,
        signatureUploadedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(firmAttorneys.id, existing.id), eq(firmAttorneys.tenantId, tenantId)))
      .returning();
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId,
      action: AUDIT_ACTIONS.firmSignatureUploaded,
      resourceType: "firm_attorney",
      resourceId: row.id,
      before: { sha256: existing.signatureSha256 },
      after: {
        sha256: image.sha256,
        mediaType: image.mediaType,
        sizeBytes: image.bytes.length,
        widthPx: image.widthPx,
        heightPx: image.heightPx,
        originalSizeBytes: fileBytes.byteLength,
      },
    });
    return toAttorneyView(row);
  });
}

/** Removes a roster entry's signature image; later documents get a /s/ line instead. */
export async function removeFirmSignature(
  tenantId: string,
  actorUserId: string,
  attorneyId: string
): Promise<FirmAttorneyView> {
  return withTenantContext(tenantId, async (tx) => {
    const existing = await lockAttorney(tx, tenantId, attorneyId);
    if (!existing.signatureS3Key) return toAttorneyView(existing);
    const [row] = await tx
      .update(firmAttorneys)
      .set({
        signatureS3Bucket: null,
        signatureS3Key: null,
        signatureS3VersionId: null,
        signatureMediaType: null,
        signatureSizeBytes: null,
        signatureSha256: null,
        signatureWidthPx: null,
        signatureHeightPx: null,
        signatureUploadedBy: null,
        signatureUploadedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(firmAttorneys.id, existing.id), eq(firmAttorneys.tenantId, tenantId)))
      .returning();
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId,
      action: AUDIT_ACTIONS.firmSignatureRemoved,
      resourceType: "firm_attorney",
      resourceId: row.id,
      before: { sha256: existing.signatureSha256 },
    });
    return toAttorneyView(row);
  });
}

function storedMediaType(value: string | null): SignatureMediaType | null {
  return value === "image/png" || value === "image/jpeg" ? value : null;
}

/**
 * A short-lived presigned URL to preview a roster entry's signature in the
 * Firm page, audited in the same transaction. The caller checks the role
 * (FIRM_IDENTITY_EDIT_ROLES): no other path serves a signature to a browser.
 */
export async function issueFirmSignaturePreviewUrl(
  tenantId: string,
  actorUserId: string,
  attorneyId: string
): Promise<string> {
  return withTenantContext(tenantId, async (tx) => {
    const row = await lockAttorney(tx, tenantId, attorneyId, false);
    const mediaType = storedMediaType(row.signatureMediaType);
    if (!row.signatureS3Key || !row.signatureS3Bucket || !mediaType) {
      throw new FirmIdentityRequestError("No signature image is on file for this person.");
    }
    const url = await getFirmSignaturePreviewUrl({
      bucket: row.signatureS3Bucket,
      key: row.signatureS3Key,
      versionId: row.signatureS3VersionId,
      mediaType,
    });
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId,
      action: AUDIT_ACTIONS.firmSignaturePreviewIssued,
      resourceType: "firm_attorney",
      resourceId: row.id,
      after: { sha256: row.signatureSha256, expiresInSeconds: SIGNATURE_PREVIEW_URL_EXPIRES_SECONDS },
    });
    return url;
  });
}

/**
 * The firm identity as a skill run records and uses it, read with the
 * caller's transaction (enqueueSkillRun reads it in the same transaction that
 * creates the run). Never includes storage keys.
 */
export async function loadFirmIdentitySnapshot(tx: Tx, tenantId: string): Promise<FirmIdentitySnapshot> {
  const [identity] = await tx.select().from(firmIdentities).where(eq(firmIdentities.tenantId, tenantId)).limit(1);
  const roster = await tx
    .select()
    .from(firmAttorneys)
    .where(eq(firmAttorneys.tenantId, tenantId))
    .orderBy(...ROSTER_ORDER);
  return {
    capturedAt: new Date().toISOString(),
    firm: identity
      ? {
          legalName: identity.legalName,
          addressLines: identity.addressLines,
          phone: identity.phone,
          fax: identity.fax,
          email: identity.email,
          website: identity.website,
          licensureLine: identity.licensureLine,
        }
      : null,
    attorneys: roster.map((a) => ({
      id: a.id,
      fullName: a.fullName,
      title: a.title,
      role: a.role,
      barState: a.barState,
      barNumber: a.barNumber,
      eoirId: a.eoirId,
      email: a.email,
      isDefaultSigner: a.isDefaultSigner,
      hasSignature: Boolean(a.signatureS3Key),
      signatureSha256: a.signatureS3Key ? a.signatureSha256 : null,
    })),
  };
}

export type SignerSignature = {
  /** The stored, sanitized image bytes. */
  bytes: Buffer;
  mediaType: SignatureMediaType;
  /** sha256 (hex) of `bytes`; record it wherever the signature is applied. */
  sha256: string;
  widthPx: number;
  heightPx: number;
};

/**
 * For generator tools: the signature image of one of the tenant's roster
 * entries, or null when that entry does not exist (for this tenant) or has
 * no signature on file. Reads the stored version, checks it against the
 * sha256 recorded at upload and validates it again, and throws when either
 * fails, so a document is never signed with an image other than the one
 * the firm uploaded. Server-only; the bytes never go to a browser.
 */
export async function getSignerSignature(tenantId: string, attorneyId: string): Promise<SignerSignature | null> {
  if (!UUID_RE.test(attorneyId)) return null;
  const row = await withTenantContext(tenantId, async (tx) => {
    const [found] = await tx
      .select()
      .from(firmAttorneys)
      .where(and(eq(firmAttorneys.id, attorneyId), eq(firmAttorneys.tenantId, tenantId)))
      .limit(1);
    return found ?? null;
  });
  const mediaType = storedMediaType(row?.signatureMediaType ?? null);
  if (!row || !row.signatureS3Key || !row.signatureS3Bucket || !row.signatureSha256 || !mediaType) return null;

  const bytes = await getObjectBytes({
    bucket: row.signatureS3Bucket,
    key: row.signatureS3Key,
    versionId: row.signatureS3VersionId,
    maxBytes: SIGNATURE_MAX_BYTES,
  });
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const check = sanitizeSignatureImage(bytes);
  if (sha256 !== row.signatureSha256 || !check.ok || check.image.mediaType !== mediaType) {
    throw new Error(
      `The stored signature image for ${row.fullName} does not match the one uploaded, so it was not used. ` +
        "Upload the signature again on the Firm page."
    );
  }
  return { bytes, mediaType, sha256, widthPx: check.image.widthPx, heightPx: check.image.heightPx };
}

/**
 * Audits a generator embedding a roster entry's signature in a document.
 * Called with the transaction that creates the document row
 * (createGeneratedDocument's inTransaction hook).
 */
export async function recordFirmSignatureApplied(
  tx: Tx,
  event: {
    tenantId: string;
    attorneyId: string;
    documentId: string;
    matterId: string;
    sha256: string;
    requestedBy: string;
    skillRunId: string | null;
  }
): Promise<void> {
  await recordAuditEvent(tx, {
    tenantId: event.tenantId,
    actorUserId: SYSTEM_ACTORS.skillRunWorker,
    action: AUDIT_ACTIONS.firmSignatureApplied,
    resourceType: "firm_attorney",
    resourceId: event.attorneyId,
    after: {
      documentId: event.documentId,
      matterId: event.matterId,
      sha256: event.sha256,
      requestedBy: event.requestedBy,
      skillRunId: event.skillRunId,
    },
  });
}
