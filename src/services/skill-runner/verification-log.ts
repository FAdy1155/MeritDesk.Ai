// What a skill run actually retrieved, as recorded by the app (never by the
// model): one entry per page fetched with fetch_uscis_page or the
// server-side web_fetch tool, one per result the server-side web_search tool
// returned, and one per document the library tools returned
// (src/services/skill-runner/tools/library.ts): "library" for a document
// read or a citation confirmed in the app's own copy of the official
// sources, "library_search" for a search hit seen. Stored on
// skill_runs.verification_log.
//
// Client-safe on purpose (no imports): the matter page uses the helpers
// below to show which sources a report cites that were really retrieved in
// the run, and which it cites without having retrieved them.

export type VerificationSource = "fetch_uscis_page" | "web_fetch" | "web_search" | "library" | "library_search";

export type VerificationLogEntry = {
  /** Which tool produced the entry. Rows written before the web tools existed have none: they are fetch_uscis_page. */
  source?: VerificationSource;
  /**
   * The page fetched (for fetch_uscis_page, the page the content came from,
   * after any redirects), or the search result's URL. Empty for a search that
   * failed outright.
   */
  url: string;
  /** fetch_uscis_page only, when it differs from url: the URL the model asked for. */
  requestedUrl?: string;
  /** fetch_uscis_page only: each URL that redirected, in order, before url. */
  redirects?: string[];
  /** ISO time the page was retrieved (web_fetch's own retrieved_at when the API gives one) or the search result came back. */
  fetchedAt: string;
  /**
   * HTTP status for fetch_uscis_page (0 when the request failed, or
   * "redirect_blocked" / "too_many_redirects"); "ok" or the API's error code
   * (e.g. "url_not_accessible") for web_fetch and web_search.
   */
  status: number | string;
  /** First 16 hex characters of the sha256 of the content the model was given (fetches only). */
  contentHash?: string;
  title?: string | null;
  /** web_search only: the result's age as the search engine reported it (e.g. "March 3, 2025"). */
  pageAge?: string | null;
  /** web_search, and web_fetch errors: the query or URL the model asked for. Library: the search or citation asked for. */
  query?: string;
  /** library only: "read" (text returned from the library's copy) or "lookup" (the citation matched exactly). */
  libraryAction?: "read" | "lookup";
  /** library and library_search: the library document (url is its official URL). */
  libraryDocumentId?: string;
  librarySource?: string;
  librarySourceCode?: string;
  /** When the library last refreshed that source from the official site (ISO), null if never. */
  sourceRefreshedAt?: string | null;
  /** The source's refresh was overdue when it was read. */
  sourceStale?: boolean;
  /** The document's first citation. */
  citation?: string | null;
  precedentialStatus?: string;
  /** library reads: the characters returned ("0-20000 of 45120"). */
  textRange?: string;
};

/**
 * A cited URL's standing against the run's log. "library": the official
 * URL of a document the run read or looked up in the app's library.
 */
export type CitedUrlStatus = "fetched" | "library" | "search_result_only" | "not_retrieved";

export type RetrievedSourcesSummary = {
  /** Pages whose content the model was given, newest entry per URL. */
  fetched: VerificationLogEntry[];
  /** Search results (title and snippet only) not also fetched. */
  searchResults: VerificationLogEntry[];
  /** Fetches and searches that failed. */
  failed: VerificationLogEntry[];
};

/**
 * Lowercased scheme and host without "www.", no fragment, no trailing slash;
 * path and query kept. Used only to compare URLs, never to fetch them.
 */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol.toLowerCase()}//${host}${url.port ? `:${url.port}` : ""}${path}${url.search}`;
  } catch {
    return raw.trim();
  }
}

/** The log as stored (jsonb, so untyped), keeping only well-formed entries. */
export function readVerificationLog(value: unknown): VerificationLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is VerificationLogEntry =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as VerificationLogEntry).url === "string" &&
      typeof (e as VerificationLogEntry).fetchedAt === "string"
  );
}

function succeeded(entry: VerificationLogEntry): boolean {
  if (typeof entry.status === "number") return entry.status >= 200 && entry.status < 400;
  return entry.status === "ok";
}

function isFetch(entry: VerificationLogEntry): boolean {
  return entry.source === undefined || entry.source === "fetch_uscis_page" || entry.source === "web_fetch";
}

function isLibrary(entry: VerificationLogEntry): boolean {
  return entry.source === "library" || entry.source === "library_search";
}

