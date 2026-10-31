import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { withTenantContext, type TenantTransactionRunner } from "@/db/client";
import { connectorUnrecognizedClients } from "@/db/schema";

// The OAuth clients a firm's members connected the connector from that are
// not on the platform's allow list (connector_unrecognized_clients,
// migration 0013). Such a connection gets the library tools only. The
// connector notes each one (src/services/connector/http.ts, at most every
// ten minutes per firm, client and web machine) and the Firm page lists the
// most recent to the owner/admin: after a first test connection from Claude
// or ChatGPT, this is where the real client id shows up for the platform's
// operator to add to CONNECTOR_ALLOWED_CLIENT_IDS. A client id the firm does
// not recognize at all may mean a member authorized an impostor app.
// inTenant is withTenantContext in the app (the check script passes PGlite's).

/** Longer ids are cut: a CIMD client id is a URL, and nothing needs more to recognize it. */
const MAX_CLIENT_ID_CHARS = 300;

export type UnrecognizedConnectorClient = {
  clientId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  seenCount: number;
};

function cleanClientId(clientId: string): string {
  return clientId.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_CLIENT_ID_CHARS) || "unknown";
}

/** Records (or bumps) one client id for the tenant. Never a token. */
export async function recordUnrecognizedConnectorClient(
  tenantId: string,
  clientId: string,
  userId: string,
  inTenant: TenantTransactionRunner = withTenantContext
): Promise<void> {
  await inTenant(tenantId, async (tx) => {
    await tx
      .insert(connectorUnrecognizedClients)
      .values({ tenantId, clientId: cleanClientId(clientId), lastUserId: userId })
      .onConflictDoUpdate({
        target: [connectorUnrecognizedClients.tenantId, connectorUnrecognizedClients.clientId],
        set: {
          lastSeenAt: sql`now()`,
          seenCount: sql`${connectorUnrecognizedClients.seenCount} + 1`,
          lastUserId: userId,
        },
      });
  });
}

/** The tenant's most recently seen unrecognized clients, newest first. */
export async function listUnrecognizedConnectorClients(
  tenantId: string,
  limit = 20,
  inTenant: TenantTransactionRunner = withTenantContext
): Promise<UnrecognizedConnectorClient[]> {
  return inTenant(tenantId, (tx) =>
    tx
      .select({
        clientId: connectorUnrecognizedClients.clientId,
        firstSeenAt: connectorUnrecognizedClients.firstSeenAt,
        lastSeenAt: connectorUnrecognizedClients.lastSeenAt,
        seenCount: connectorUnrecognizedClients.seenCount,
      })
      .from(connectorUnrecognizedClients)
      .where(eq(connectorUnrecognizedClients.tenantId, tenantId))
      .orderBy(desc(connectorUnrecognizedClients.lastSeenAt))
      .limit(limit)
  );
}
