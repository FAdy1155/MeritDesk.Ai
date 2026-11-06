import "server-only";
import { desc } from "drizzle-orm";
import { withGlobalReadContext, withServiceContext } from "@/db/client";
import { libraryImportLog } from "@/db/schema";
import { putLibraryOriginal } from "@/lib/s3";
import type { LibraryTransactions } from "./db";
import { isPlatformOperator } from "@/lib/platform-admin";
import { IMPORT_MAX_BYTES, runManualImport, type ManualImportRequest, type ManualImportResult } from "./manual-import";
import { importableAdapters, isManualSource } from "./registry";
import { listSources } from "./search";
import type { ManualImportPath } from "./types";

// What /library/import uses: who may import, the importable sources with
// their standing, the recent imports, and the import itself
// (./manual-import.ts), in service context like the worker's writes.
//
// Who may import: platform operators, listed by Clerk user id in
// LIBRARY_IMPORT_ADMINS, and nobody else, whatever their role in a firm.
// The library is global: one copy shared by every firm, read by every
// firm's skill runs and pages. An import changes what all of them read, so
// it is not a decision any one firm can make, and a firm's owner_admin
// (which any firm's own administrator can grant in Clerk) is not the right
// gate. The operators are the people who run the deployment and answer for
// what the library holds; the list lives in the deployment's environment,
// next to the worker's other library settings, where no firm can change it.
// Unset or empty, nobody can import.

/** Whether this signed-in user may import into the library (a platform operator, LIBRARY_IMPORT_ADMINS). */
export function isLibraryImportAdmin(userId: string | null | undefined): boolean {
  return isPlatformOperator(userId);
}

/** Thrown when someone outside LIBRARY_IMPORT_ADMINS tries to import; the message is safe to show. */
export class LibraryImportForbiddenError extends Error {
  constructor() {
    super("Importing into the library is limited to the platform's operators (LIBRARY_IMPORT_ADMINS), because the library is shared by every firm.");
    this.name = "LibraryImportForbiddenError";
  }
}

const transactions: LibraryTransactions = {
  write: (fn) => withServiceContext((tx) => fn(tx)),
  read: (fn) => withGlobalReadContext((tx) => fn(tx)),
};

/** Imports one file for a platform operator (checked here as well as by the page and the action). */
export async function importFromOfficialSite(request: ManualImportRequest): Promise<ManualImportResult> {
  if (!isLibraryImportAdmin(request.importedBy)) throw new LibraryImportForbiddenError();
  return runManualImport(request, {
    tx: transactions,
    storeOriginal: process.env.LIBRARY_STORE_ORIGINALS === "true" ? putLibraryOriginal : null,
    log: (line) => console.log(line),
  });
}

export type ImportableSourceView = {
  code: string;
  name: string;
  officialUrl: string;
  intervalDays: number;
  manual: boolean;
  documentCount: number;
  lastImportAt: Date | null;
  stale: boolean;
  paths: { role: ManualImportPath["role"]; file: ManualImportPath["file"]; label: string }[];
};

export type ImportLogView = {
  at: Date;
  sourceCode: string;
  officialUrl: string;
  outcome: string;
  errorMessage: string | null;
  externalId: string | null;
  documentId: string | null;
  documentVersion: number | null;
};

/** The sources that can be imported, with their standing, and the latest imports (for the operators' page). */
export async function loadImportPage(): Promise<{ sources: ImportableSourceView[]; recent: ImportLogView[]; maxBytes: number }> {
  const { rows, log } = await withGlobalReadContext(async (tx) => ({
    rows: await listSources(tx),
    log: await tx.select().from(libraryImportLog).orderBy(desc(libraryImportLog.createdAt)).limit(25),
  }));
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const sources = importableAdapters().map((adapter): ImportableSourceView => {
    const row = byCode.get(adapter.code);
    const at = (row?.freshness.lastManualImport as { at?: unknown } | undefined)?.at;
    return {
      code: adapter.code,
      name: adapter.name,
      officialUrl: adapter.officialUrl,
      intervalDays: adapter.manualImportIntervalDays ?? 0,
      manual: isManualSource(adapter.code),
      documentCount: row?.documentCount ?? 0,
      lastImportAt: typeof at === "string" ? new Date(at) : null,
      stale: row?.stale ?? true,
      paths: (adapter.manualImportPaths ?? []).map((p) => ({ role: p.role, file: p.file, label: p.label })),
    };
  });
  const recent = log.map((l) => ({
    at: l.createdAt,
    sourceCode: l.sourceCode,
    officialUrl: l.officialUrl,
    outcome: l.outcome,
    errorMessage: l.errorMessage,
    externalId: l.externalId,
    documentId: l.documentId,
    documentVersion: l.documentVersion,
  }));
  return { sources, recent, maxBytes: IMPORT_MAX_BYTES };
}
