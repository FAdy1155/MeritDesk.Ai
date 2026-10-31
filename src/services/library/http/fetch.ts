import crypto from "node:crypto";
import type { FetchPriority, KnownFetch } from "../types";
import { acquireHost, MAX_HOST_SPACING_MS, penalizeHost, setCrawlDelay } from "./host-gate";
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, robotsAllows, type RobotsPolicy } from "./robots";

// The polite fetch every reader of official sources goes through: the
// library's collectors (./client.ts) and the legal-update monitor
// (src/services/monitoring/http.ts, which this generalizes).
//
// - https only, no credentials in the URL, the standard port, and the host
//   on the caller's list, checked on the first URL and on every redirect
//   (followed by hand, at most MAX_REDIRECTS). Extra headers (an API key)
//   go to the first URL's host only, never across a redirect to another.
// - robots.txt honored for every URL fetched (cached per host for a day; a
//   robots.txt that cannot be read blocks the host for a few minutes, as
//   RFC 9309 says), with its Crawl-delay applied to the host's pacing.
// - Paced per host (./host-gate.ts): one request in flight, about a second
//   apart by default, longer when robots.txt asks.
// - Retries with backoff: 429 and 503 wait for Retry-After (capped) or an
//   exponential delay and slow the host down for a while; 500, 502, 504,
//   timeouts and network errors are retried after a short delay.
// - A timeout per request (the wait for the host's turn not counted), a
//   byte cap on the (decompressed) body, and the content type checked
//   against what the caller expects.
// - Conditional GET: when the caller knows the validators of the URL a
//   request reaches, it sends If-None-Match / If-Modified-Since there and
//   reports a 304 as notModified.

export type FetchExpect = "html" | "xml" | "json" | "pdf" | "text" | "any";

const CONTENT_TYPES: Record<Exclude<FetchExpect, "any">, readonly string[]> = {
  html: ["text/html", "application/xhtml+xml"],
  xml: ["application/rss+xml", "application/xml", "text/xml", "application/atom+xml"],
  json: ["application/json", "application/vnd.api+json", "application/hal+json", "application/ld+json"],
  pdf: ["application/pdf"],
  text: ["text/plain"],
};

const ACCEPT_HEADERS: Record<FetchExpect, string> = {
  html: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  xml: "application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.5",
  json: "application/json,*/*;q=0.5",
  pdf: "application/pdf,*/*;q=0.5",
  text: "text/plain,*/*;q=0.5",
  any: "*/*",
};

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 60_000;
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const ROBOTS_UNAVAILABLE_TTL_MS = 10 * 60 * 1000;
const ROBOTS_MAX_BYTES = 512 * 1024;
/**
 * Keyed API hosts whose robots.txt path is not a robots.txt but the API's
 * own error (api.govinfo.gov answers it with HTTP 500 and a JSON "something
 * went wrong", as for any unknown route). They are used only by API calls
 * that carry the API key, under the API's published terms
 * (https://www.govinfo.gov/developers, https://api.data.gov/docs/developer-manual/),
 * not crawled. For these hosts only, a 5xx robots.txt is treated as no
 * robots.txt (RFC 9309 2.3.1.4 allows that for a robots.txt unavailable
 * for a long time); a robots.txt they do serve is honored like any other.
 * Remove a host here to block it while its robots.txt answers 5xx.
 */
const ROBOTS_5XX_IS_ABSENT_HOSTS = new Set(["api.govinfo.gov"]);
const MAX_RETRY_AFTER_MS = readNumberEnv("LIBRARY_MAX_RETRY_AFTER_SECONDS", 300, 1, 3600) * 1000;

function readNumberEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export type PoliteFetchOptions = {
  /** Hosts the request and every redirect hop may reach. */
  hosts: readonly string[];
  expect: FetchExpect;
  maxBytes: number;
  userAgent: string;
  /** The product token robots.txt groups are matched against (the start of the User-Agent). */
  robotsToken: string;
  timeoutMs?: number;
  priority?: FetchPriority;
  conditional?: KnownFetch | null;
  headers?: Record<string, string>;
  /** Default true. */
  respectRobots?: boolean;
  /** Total attempts, retries included (default 4). */
  maxAttempts?: number;
  signal?: AbortSignal;
  /** Called with notes worth keeping (a robots Crawl-delay above the cap, a retry). */
  onNote?: (message: string) => void;
};

export type PoliteFetchResult = {
  /** The URL the content came from (after redirects). */
  url: string;
  requestedUrl: string;
  redirects: string[];
  status: number;
  /** A conditional request came back 304: body is empty and the caller's copy is current. */
  notModified: boolean;
  contentType: string;
  /** The charset the Content-Type header names, if any. */
  charset: string | null;
  body: Buffer;
  sha256: string;
  etag: string | null;
  lastModified: string | null;
  retrievedAt: Date;
};

