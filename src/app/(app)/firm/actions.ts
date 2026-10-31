"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { FIRM_IDENTITY_EDIT_ROLES, ForbiddenRoleError, getCurrentEntitledTenant, requireRole } from "@/lib/tenant";
import { EntitlementLockedError } from "@/lib/billing/entitlement";
import {
  SIGNATURE_MAX_BYTES,
  firmAttorneyInputSchema,
  firmIdentityInputSchema,
  type FirmAttorneyView,
  type FirmIdentityView,
} from "@/lib/firm-identity/schema";
import {
  FirmIdentityRequestError,
  addFirmAttorney,
  issueFirmSignaturePreviewUrl,
  removeFirmAttorney,
  removeFirmSignature,
  saveFirmIdentity,
  updateFirmAttorney,
  uploadFirmSignature,
} from "@/lib/firm-identity/service";
import { SIGNATURE_PREVIEW_URL_EXPIRES_SECONDS } from "@/lib/s3";

// Every action here changes what the app prints on documents as the firm's
// letterhead and under an attorney's name and signature (or hands out a
// signature image), so each one starts with getCurrentEntitledTenant (a
// locked firm changes nothing), checks FIRM_IDENTITY_EDIT_ROLES
// (owner/admin, attorney), validates its browser-supplied input, and
// returns expected refusals as { ok: false } rather than throwing them. The
// service layer audits every change.

type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function issuesMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join(" ");
}

async function editor(action: string) {
  const { tenant, membership, userId } = await getCurrentEntitledTenant(action);
  requireRole(membership, FIRM_IDENTITY_EDIT_ROLES, action);
  return { tenantId: tenant.id, userId };
}

async function run<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof FirmIdentityRequestError || err instanceof ForbiddenRoleError || err instanceof EntitlementLockedError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

function attorneyIdOrError(attorneyId: unknown): string | null {
  return typeof attorneyId === "string" && UUID_RE.test(attorneyId) ? attorneyId : null;
}

export async function saveFirmIdentityAction(input: unknown): Promise<ActionResult<{ identity: FirmIdentityView }>> {
  return run<{ identity: FirmIdentityView }>(async () => {
    const { tenantId, userId } = await editor("edit the firm identity");
    const parsed = firmIdentityInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: issuesMessage(parsed.error) };
    const identity = await saveFirmIdentity(tenantId, userId, parsed.data);
    revalidatePath("/firm");
    return { ok: true, identity };
  });
}

export async function addFirmAttorneyAction(input: unknown): Promise<ActionResult<{ attorney: FirmAttorneyView }>> {
  return run<{ attorney: FirmAttorneyView }>(async () => {
    const { tenantId, userId } = await editor("edit the firm's attorney roster");
    const parsed = firmAttorneyInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: issuesMessage(parsed.error) };
    const attorney = await addFirmAttorney(tenantId, userId, parsed.data);
    revalidatePath("/firm");
    return { ok: true, attorney };
  });
}

export async function updateFirmAttorneyAction(
  attorneyId: unknown,
  input: unknown
): Promise<ActionResult<{ attorney: FirmAttorneyView }>> {
  return run<{ attorney: FirmAttorneyView }>(async () => {
    const { tenantId, userId } = await editor("edit the firm's attorney roster");
    const id = attorneyIdOrError(attorneyId);
    if (!id) return { ok: false, error: "That roster entry was not found." };
    const parsed = firmAttorneyInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: issuesMessage(parsed.error) };
    const attorney = await updateFirmAttorney(tenantId, userId, id, parsed.data);
    revalidatePath("/firm");
    return { ok: true, attorney };
  });
}

export async function removeFirmAttorneyAction(attorneyId: unknown): Promise<ActionResult<object>> {
  return run<object>(async () => {
    const { tenantId, userId } = await editor("edit the firm's attorney roster");
    const id = attorneyIdOrError(attorneyId);
    if (!id) return { ok: false, error: "That roster entry was not found." };
    await removeFirmAttorney(tenantId, userId, id);
    revalidatePath("/firm");
    return { ok: true };
  });
}

/**
 * Uploads a signature image: FormData with `attorneyId` and `file`. The
 * bytes come through this action (never a presigned PUT) so the server
 * validates and stores exactly what it checked (see signature-image.ts).
 */
export async function uploadFirmSignatureAction(formData: FormData): Promise<ActionResult<{ attorney: FirmAttorneyView }>> {
  return run<{ attorney: FirmAttorneyView }>(async () => {
    const { tenantId, userId } = await editor("upload signature images");
    const id = attorneyIdOrError(formData.get("attorneyId"));
    if (!id) return { ok: false, error: "That roster entry was not found." };
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a PNG or JPEG image to upload." };
    if (file.size > SIGNATURE_MAX_BYTES) {
      return { ok: false, error: `Signature images are limited to ${SIGNATURE_MAX_BYTES / 1024} KB.` };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const attorney = await uploadFirmSignature(tenantId, userId, id, bytes);
    revalidatePath("/firm");
    return { ok: true, attorney };
  });
}

export async function removeFirmSignatureAction(attorneyId: unknown): Promise<ActionResult<{ attorney: FirmAttorneyView }>> {
  return run<{ attorney: FirmAttorneyView }>(async () => {
    const { tenantId, userId } = await editor("remove signature images");
    const id = attorneyIdOrError(attorneyId);
    if (!id) return { ok: false, error: "That roster entry was not found." };
    const attorney = await removeFirmSignature(tenantId, userId, id);
    revalidatePath("/firm");
    return { ok: true, attorney };
  });
}

/** A short-lived, audited preview URL; only owner/admin and attorney users get one. */
export async function previewFirmSignatureAction(
  attorneyId: unknown
): Promise<ActionResult<{ url: string; expiresInSeconds: number }>> {
  return run<{ url: string; expiresInSeconds: number }>(async () => {
    const { tenantId, userId } = await editor("view signature images");
    const id = attorneyIdOrError(attorneyId);
    if (!id) return { ok: false, error: "That roster entry was not found." };
    const url = await issueFirmSignaturePreviewUrl(tenantId, userId, id);
    return { ok: true, url, expiresInSeconds: SIGNATURE_PREVIEW_URL_EXPIRES_SECONDS };
  });
}
