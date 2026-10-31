"use server";

import { revalidatePath } from "next/cache";
import { EDITOR_ROLES, ForbiddenRoleError, getCurrentEntitledTenant, requireRole } from "@/lib/tenant";
import { EntitlementLockedError } from "@/lib/billing/entitlement";
import {
  createMatter,
  addMatterParty,
  isMatterPartyRole,
  updateMatterDetails,
  MatterRequestError,
} from "@/lib/matters/service";
import { matterDetailsInputSchema, matterIssuesMessage, newMatterInputSchema } from "@/lib/matters/details-schema";
import { initiateDocumentUpload, getDocumentDownloadUrl, requestDocumentIngest } from "@/lib/documents/service";
import { documentTypeEnum } from "@/db/schema";

// Every action here starts with getCurrentEntitledTenant: a locked firm
// (free month or subscription ended, README "Trial, billing and emails")
// can neither change its matters and documents nor get a download link;
// the error's message says to subscribe. The role check follows.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The matters list's create form. Its fields arrive from the browser, so
 * they are validated here (case type and venue from their lists, dates as
 * real YYYY-MM-DD dates) before anything is stored: skill runs read them.
 */
export async function createMatterAction(input: unknown) {
  const { tenant, membership, userId } = await getCurrentEntitledTenant("create matters");
  requireRole(membership, EDITOR_ROLES, "create matters");
  const parsed = newMatterInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(matterIssuesMessage(parsed.error));
  const row = await createMatter(tenant.id, userId, parsed.data);
  revalidatePath("/matters");
  return row;
}

/**
 * The matter page's details form: status, venue, circuit, court and the key
 * dates. Expected refusals (invalid input, a role that may not edit, a
 * locked firm, a matter that is not this firm's) come back as
 * { ok: false, error } rather than as a thrown error, whose message
 * production builds would hide. The service records matter.update with the
 * names of the changed fields.
 */
export async function updateMatterDetailsAction(
  matterId: string,
  input: unknown
): Promise<{ ok: true; changedFields: string[] } | { ok: false; error: string }> {
  // Arrives from the browser: check the shape before it reaches a uuid column.
  if (typeof matterId !== "string" || !UUID_RE.test(matterId)) {
    return { ok: false, error: "Invalid matter id." };
  }
  try {
    const { tenant, membership, userId } = await getCurrentEntitledTenant("edit matter details");
    requireRole(membership, EDITOR_ROLES, "edit matter details");
    const parsed = matterDetailsInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: matterIssuesMessage(parsed.error) };
    const { changedFields } = await updateMatterDetails(tenant.id, userId, matterId, parsed.data);
    if (changedFields.length > 0) {
      revalidatePath(`/matters/${matterId}`);
      revalidatePath("/matters");
    }
    return { ok: true, changedFields };
  } catch (err) {
    if (err instanceof MatterRequestError || err instanceof ForbiddenRoleError || err instanceof EntitlementLockedError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

/**
 * The matter page's add-party form. Every argument arrives from the browser
 * (a Server Action can be called with anything), so the ids are checked for
 * shape and the role against the list here, and the service checks that the
 * matter and the client are this firm's. Returns only the new party's id.
 */
export async function addMatterPartyAction(matterId: unknown, clientId: unknown, role: unknown) {
  if (typeof matterId !== "string" || !UUID_RE.test(matterId)) throw new Error("Invalid matter id");
  if (typeof clientId !== "string" || !UUID_RE.test(clientId)) throw new Error("Invalid client id");
  if (!isMatterPartyRole(role)) throw new Error("Invalid role");
  const { tenant, membership, userId } = await getCurrentEntitledTenant("add parties to a matter");
  requireRole(membership, EDITOR_ROLES, "add parties to a matter");
  const row = await addMatterParty(tenant.id, userId, matterId, clientId, role);
  revalidatePath(`/matters/${matterId}`);
  return { id: row.id };
}

export async function initiateDocumentUploadAction(params: {
  matterId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  type: (typeof documentTypeEnum.enumValues)[number];
}) {
  if (typeof params.matterId !== "string" || !UUID_RE.test(params.matterId)) {
    throw new Error("Invalid matter id");
  }
  const { tenant, membership, userId } = await getCurrentEntitledTenant("upload documents");
  requireRole(membership, EDITOR_ROLES, "upload documents");
  const result = await initiateDocumentUpload({
    tenantId: tenant.id,
    matterId: params.matterId,
    fileName: params.fileName,
    contentType: params.contentType,
    sizeBytes: params.sizeBytes,
    type: params.type,
    uploadedBy: userId,
  });
  revalidatePath(`/matters/${params.matterId}`);
  return result;
}

/**
 * Queues the malware scan and text extraction for an uploaded document. The
 * uploader calls this once its browser PUT to S3 has succeeded; the matter
 * page calls it again for a document whose scan errored or stalled.
 */
export async function requestDocumentIngestAction(documentId: string) {
  // Arrives from the browser: check the shape before it reaches a uuid column.
  if (typeof documentId !== "string" || !UUID_RE.test(documentId)) {
    throw new Error("Invalid document id");
  }
  const { tenant, membership } = await getCurrentEntitledTenant("queue document scans");
  requireRole(membership, EDITOR_ROLES, "queue document scans");
  const { matterId } = await requestDocumentIngest(tenant.id, documentId);
  revalidatePath(`/matters/${matterId}`);
}

export async function getDocumentDownloadUrlAction(documentId: string) {
  // Arrives from the browser: check the shape before it reaches a uuid column.
  if (typeof documentId !== "string" || !UUID_RE.test(documentId)) {
    throw new Error("Invalid document id");
  }
  // Open to every role, read_only included, but not to a locked firm (a
  // download discloses data). Refuses any document that has not passed the
  // malware scan; audits every URL issued and every refusal.
  const { tenant, userId } = await getCurrentEntitledTenant("download documents");
  return getDocumentDownloadUrl(tenant.id, documentId, userId);
}