/** A fetch that was refused or could not complete; the message is safe to store and show (URLs are redacted of keys). */
export class OfficialFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Seconds the host asked us to wait (429/503 with a Retry-After over the cap). */
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "OfficialFetchError";
  }
}

const SECRET_PARAMS = /^(api[_-]?key|apikey|key|token|access[_-]?token|auth|signature|sig)$/i;

/** A URL with secret-looking query parameters replaced by "REDACTED", for anything stored or logged. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    let changed = false;
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_PARAMS.test(name)) {
        url.searchParams.set(name, "REDACTED");
        changed = true;
      }
    }
    return changed ? url.toString() : raw;
  } catch {
    return raw;
  }
}

/** Why a URL may not be fetched, or null. allowedHosts "*" (robots.txt redirects only) allows any https host. */
function urlProblem(url: URL, allowedHosts: readonly string[] | "*"): string | null {
  if (url.protocol !== "https:") return `only https is fetched (got ${url.protocol}//${url.hostname})`;
  if (url.username || url.password) return "URLs with credentials are not fetched";
  if (url.port && url.port !== "443") return `only the standard https port is fetched (got ${url.port})`;
  if (allowedHosts !== "*" && !allowedHosts.includes(url.hostname.toLowerCase())) return `${url.hostname} is not on this source's host list`;
  return null;
}

