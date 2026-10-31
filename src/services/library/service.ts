import "server-only";
import { withGlobalReadContext } from "@/db/client";
import { getLibraryOriginalUrl } from "@/lib/s3";
import {
  documentOriginal,
  LIBRARY_SEARCH_TIMEOUT_MS,
  listSources,
  readDocument,
  searchLibrary,
  type LibraryDocumentView,
  type LibrarySearchParams,
  type LibrarySearchResult,
  type LibrarySourceStatusRow,
} from "./search";

// What the /library pages use: the read functions of ./search.ts, each in a
// read-only global transaction (withGlobalReadContext). The library is the
// same for every firm and read-only to every role; the pages still require a
// signed-in member of an organization (getCurrentTenant), as every app page does.

export async function loadLibrarySources(): Promise<LibrarySourceStatusRow[]> {
  return withGlobalReadContext((tx) => listSources(tx));
}

export async function searchLibraryForPage(params: LibrarySearchParams): Promise<LibrarySearchResult> {
  return withGlobalReadContext((tx) => searchLibrary(tx, params), { statementTimeoutMs: LIBRARY_SEARCH_TIMEOUT_MS });
}

export async function loadLibraryDocument(id: string, offset: number): Promise<LibraryDocumentView | null> {
  return withGlobalReadContext((tx) => readDocument(tx, id, offset));
}

/** A 5-minute presigned link to a stored original, or null when none is stored. */
export async function libraryOriginalUrl(id: string): Promise<string | null> {
  const original = await withGlobalReadContext((tx) => documentOriginal(tx, id));
  return original ? getLibraryOriginalUrl(original.key, original.contentType) : null;
}
