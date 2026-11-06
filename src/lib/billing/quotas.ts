import { intEnv } from "./config";
import type { Entitlement } from "./entitlement";

// Per-firm AI and storage caps (README / DEPLOYMENT "Usage limits").
// Complimentary firms have none. Trial and subscribed firms share one
// monthly token budget (UTC calendar month) and one storage budget.
// Override with env; defaults are sized for the $20/seat plan without a
// separate usage-based Stripe meter.

export const DEFAULT_TRIAL_MONTHLY_INPUT_TOKENS = 3_000_000;
export const DEFAULT_SUBSCRIBED_MONTHLY_INPUT_TOKENS_PER_SEAT = 10_000_000;
export const DEFAULT_TRIAL_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_SUBSCRIBED_STORAGE_BYTES_PER_SEAT = 10 * 1024 * 1024 * 1024;

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
};

export type QuotaLimits = {
  /** Billable input tokens this UTC month; null means unlimited. */
  monthlyInputTokens: number | null;
  /** Sum of documents.size_bytes; null means unlimited. */
  storageBytes: number | null;
};

/** First day of the UTC month containing `now`, as YYYY-MM-DD. */
export function utcMonthStart(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

/**
 * Tokens that count against the monthly cap: uncached input plus cache
 * writes. Cache reads are cheaper and excluded so prompt-cache hits do not
 * burn the firm's budget twice.
 */
export function billableInputTokens(usage: Pick<ModelUsage, "inputTokens" | "cacheCreationInputTokens">): number {
  return Math.max(0, usage.inputTokens) + Math.max(0, usage.cacheCreationInputTokens);
}

export function trialMonthlyInputTokens(): number {
  return intEnv("TRIAL_MONTHLY_INPUT_TOKENS", DEFAULT_TRIAL_MONTHLY_INPUT_TOKENS, 100_000, 1_000_000_000);
}

export function subscribedMonthlyInputTokensPerSeat(): number {
  return intEnv(
    "SUBSCRIBED_MONTHLY_INPUT_TOKENS_PER_SEAT",
    DEFAULT_SUBSCRIBED_MONTHLY_INPUT_TOKENS_PER_SEAT,
    100_000,
    1_000_000_000
  );
}

export function trialStorageBytes(): number {
  return intEnv("TRIAL_STORAGE_BYTES", DEFAULT_TRIAL_STORAGE_BYTES, 10 * 1024 * 1024, 1024 * 1024 * 1024 * 1024);
}

export function subscribedStorageBytesPerSeat(): number {
  return intEnv(
    "SUBSCRIBED_STORAGE_BYTES_PER_SEAT",
    DEFAULT_SUBSCRIBED_STORAGE_BYTES_PER_SEAT,
    10 * 1024 * 1024,
    1024 * 1024 * 1024 * 1024
  );
}

/**
 * Caps for this firm right now. Complimentary: unlimited. Locked firms keep
 * the trial caps (enforcement happens through entitlement first). Seats are
 * the billed member count (at least 1).
 */
export function quotaLimitsFor(entitlement: Entitlement, seats: number): QuotaLimits {
  if (entitlement.complimentary && entitlement.state !== "locked") {
    return { monthlyInputTokens: null, storageBytes: null };
  }
  const n = Math.max(1, seats);
  if (entitlement.state === "active" || entitlement.state === "past_due") {
    return {
      monthlyInputTokens: subscribedMonthlyInputTokensPerSeat() * n,
      storageBytes: subscribedStorageBytesPerSeat() * n,
    };
  }
  return {
    monthlyInputTokens: trialMonthlyInputTokens(),
    storageBytes: trialStorageBytes(),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
}
