import { livenessBody } from "@/lib/health";

// Fly and any load balancer call this without a session (src/proxy.ts).
// No database: a Clerk or Neon outage must not mark the process dead.

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(livenessBody(), { headers: { "cache-control": "no-store" } });
}