export function summarizeRetrievedSources(log: VerificationLogEntry[]): RetrievedSourcesSummary {
  const fetched = new Map<string, VerificationLogEntry>();
  const search = new Map<string, VerificationLogEntry>();
  const failed: VerificationLogEntry[] = [];
  for (const entry of log) {
    if (isLibrary(entry)) continue;
    if (!succeeded(entry)) {
      failed.push(entry);
      continue;
    }
    const key = normalizeUrl(entry.url);
    if (isFetch(entry)) fetched.set(key, entry);
    else if (!search.has(key)) search.set(key, entry);
  }
  for (const key of fetched.keys()) search.delete(key);
  return { fetched: [...fetched.values()], searchResults: [...search.values()], failed };
}

/** One library document the run used, newest entry per document. */
export type LibraryUse = {
  documentId: string;
  url: string;
  title: string | null;
  citation: string | null;
  source: string | null;
  sourceRefreshedAt: string | null;
  sourceStale: boolean;
  precedentialStatus: string | null;
  /** Read (text returned) beats looked up (citation confirmed) beats only seen in a search. */
  use: "read" | "lookup" | "search";
  at: string;
};

const USE_RANK: Record<LibraryUse["use"], number> = { read: 3, lookup: 2, search: 1 };

/** The library documents the run used, strongest use per document, in first-seen order. */
export function summarizeLibraryUse(log: VerificationLogEntry[]): LibraryUse[] {
  const byId = new Map<string, LibraryUse>();
  for (const entry of log) {
    if (!isLibrary(entry) || !entry.libraryDocumentId) continue;
    const use: LibraryUse["use"] = entry.source === "library" ? (entry.libraryAction === "lookup" ? "lookup" : "read") : "search";
    const existing = byId.get(entry.libraryDocumentId);
    if (existing && USE_RANK[existing.use] >= USE_RANK[use]) continue;
    byId.set(entry.libraryDocumentId, {
      documentId: entry.libraryDocumentId,
      url: entry.url,
      title: entry.title ?? null,
      citation: entry.citation ?? null,
      source: entry.librarySource ?? null,
      sourceRefreshedAt: entry.sourceRefreshedAt ?? null,
      sourceStale: Boolean(entry.sourceStale),
      precedentialStatus: entry.precedentialStatus ?? null,
      use,
      at: entry.fetchedAt,
    });
  }
  return [...byId.values()];
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'()[\]{}]+/gi;

/** Every http(s) URL anywhere in a report's strings, in first-seen order, trailing punctuation trimmed. */
export function collectUrls(output: unknown): string[] {
  const seen = new Map<string, string>();
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      for (const match of node.match(URL_IN_TEXT) ?? []) {
        const url = match.replace(/[.,;:!?]+$/, "");
        const key = normalizeUrl(url);
        if (!seen.has(key)) seen.set(key, url);
      }
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(walk);
    }
  };
  walk(output);
  return [...seen.values()];
}

/** Each URL the report cites, checked against what the run retrieved. */
export function classifyCitedUrls(
  output: unknown,
  log: VerificationLogEntry[]
): { url: string; status: CitedUrlStatus }[] {
  const { fetched, searchResults } = summarizeRetrievedSources(log);
  // A page reached through an allowed redirect counts under the URL asked for too.
  const fetchedKeys = new Set(
    fetched.flatMap((e) => (e.requestedUrl ? [e.url, e.requestedUrl] : [e.url])).map((url) => normalizeUrl(url))
  );
  const searchKeys = new Set(searchResults.map((e) => normalizeUrl(e.url)));
  const library = summarizeLibraryUse(log);
  const libraryKeys = new Set(library.filter((u) => u.use !== "search").map((u) => normalizeUrl(u.url)));
  // Library reads that are not one document (the EOIR statistics tools) count under the official URL they give.
  for (const entry of log) if (entry.source === "library" && !entry.libraryDocumentId && succeeded(entry)) libraryKeys.add(normalizeUrl(entry.url));
  for (const u of library) if (u.use === "search") searchKeys.add(normalizeUrl(u.url));
  return collectUrls(output).map((url) => {
    const key = normalizeUrl(url);
    const status: CitedUrlStatus = fetchedKeys.has(key)
      ? "fetched"
      : libraryKeys.has(key)
        ? "library"
        : searchKeys.has(key)
          ? "search_result_only"
          : "not_retrieved";
    return { url, status };
  });
}
