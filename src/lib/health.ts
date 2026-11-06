import { logEvent } from "@/lib/log";

export type HealthBody = { ok: true; service: "web"; time: string };
export type ReadyBody =
  | { ok: true; checks: { database: "ok" } }
  | { ok: false; checks: { database: "error" } };

export function livenessBody(): HealthBody {
  return { ok: true, service: "web", time: new Date().toISOString() };
}

export async function readinessBody(): Promise<{ status: number; body: ReadyBody }> {
  try {
    const { sql } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    await db.execute(sql`select 1`);
    return { status: 200, body: { ok: true, checks: { database: "ok" } } };
  } catch (err) {
    logEvent("error", "readiness.database_failed", { name: err instanceof Error ? err.name : "unknown" });
    return { status: 503, body: { ok: false, checks: { database: "error" } } };
  }
}
