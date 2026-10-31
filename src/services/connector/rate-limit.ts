import "server-only";
import { sql } from "drizzle-orm";
import { withTenantContext, type TenantTransactionRunner } from "@/db/client";
import { connectorRateBuckets } from "@/db/schema";

// The connector's rate limits: token buckets in Postgres
// (connector_rate_buckets, migration 0012), one row per tenant and bucket,
// so the limits hold across web machines and restarts. A bucket holds up to
// `capacity` tokens and gains `refillPerSecond` tokens a second; each tool
// call takes one token from every bucket its rules name, all in one
// transaction: if any bucket is empty, nothing is taken and the call is
// refused with the wait until that bucket has a token again.
//
// Refill is computed by the statement that takes the token (lazily, from the
// time since the row last changed), so an idle bucket costs nothing.
// Postgres's now() is the transaction's start time, the same for every
// bucket of one call. inTenant is withTenantContext in the app (the
// connector check script passes a PGlite runner).

export type RateLimitRule = {
  /** Bucket name within the tenant: "tenant", "user:<id>", "run_skill:user:<id>". */
  key: string;
  capacity: number;
  refillPerSecond: number;
  /** For the refusal message: "your calls", "the firm's calls". */
  label: string;
};

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number; label: string };

/** Every tool call: per user, and per firm across its users. */
export function callRules(userId: string): RateLimitRule[] {
  return [
    { key: `user:${userId}`, capacity: 30, refillPerSecond: 0.5, label: "your connector calls (30 a minute)" },
    { key: "tenant", capacity: 120, refillPerSecond: 2, label: "the firm's connector calls (120 a minute)" },
  ];
}

/** The default of CONNECTOR_RUN_SKILL_DAILY_LIMIT. */
export const DEFAULT_RUN_SKILL_DAILY_LIMIT = 50;

/**
 * The most skill runs one firm may queue through the connector in a day
 * (CONNECTOR_RUN_SKILL_DAILY_LIMIT, a whole number of at least 1; default
 * 50): a cap on what a connection can spend of the firm's model budget. A
 * bucket that holds a day's runs and refills over 24 hours, so the window
 * rolls rather than resetting at midnight.
 */
export function runSkillDailyLimit(): number {
  const value = Number(process.env.CONNECTOR_RUN_SKILL_DAILY_LIMIT);
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_RUN_SKILL_DAILY_LIMIT;
}

/** run_skill on top of callRules: runs cost money and create work. */
export function runSkillRules(userId: string): RateLimitRule[] {
  const daily = runSkillDailyLimit();
  return [
    { key: `run_skill:user:${userId}`, capacity: 5, refillPerSecond: 5 / 3600, label: "skill runs you queue through the connector (5 an hour)" },
    { key: "run_skill:tenant", capacity: 20, refillPerSecond: 20 / 3600, label: "skill runs the firm queues through the connector (20 an hour)" },
    { key: "run_skill:tenant:day", capacity: daily, refillPerSecond: daily / 86_400, label: `skill runs the firm queues through the connector (${daily} a day)` },
  ];
}

class RateLimited extends Error {
  constructor(readonly retryAfterSeconds: number, readonly label: string) {
    super("rate limited");
  }
}

/** The rows of a raw execute() result, whichever driver ran it. */
function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const list = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(list) ? (list as T[]) : [];
}

/** Takes one token from each rule's bucket, or none if any is empty. */
export async function takeRateLimitTokens(
  tenantId: string,
  rules: RateLimitRule[],
  inTenant: TenantTransactionRunner = withTenantContext
): Promise<RateLimitResult> {
  try {
    await inTenant(tenantId, async (tx) => {
      for (const rule of rules) {
        const capacity = sql`${rule.capacity}::double precision`;
        const rate = sql`${rule.refillPerSecond}::double precision`;
        const refilled = sql`least(${capacity}, b.tokens + extract(epoch from (now() - b.refilled_at)) * ${rate})`;
        const taken = rows<{ tokens: number }>(
          await tx.execute(sql`
            insert into ${connectorRateBuckets} as b (tenant_id, bucket_key, tokens, refilled_at)
            values (${tenantId}::uuid, ${rule.key}, ${capacity} - 1, now())
            on conflict (tenant_id, bucket_key) do update
              set tokens = ${refilled} - 1, refilled_at = now()
              where ${refilled} >= 1
            returning b.tokens`)
        );
        if (taken.length === 0) {
          const [current] = rows<{ tokens: number | string }>(
            await tx.execute(sql`
              select ${refilled} as tokens from ${connectorRateBuckets} b
              where b.tenant_id = ${tenantId}::uuid and b.bucket_key = ${rule.key}`)
          );
          const missing = 1 - Number(current?.tokens ?? 0);
          // Thrown so the transaction rolls back the tokens already taken from earlier buckets.
          throw new RateLimited(Math.max(1, Math.ceil(missing / rule.refillPerSecond)), rule.label);
        }
      }
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof RateLimited) return { ok: false, retryAfterSeconds: err.retryAfterSeconds, label: err.label };
    throw err;
  }
}