/** The pacing key for a host: www. and the bare name are one server. */
function gateKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes && !res.headers.get("content-encoding")) {
    await res.body.cancel().catch(() => {});
    throw new OfficialFetchError(`${redactUrl(url)} is ${declared} bytes, over the ${maxBytes}-byte limit.`, "too_large");
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new OfficialFetchError(`${redactUrl(url)} passed the ${maxBytes}-byte limit; nothing from it was used.`, "too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

type RobotsEntry = { policy: RobotsPolicy; expiresAt: number; note: string | null };
// Keyed by origin and robots token: the library and the legal-update monitor
// crawl under different tokens in one worker, and a group naming one of them
// must not decide what the other may fetch.
const robotsCache = new Map<string, RobotsEntry>();
const robotsInFlight = new Map<string, Promise<RobotsEntry>>();

async function loadRobots(url: URL, options: PoliteFetchOptions): Promise<RobotsEntry> {
  const origin = `https://${url.hostname.toLowerCase()}`;
  const key = `${origin}|${options.robotsToken.toLowerCase()}`;
  const cached = robotsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const pending = robotsInFlight.get(key);
  if (pending) return pending;
  const work = (async (): Promise<RobotsEntry> => {
    let entry: RobotsEntry;
    try {
      const res = await fetchHops(`${origin}/robots.txt`, {
        ...options,
        // RFC 9309 says to follow a robots.txt redirect even to another host
        // (www.opn.ca6.uscourts.gov sends it to www.ca6.uscourts.gov); still
        // https only, at most 5 hops, and nothing but the file is read.
        hosts: [url.hostname.toLowerCase()],
        robotsRedirects: true,
        expect: "any",
        maxBytes: ROBOTS_MAX_BYTES,
        timeoutMs: 20_000,
        conditional: null,
        headers: undefined,
        acceptStatuses: "any",
      });
      if (res.status >= 200 && res.status < 300) {
        const policy = parseRobots(res.body.toString("utf-8"), options.robotsToken);
        entry = { policy, expiresAt: Date.now() + ROBOTS_TTL_MS, note: null };
      } else if (res.status >= 400 && res.status < 500) {
        entry = { policy: ALLOW_ALL, expiresAt: Date.now() + ROBOTS_TTL_MS, note: null };
      } else if (res.status >= 500 && ROBOTS_5XX_IS_ABSENT_HOSTS.has(url.hostname.toLowerCase())) {
        entry = { policy: ALLOW_ALL, expiresAt: Date.now() + ROBOTS_UNAVAILABLE_TTL_MS, note: null };
      } else {
        entry = {
          policy: DISALLOW_ALL,
          expiresAt: Date.now() + ROBOTS_UNAVAILABLE_TTL_MS,
          note: `robots.txt on ${url.hostname} answered HTTP ${res.status}`,
        };
      }
    } catch (err) {
      entry = {
        policy: DISALLOW_ALL,
        expiresAt: Date.now() + ROBOTS_UNAVAILABLE_TTL_MS,
        note: `robots.txt on ${url.hostname} could not be read (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    const delay = entry.policy.crawlDelaySeconds;
    if (delay !== null && delay * 1000 > MAX_HOST_SPACING_MS) {
      options.onNote?.(
        `robots.txt on ${url.hostname} asks for ${delay} seconds between requests; requests are spaced ${MAX_HOST_SPACING_MS / 1000} seconds apart, the most this client waits.`
      );
    }
    setCrawlDelay(gateKey(url.hostname), options.robotsToken, delay);
    robotsCache.set(key, entry);
    return entry;
  })();
  robotsInFlight.set(key, work);
  try {
    return await work;
  } finally {
    robotsInFlight.delete(key);
  }
}

async function checkRobots(url: URL, options: PoliteFetchOptions): Promise<void> {
  if (options.respectRobots === false) return;
  const entry = await loadRobots(url, options);
  if (robotsAllows(entry.policy, `${url.pathname}${url.search}`)) return;
  if (entry.note) {
    throw new OfficialFetchError(`${entry.note}, so nothing on that host is fetched for a few minutes (RFC 9309).`, "robots_unavailable");
  }
  throw new OfficialFetchError(`robots.txt on ${url.hostname} does not allow fetching ${redactUrl(url.toString())}.`, "robots_disallowed");
}

// ---------------------------------------------------------------------------
// One attempt: the redirect chain
// ---------------------------------------------------------------------------

type HopOptions = PoliteFetchOptions & { acceptStatuses?: "ok" | "any"; robotsRedirects?: boolean };

async function fetchHops(url: string, options: HopOptions): Promise<PoliteFetchResult> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new OfficialFetchError(`Not a URL: ${redactUrl(url)}`, "invalid_url");
  }
  const first = urlProblem(current, options.hosts);
  if (first) throw new OfficialFetchError(`Fetch refused: ${first}.`, "blocked");
  const firstHost = current.hostname.toLowerCase();
  const requestedUrl = current.toString();
  const redirects: string[] = [];
  const isRobots = current.pathname === "/robots.txt" && options.acceptStatuses === "any";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let hop = 0; ; hop++) {
    if (!isRobots) await checkRobots(current, options);
    // The wait for the host's turn is not part of the timeout: on a host
    // whose robots.txt asks for minutes between requests (gao.gov asks for
    // seven), a request queued behind another would otherwise always time out.
    const release = await acquireHost(gateKey(current.hostname), options.priority ?? "daily", options.signal);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const sameHost = current.hostname.toLowerCase() === firstHost;
      const conditional = options.conditional && options.conditional.url === current.toString() ? options.conditional : null;
      const headers: Record<string, string> = {
        ...(sameHost ? options.headers : {}),
        "User-Agent": options.userAgent,
        Accept: options.headers?.Accept && sameHost ? options.headers.Accept : ACCEPT_HEADERS[options.expect],
      };
      if (conditional?.etag) headers["If-None-Match"] = conditional.etag;
      if (conditional?.lastModified) headers["If-Modified-Since"] = conditional.lastModified;
      const res = await fetch(current.toString(), { redirect: "manual", signal, headers });

      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location) throw new OfficialFetchError(`HTTP ${res.status} redirect with no Location from ${redactUrl(current.toString())}.`, "bad_redirect");
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new OfficialFetchError(`${redactUrl(current.toString())} redirected to an invalid URL.`, "bad_redirect");
        }
        const problem = urlProblem(next, options.robotsRedirects ? "*" : options.hosts);
        if (problem) {
          throw new OfficialFetchError(
            `${redactUrl(current.toString())} redirected to ${redactUrl(next.toString())}, and ${problem}; nothing was read.`,
            "redirect_blocked"
          );
        }
        if (hop >= MAX_REDIRECTS) throw new OfficialFetchError(`More than ${MAX_REDIRECTS} redirects from ${redactUrl(requestedUrl)}.`, "too_many_redirects");
        redirects.push(current.toString());
        current = next;
        continue;
      }

      const base = {
        url: current.toString(),
        requestedUrl,
        redirects,
        status: res.status,
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
        charset: /charset=([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1]?.toLowerCase() ?? null,
        retrievedAt: new Date(),
      };
      if (res.status === 304 && conditional) {
        await res.body?.cancel().catch(() => {});
        return {
          ...base,
          notModified: true,
          contentType: "",
          body: Buffer.alloc(0),
          sha256: "",
          etag: base.etag ?? conditional.etag,
          lastModified: base.lastModified ?? conditional.lastModified,
        };
      }
      if (options.acceptStatuses === "any") {
        // robots.txt: only a 2xx body is read. A 4xx (allow all) or 5xx
        // answer is decided by its status, whatever its size (www.state.gov
        // answers 403 with a 650 KB page).
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          return { ...base, notModified: false, contentType: contentTypeOf(res), body: Buffer.alloc(0), sha256: "" };
        }
        const body = await readCapped(res, options.maxBytes, current.toString());
        return { ...base, notModified: false, contentType: contentTypeOf(res), body, sha256: sha256(body) };
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new OfficialFetchError(
          `HTTP ${res.status} from ${redactUrl(current.toString())}.`,
          `http_${res.status}`,
          retryAfterSeconds(res.headers.get("retry-after")) ?? undefined
        );
      }
      const contentType = contentTypeOf(res);
      if (!acceptable(options.expect, contentType)) {
        await res.body?.cancel().catch(() => {});
        throw new OfficialFetchError(
          `${redactUrl(current.toString())} returned ${contentType || "no content type"}, not ${options.expect}.`,
          "unexpected_content_type"
        );
      }
      const body = await readCapped(res, options.maxBytes, current.toString());
      if (options.expect === "pdf" && body.subarray(0, 1024).toString("latin1").indexOf("%PDF-") < 0) {
        throw new OfficialFetchError(`${redactUrl(current.toString())} did not return a PDF file.`, "not_pdf");
      }
      return { ...base, notModified: false, contentType, body, sha256: sha256(body) };
    } catch (err) {
      if (err instanceof OfficialFetchError) throw err;
      if (timeout.aborted) throw new OfficialFetchError(`${redactUrl(current.toString())} timed out.`, "timeout");
      if (options.signal?.aborted) throw new OfficialFetchError("The fetch was stopped (the run ended or the worker is shutting down).", "aborted");
      throw new OfficialFetchError(
        `Could not fetch ${redactUrl(current.toString())}: ${err instanceof Error ? err.message : String(err)}.`,
        "network"
      );
    } finally {
      release();
    }
  }
}

function contentTypeOf(res: Response): string {
  return (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

function acceptable(expect: FetchExpect, contentType: string): boolean {
  if (expect === "any") return true;
  if (CONTENT_TYPES[expect].includes(contentType)) return true;
  // Feeds are often served as text/html or text/plain; the parser decides whether one is a feed.
  if (expect === "xml" && (contentType === "text/html" || contentType === "text/plain")) return true;
  if (expect === "json" && /[/+]json$/.test(contentType)) return true;
  // Some servers label PDFs generically; the %PDF- check decides.
  if (expect === "pdf" && (contentType === "application/octet-stream" || contentType === "binary/octet-stream")) return true;
  return false;
}

function sha256(body: Buffer): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : null;
}

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

function retryDelayMs(err: OfficialFetchError, attempt: number): number | null {
  const backoff = 3_000 * 3 ** (attempt - 1); // 3s, 9s, 27s
  if (err.code === "http_429" || err.code === "http_503") {
    if (err.retryAfterSeconds !== undefined) {
      const ms = err.retryAfterSeconds * 1000;
      return ms <= MAX_RETRY_AFTER_MS ? Math.max(ms, 1_000) : null;
    }
    return backoff * 2;
  }
  if (["http_500", "http_502", "http_504", "timeout", "network"].includes(err.code)) return backoff;
  return null;
}

/** Fetches one official resource under `options`, retrying what can be retried. */
export async function politeFetch(url: string, options: PoliteFetchOptions): Promise<PoliteFetchResult> {
  const maxAttempts = options.maxAttempts ?? 4;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchHops(url, options);
    } catch (err) {
      if (!(err instanceof OfficialFetchError)) throw err;
      if (err.code === "http_429" || err.code === "http_503") {
        try {
          penalizeHost(gateKey(new URL(url).hostname));
        } catch {
          // an invalid URL never reaches a 429
        }
      }
      const delay = retryDelayMs(err, attempt);
      if (delay === null || attempt >= maxAttempts) {
        if ((err.code === "http_429" || err.code === "http_503") && err.retryAfterSeconds !== undefined && delay === null) {
          throw new OfficialFetchError(
            `${err.message} The host asked to wait ${err.retryAfterSeconds} seconds, longer than this client waits; it is tried again on the next run.`,
            err.code,
            err.retryAfterSeconds
          );
        }
        throw err;
      }
      options.onNote?.(`Retrying ${redactUrl(url)} after ${err.code} (attempt ${attempt + 1} of ${maxAttempts}).`);
      await sleep(delay, options.signal);
    }
  }
}

/** The body decoded as text, by the Content-Type charset when it names one (UTF-8 otherwise). */
export function decodeBody(result: PoliteFetchResult): string {
  const charset = result.charset;
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(result.body);
    } catch {
      // unknown charset: fall through to UTF-8
    }
  }
  return result.body.toString("utf-8");
}
