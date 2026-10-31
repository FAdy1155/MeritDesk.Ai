// Paces requests per host for everything in this process that fetches
// official sources (the library's collectors and the legal-update monitor):
// at most one request in flight to a host, and each start at least the
// host's spacing after the previous one. The spacing is the default (about
// one request a second, LIBRARY_HOST_SPACING_MS), raised to the host's
// robots.txt Crawl-delay, and doubled for a while after the host answers
// 429 or 503. Waiting requests go in priority order (an attorney's lookup,
// then daily runs, then backfill), first come first served within one, so a
// long backfill never holds up a daily run on the same host.
//
// The pace is kept in this process only. The deploy runs one worker
// machine; with more, each would pace itself, and the per-host spacing
// should be raised to match.

import type { FetchPriority } from "../types";

const PRIORITY_RANK: Record<FetchPriority, number> = { interactive: 0, daily: 1, backfill: 2 };

export const DEFAULT_HOST_SPACING_MS = readSpacing();
/**
 * Spacing never exceeds this, whatever a robots.txt asks (a larger
 * Crawl-delay is capped, and logged by the caller). Ten minutes: gao.gov
 * asks for seven, and is given them.
 */
export const MAX_HOST_SPACING_MS = 10 * 60_000;
const PENALTY_MS = 10 * 60 * 1000;

function readSpacing(): number {
  const raw = process.env.LIBRARY_HOST_SPACING_MS;
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 250 && value <= 60_000 ? value : 1_000;
}

type Waiter = {
  rank: number;
  seq: number;
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
};

type HostState = {
  busy: boolean;
  lastStart: number;
  /** Crawl-delay from robots.txt, in ms (0 when none): the strictest of the
   *  delays the host asks of each robots token this process crawls under. */
  crawlDelayMs: number;
  delaysByToken: Map<string, number>;
  penaltyUntil: number;
  waiters: Waiter[];
  timer: NodeJS.Timeout | null;
};

const hosts = new Map<string, HostState>();
let seq = 0;

function state(host: string): HostState {
  let s = hosts.get(host);
  if (!s) {
    s = { busy: false, lastStart: 0, crawlDelayMs: 0, delaysByToken: new Map(), penaltyUntil: 0, waiters: [], timer: null };
    hosts.set(host, s);
  }
  return s;
}

/** The gap the host currently gets between two request starts. */
export function hostSpacingMs(host: string): number {
  const s = state(host);
  const base = Math.min(Math.max(DEFAULT_HOST_SPACING_MS, s.crawlDelayMs), MAX_HOST_SPACING_MS);
  return Date.now() < s.penaltyUntil ? Math.min(base * 2, MAX_HOST_SPACING_MS) : base;
}

/**
 * Records the crawl-delay robots.txt gives one token. The library and the
 * legal-update monitor share a host's gate, so the gate waits the longest
 * delay asked of any token seen.
 */
export function setCrawlDelay(host: string, token: string, seconds: number | null): void {
  const s = state(host);
  s.delaysByToken.set(token.toLowerCase(), seconds && seconds > 0 ? Math.round(seconds * 1000) : 0);
  s.crawlDelayMs = Math.max(0, ...s.delaysByToken.values());
}

/** The host answered 429 or 503: slow down for a while. */
export function penalizeHost(host: string): void {
  state(host).penaltyUntil = Date.now() + PENALTY_MS;
}

function pump(host: string): void {
  const s = state(host);
  if (s.busy || s.waiters.length === 0) return;
  const wait = s.lastStart + hostSpacingMs(host) - Date.now();
  if (wait > 0) {
    if (!s.timer) {
      s.timer = setTimeout(() => {
        s.timer = null;
        pump(host);
      }, wait);
    }
    return;
  }
  s.waiters.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
  const next = s.waiters.shift()!;
  if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
  s.busy = true;
  s.lastStart = Date.now();
  let released = false;
  next.resolve(() => {
    if (released) return;
    released = true;
    s.busy = false;
    pump(host);
  });
}

/**
 * Waits for this host's turn. Resolves with a release function the caller
 * must call when the request (body included) is finished.
 */
export function acquireHost(host: string, priority: FetchPriority, signal?: AbortSignal): Promise<() => void> {
  const s = state(host);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const waiter: Waiter = { rank: PRIORITY_RANK[priority], seq: seq++, resolve, reject, signal };
    if (signal) {
      waiter.onAbort = () => {
        const at = s.waiters.indexOf(waiter);
        if (at >= 0) s.waiters.splice(at, 1);
        reject(signal.reason ?? new Error("aborted"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    s.waiters.push(waiter);
    pump(host);
  });
}
