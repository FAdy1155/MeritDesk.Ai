import type { KnownFetch, LibraryGetOptions, LibraryHttp, LibraryHttpResponse, FetchPriority } from "../types";
import { decodeBody, OfficialFetchError, politeFetch, type FetchExpect } from "./fetch";

// The LibraryHttp an adapter gets on ctx.http: politeFetch (./fetch.ts) bound
// to the adapter's host list, the run's priority and stop signal, the
// library's User-Agent, and default byte caps per content type.

/** The product token robots.txt groups are matched against. */
export const LIBRARY_ROBOTS_TOKEN = "MeritDeskAI-Library";

/**
 * Identifies the collector to the sites it reads. LIBRARY_USER_AGENT_CONTACT
 * (an operator email or URL) is added when set, so a site's administrators
 * can reach whoever runs it.
 */
export function libraryUserAgent(): string {
  const contact = process.env.LIBRARY_USER_AGENT_CONTACT?.trim();
  return `${LIBRARY_ROBOTS_TOKEN}/1.0 (collects public official immigration-law sources for a law-firm research library; honors robots.txt${contact ? `; contact: ${contact}` : ""})`;
}

function readMb(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 && value <= 500 ? value : fallback;
}

/** Default body caps (decompressed bytes). PDFs are only read for their text, never sent to the API whole. */
export const DEFAULT_MAX_BYTES: Record<FetchExpect, number> = {
  html: 15 * 1024 * 1024,
  xml: 25 * 1024 * 1024,
  json: 50 * 1024 * 1024,
  pdf: readMb("LIBRARY_MAX_PDF_MB", 60) * 1024 * 1024,
  text: 25 * 1024 * 1024,
  any: 25 * 1024 * 1024,
};

/** Validators of listing pages, loaded at the start of a daily run and saved only when it stores everything it listed. */
export type ListingCache = {
  get(url: string): KnownFetch | undefined;
  record(url: string, response: LibraryHttpResponse): void;
};

export function createLibraryHttp(params: {
  hosts: readonly string[];
  priority: FetchPriority;
  signal: AbortSignal;
  note: (message: string) => void;
  /** Daily runs only; without it getListing always fetches the page. */
  listingCache?: ListingCache | null;
}): LibraryHttp {
  const get = (url: string, options: LibraryGetOptions): Promise<LibraryHttpResponse> =>
    politeFetch(url, {
      hosts: params.hosts,
      expect: options.expect,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES[options.expect],
      timeoutMs: options.timeoutMs,
      userAgent: libraryUserAgent(),
      robotsToken: LIBRARY_ROBOTS_TOKEN,
      priority: params.priority,
      conditional: options.conditional ?? null,
      headers: options.headers,
      signal: params.signal,
      onNote: params.note,
    });

  return {
    get,
    async getText(url, options) {
      const response = await get(url, { expect: "html", ...options });
      return { text: decodeBody(response), response };
    },
    async getJson<T>(url: string, options?: Partial<LibraryGetOptions>) {
      const response = await get(url, { expect: "json", ...options });
      try {
        return { data: JSON.parse(decodeBody(response)) as T, response };
      } catch {
        throw new OfficialFetchError(`${response.url} did not return valid JSON.`, "invalid_json");
      }
    },
    async getListing(url, options) {
      const conditional = params.listingCache?.get(url) ?? null;
      const response = await get(url, { expect: "html", ...options, conditional });
      if (response.notModified) return { unchanged: true, text: "", response };
      params.listingCache?.record(url, response);
      return { unchanged: false, text: decodeBody(response), response };
    },
  };
}
