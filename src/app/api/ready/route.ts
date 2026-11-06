import { readinessBody } from "@/lib/health";

// Readiness: the web process can reach Postgres. Fly's machine check uses
// /api/health (liveness); this is for operators and deploy probes.

export const dynamic = "force-dynamic";

export async function GET() {
  const { status, body } = await readinessBody();
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
