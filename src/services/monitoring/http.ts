import "server-only";
import { decodeBody, OfficialFetchError, politeFetch, type PoliteFetchResult } from "@/services/library/http/fetch";

// Fetches official listing pages and documents for the monitor through the
// polite client the library's collectors use (src/services/library/http/
// fetch.ts): https only, the source's host allow list checked on the first
// URL and on every redirect, robots.txt honored with its Crawl-delay, one
// request at a time per host, a timeout, a byte cap, and the content type
// checked against what the caller expects. The monitor checks each source
// once a day, so it keeps the client's single retry for transient failures.

export { OfficialFetchError };

export const MONITOR_ROBOTS_TOKEN = "MeritDeskAI-LegalUpdateMonitor";
export const MONITOR_USER_AGENT = `${MONITOR_ROBOTS_TOKEN}/1.0 (daily check of official immigration law sources; honors robots.txt)`;

export const MAX_LISTING_BYTES = 4 * 1024 * 1024;
// A PDF goes to the API base64-encoded (a third larger) in a 32 MB request.
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export type Expected = "html" | "xml" | "json" | "pdf";

export type FetchPolicy = {
  allowedHosts: readonly string[];
  expect: Expected;
  maxBytes: number;
  timeoutMs?: number;
};

export type FetchedResource = PoliteFetchResult;

/** Fetches one official resource under `policy`, retrying once after a transient failure. */
export async function fetchOfficial(url: string, policy: FetchPolicy): Promise<FetchedResource> {
  return politeFetch(url, {
    hosts: policy.allowedHosts,
    expect: policy.expect,
    maxBytes: policy.maxBytes,
    timeoutMs: policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent: MONITOR_USER_AGENT,
    robotsToken: MONITOR_ROBOTS_TOKEN,
    priority: "daily",
    maxAttempts: 2,
  });
}

/** The body as text (the Content-Type charset, else UTF-8). */
export function bodyText(resource: FetchedResource): string {
  return decodeBody(resource);
}
