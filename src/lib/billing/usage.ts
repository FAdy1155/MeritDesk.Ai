import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { db } from "@/db/client";
import { documents, tenantUsageMonthly } from "@/db/schema";
import {
  billableInputTokens,
  formatBytes,
  formatTokenCount,
  quotaLimitsFor,
  utcMonthStart,
  type ModelUsage,
  type QuotaLimits,
} from "./quotas";
import type { Entitlement } from "./entitlement";
import { countMembers } from "./store";

export type { ModelUsage, QuotaLimits } from "./quotas";
export {
  billableInputTokens,
  formatBytes,
  formatTokenCount,
  quotaLimitsFor,
  utcMonthStart,
} from "./quotas";

/** Thrown when a skill run or upload would exceed the firm's monthly or storage cap. Message is safe to show. */
export class QuotaExceededError extends Error {
  constructor(
    readonly kind: "ai" | "storage",
    message: string
  ) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export type UsageSnapshot = {
  periodStart: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
  completedRunCount: number;
  failedRunCount: number;
  billableInputTokens: number;
  storageBytes: number;
  limits: QuotaLimits;
  seats: number;
};

export async function readStorageBytes(tx: typeof db, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ bytes: sql<number>`coalesce(sum(${documents.sizeBytes}), 0)` })
    .from(documents)
    .where(eq(documents.tenantId, tenantId));
  return Number(row?.bytes ?? 0);
}

export async function readMonthUsage(
  tx: typeof db,
  tenantId: string,
  now = new Date()
): Promise<Omit<UsageSnapshot, "limits" | "seats" | "storageBytes">> {
  const periodStart = utcMonthStart(now);
  const [row] = await tx
    .select()
    .from(tenantUsageMonthly)
    .where(and(eq(tenantUsageMonthly.tenantId, tenantId), eq(tenantUsageMonthly.periodStart, periodStart)))
    .limit(1);
  const usage: ModelUsage = {
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    cacheReadInputTokens: Number(row?.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: Number(row?.cacheCreationInputTokens ?? 0),
    webSearchRequests: Number(row?.webSearchRequests ?? 0),
    webFetchRequests: Number(row?.webFetchRequests ?? 0),
  };
  return {
    periodStart,
    ...usage,
    completedRunCount: Number(row?.completedRunCount ?? 0),
    failedRunCount: Number(row?.failedRunCount ?? 0),
    billableInputTokens: billableInputTokens(usage),
  };
}

export async function readUsageSnapshot(
  tx: typeof db,
  tenantId: string,
  entitlement: Entitlement,
  now = new Date()
): Promise<UsageSnapshot> {
  const seats = Math.max(1, await countMembers(tx, tenantId));
  const [month, storageBytes] = await Promise.all([readMonthUsage(tx, tenantId, now), readStorageBytes(tx, tenantId)]);
  return {
    ...month,
    storageBytes,
    seats,
    limits: quotaLimitsFor(entitlement, seats),
  };
}

export async function assertAiQuota(tx: typeof db, tenantId: string, entitlement: Entitlement, now = new Date()): Promise<void> {
  const snapshot = await readUsageSnapshot(tx, tenantId, entitlement, now);
  const cap = snapshot.limits.monthlyInputTokens;
  if (cap === null) return;
  if (snapshot.billableInputTokens >= cap) {
    throw new QuotaExceededError(
      "ai",
      `This firm has used ${formatTokenCount(snapshot.billableInputTokens)} of its ${formatTokenCount(cap)} monthly AI token allowance. Wait until next month, or ask the platform's operator.`
    );
  }
}

export async function assertStorageQuota(
  tx: typeof db,
  tenantId: string,
  extraBytes: number,
  entitlement: Entitlement,
  now = new Date()
): Promise<void> {
  const snapshot = await readUsageSnapshot(tx, tenantId, entitlement, now);
  const cap = snapshot.limits.storageBytes;
  if (cap === null) return;
  if (snapshot.storageBytes + extraBytes > cap) {
    throw new QuotaExceededError(
      "storage",
      `This upload would put the firm over its ${formatBytes(cap)} document storage allowance (${formatBytes(snapshot.storageBytes)} in use). Remove documents or ask the platform's operator.`
    );
  }
}

export async function recordSkillRunUsage(
  tx: typeof db,
  params: {
    tenantId: string;
    usage: ModelUsage;
    outcome: "completed" | "failed";
    now?: Date;
  }
): Promise<void> {
  const now = params.now ?? new Date();
  const periodStart = utcMonthStart(now);
  const usage: ModelUsage = {
    inputTokens: Math.max(0, Math.trunc(params.usage.inputTokens)),
    outputTokens: Math.max(0, Math.trunc(params.usage.outputTokens)),
    cacheReadInputTokens: Math.max(0, Math.trunc(params.usage.cacheReadInputTokens)),
    cacheCreationInputTokens: Math.max(0, Math.trunc(params.usage.cacheCreationInputTokens)),
    webSearchRequests: Math.max(0, Math.trunc(params.usage.webSearchRequests)),
    webFetchRequests: Math.max(0, Math.trunc(params.usage.webFetchRequests)),
  };
  await tx
    .insert(tenantUsageMonthly)
    .values({
      tenantId: params.tenantId,
      periodStart,
      ...usage,
      completedRunCount: params.outcome === "completed" ? 1 : 0,
      failedRunCount: params.outcome === "failed" ? 1 : 0,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [tenantUsageMonthly.tenantId, tenantUsageMonthly.periodStart],
      set: {
        inputTokens: sql`${tenantUsageMonthly.inputTokens} + ${usage.inputTokens}`,
        outputTokens: sql`${tenantUsageMonthly.outputTokens} + ${usage.outputTokens}`,
        cacheReadInputTokens: sql`${tenantUsageMonthly.cacheReadInputTokens} + ${usage.cacheReadInputTokens}`,
        cacheCreationInputTokens: sql`${tenantUsageMonthly.cacheCreationInputTokens} + ${usage.cacheCreationInputTokens}`,
        webSearchRequests: sql`${tenantUsageMonthly.webSearchRequests} + ${usage.webSearchRequests}`,
        webFetchRequests: sql`${tenantUsageMonthly.webFetchRequests} + ${usage.webFetchRequests}`,
        completedRunCount: sql`${tenantUsageMonthly.completedRunCount} + ${params.outcome === "completed" ? 1 : 0}`,
        failedRunCount: sql`${tenantUsageMonthly.failedRunCount} + ${params.outcome === "failed" ? 1 : 0}`,
        updatedAt: now,
      },
    });
}
