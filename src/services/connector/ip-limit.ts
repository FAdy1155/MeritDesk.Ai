// A per-IP limit on /api/mcp, applied before the request is authenticated,
// so unauthenticated traffic cannot make the app call Clerk (or Postgres)
// without bound. Two token buckets per client IP, kept in this process's
// memory (each web machine counts on its own; a restart forgets them):
//
// - every request takes one token from a bucket of
//   CONNECTOR_IP_REQUESTS_PER_MINUTE (default 600, refilled over a minute);
// - every request whose token is refused (a bearer token that is malformed,
//   invalid, expired, revoked or not usable here; not the tokenless request
//   that starts OAuth discovery) takes one from a bucket of
//   CONNECTOR_IP_AUTH_FAILURES_PER_MINUTE (default 30). While that bucket is
//   empty, every request from the IP is refused before authentication.
//
// The limits are generous on purpose: Claude's requests for every user of
// every firm come from a few Anthropic addresses (160.79.104.0/21), and
// ChatGPT's from OpenAI's. The per-member and per-firm limits that matter
// for normal use are the Postgres buckets of ./rate-limit.ts.
//
// The client IP is Fly's Fly-Client-IP header (set by Fly's proxy), else the
// last X-Forwarded-For entry (the one the nearest proxy added). Without a
// proxy in front, X-Forwarded-For is the caller's to write, and every
// request without either header shares one bucket.
//
// With Cloudflare proxying the domain, Fly sees Cloudflare's edge as the
// client, so every caller would share a handful of buckets. Cloudflare puts
// the real address in CF-Connecting-IP; TRUST_CF_CONNECTING_IP=true makes it
// win. Set it only while all traffic reaches Fly through Cloudflare: a
// request straight to the Fly hostname could write that header itself.

const DEFAULT_REQUESTS_PER_MINUTE = 600;
const DEFAULT_FAILURES_PER_MINUTE = 30;
const MAX_TRACKED_IPS = 10_000;

type Bucket = { tokens: number; at: number };

function perMinute(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

class MemoryBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly capacity: () => number) {}

  private current(key: string, now: number): Bucket {
    const capacity = this.capacity();
    const bucket = this.buckets.get(key);
    if (!bucket) return { tokens: capacity, at: now };
    const refilled = Math.min(capacity, bucket.tokens + ((now - bucket.at) / 60_000) * capacity);
    return { tokens: refilled, at: now };
  }

  /** Seconds until a token is free, 0 when one is. */
  wait(key: string, now: number): number {
    const bucket = this.current(key, now);
    return bucket.tokens >= 1 ? 0 : Math.max(1, Math.ceil(((1 - bucket.tokens) / this.capacity()) * 60));
  }

  take(key: string, now: number): void {
    const bucket = this.current(key, now);
    if (!this.buckets.has(key) && this.buckets.size >= MAX_TRACKED_IPS) {
      // Forget the buckets that are full again (idle IPs); if none, start over.
      for (const k of [...this.buckets.keys()]) if (this.current(k, now).tokens >= this.capacity()) this.buckets.delete(k);
      if (this.buckets.size >= MAX_TRACKED_IPS) this.buckets.clear();
    }
    this.buckets.set(key, { tokens: Math.max(0, bucket.tokens - 1), at: now });
  }

  reset(): void {
    this.buckets.clear();
  }
}

const requests = new MemoryBuckets(() => perMinute("CONNECTOR_IP_REQUESTS_PER_MINUTE", DEFAULT_REQUESTS_PER_MINUTE));
const failures = new MemoryBuckets(() => perMinute("CONNECTOR_IP_AUTH_FAILURES_PER_MINUTE", DEFAULT_FAILURES_PER_MINUTE));

/** The caller's IP as the proxy in front of the app reports it. */
export function connectorClientIp(request: Request): string {
  if (process.env.TRUST_CF_CONNECTING_IP === "true") {
    const cf = request.headers.get("cf-connecting-ip")?.trim();
    if (cf) return cf;
  }
  const fly = request.headers.get("fly-client-ip")?.trim();
  if (fly) return fly;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  return forwarded?.length ? forwarded[forwarded.length - 1] : "unknown";
}

/** Before authentication: takes a request token, or says how long to wait. */
export function admitConnectorRequest(ip: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const failureWait = failures.wait(ip, now);
  if (failureWait > 0) return { ok: false, retryAfterSeconds: failureWait };
  const requestWait = requests.wait(ip, now);
  if (requestWait > 0) return { ok: false, retryAfterSeconds: requestWait };
  requests.take(ip, now);
  return { ok: true };
}

/** After a refused bearer token. */
export function recordConnectorAuthFailure(ip: string, now = Date.now()): void {
  failures.take(ip, now);
}

/** For the check script. */
export function resetConnectorIpLimits(): void {
  requests.reset();
  failures.reset();
}
