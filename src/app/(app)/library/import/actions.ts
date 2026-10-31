"use server";

import { revalidatePath } from "next/cache";
import { getCurrentEntitledTenant } from "@/lib/tenant";
import { EntitlementLockedError } from "@/lib/billing/entitlement";
import { importFromOfficialSite, isLibraryImportAdmin, LibraryImportForbiddenError } from "@/services/library/import-service";
import { IMPORT_MAX_BYTES } from "@/services/library/manual-import";

// The one thing /library/import does: hand the app a page or file a
// platform operator saved from an official site. The operator imports from
// a firm's session, so a locked firm (free month or subscription ended)
// imports nothing (getCurrentEntitledTenant); the operator check follows
// (and importFromOfficialSite checks it again); the files are read here
// and checked, parsed and stored by the library's own import
// (src/services/library/manual-import.ts), which writes the audit log row
// whatever the outcome. Expected refusals come back as { ok: false } rather
// than being thrown.

export type ImportActionState =
  | null
  | { ok: true; message: string; documentId: string; notes: string[] }
  | { ok: false; message: string };

/** A file field: null when none was chosen; an error message when it is not a usable file. */
async function readFile(value: FormDataEntryValue | null, declaredSize: FormDataEntryValue | null, what: string): Promise<Buffer | null | string> {
  if (value === null || (value instanceof File && value.size === 0 && !value.name)) return null;
  if (!(value instanceof File)) return `The ${what} is not a file.`;
  if (value.size === 0) return `The ${what} is empty.`;
  if (value.size > IMPORT_MAX_BYTES) return `The ${what} is larger than ${IMPORT_MAX_BYTES / 1048576} MB.`;
  // The browser states the file's size before it sends it: a request cut short on the way is refused, not imported in part.
  if (typeof declaredSize === "string" && declaredSize !== "" && Number(declaredSize) !== value.size) {
    return `The ${what} did not arrive whole (${value.size} of ${declaredSize} bytes). Try again.`;
  }
  return Buffer.from(await value.arrayBuffer());
}

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function importFromOfficialSiteAction(_previous: ImportActionState, formData: FormData): Promise<ImportActionState> {
  let tenant;
  let userId;
  try {
    ({ tenant, userId } = await getCurrentEntitledTenant("import into the library"));
  } catch (err) {
    if (err instanceof EntitlementLockedError) return { ok: false, message: err.message };
    throw err;
  }
  if (!isLibraryImportAdmin(userId)) return { ok: false, message: new LibraryImportForbiddenError().message };

  const code = text(formData.get("source"));
  const url = text(formData.get("url"));
  const linkedUrl = text(formData.get("linkedUrl"));
  if (!code) return { ok: false, message: "Choose the source." };
  if (!url) return { ok: false, message: "Give the official address the page or file was saved from." };
  const bytes = await readFile(formData.get("file"), formData.get("fileSize"), "file");
  if (bytes === null) return { ok: false, message: "Choose the saved page or file." };
  if (typeof bytes === "string") return { ok: false, message: bytes };
  const linkedBytes = await readFile(formData.get("linkedFile"), formData.get("linkedFileSize"), "linked file");
  if (typeof linkedBytes === "string") return { ok: false, message: linkedBytes };

  let result;
  try {
    result = await importFromOfficialSite({ code, url, bytes, linkedUrl: linkedUrl || null, linkedBytes, importedBy: userId, tenantId: tenant.id });
  } catch (err) {
    if (err instanceof LibraryImportForbiddenError) return { ok: false, message: err.message };
    throw err;
  }
  revalidatePath("/library");
  revalidatePath("/library/import");
  if (!result.ok) {
    return { ok: false, message: result.outcome === "rejected" ? `Not imported: ${result.error}` : `The import failed: ${result.error}` };
  }
  const what = result.outcome === "inserted" ? "Added to the library" : result.outcome === "updated" ? `Updated (now version ${result.version})` : "Already in the library, unchanged";
  return { ok: true, message: `${what}: ${result.title}.`, documentId: result.documentId, notes: result.notes.slice(1) };
}
