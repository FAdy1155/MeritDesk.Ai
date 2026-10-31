import { ORIGIN_VARY, clerkIssuer, connectorOrigin, protectedResourceMetadata } from "./config";

// The discovery documents for the connector's OAuth, served under
// /.well-known/ (src/app/.well-known/): public, cacheable, with CORS for
// MCP clients that run in a browser. Neither holds a secret.

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

function json(body: unknown, status = 200, cacheSeconds = 3600, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": status === 200 ? `public, max-age=${cacheSeconds}` : "no-store",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function metadataPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * RFC 9728 protected resource metadata: the endpoint's URL and Clerk as its
 * authorization server. In production the URL comes only from
 * CONNECTOR_PUBLIC_ORIGIN (500 without it, never the request's Host or
 * X-Forwarded-Host); in development from the request, with Vary so a cache
 * keeps one document per host.
 */
export function protectedResourceMetadataResponse(request: Request): Response {
  const issuer = clerkIssuer();
  if (!issuer) {
    console.error("[connector] no Clerk issuer: set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (or CLERK_OAUTH_ISSUER)");
    return json({ error: "server_error", error_description: "The authorization server is not configured." }, 500);
  }
  const { origin, fromRequest } = connectorOrigin(request);
  if (!origin) return json({ error: "server_error", error_description: "The connector is not configured on this server." }, 500);
  return json(protectedResourceMetadata(origin, issuer), 200, 3600, fromRequest ? { vary: ORIGIN_VARY } : {});
}

let asMetadataCache: { at: number; body: unknown } | null = null;
const AS_METADATA_CACHE_MS = 60 * 60 * 1000;

/**
 * Clerk's RFC 8414 authorization server metadata, repeated at this origin
 * for clients written to the 2025-03-26 MCP authorization spec, which look
 * for it on the MCP server's own origin instead of following the protected
 * resource metadata. Fetched from Clerk and cached for an hour; the document
 * is Clerk's own, unchanged.
 */
export async function authorizationServerMetadataResponse(): Promise<Response> {
  const issuer = clerkIssuer();
  if (!issuer) return json({ error: "server_error", error_description: "The authorization server is not configured." }, 500);
  if (asMetadataCache && Date.now() - asMetadataCache.at < AS_METADATA_CACHE_MS) return json(asMetadataCache.body);
  try {
    const res = await fetch(`${issuer}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    asMetadataCache = { at: Date.now(), body };
    return json(body);
  } catch (err) {
    console.error(`[connector] Clerk authorization server metadata could not be fetched: ${err instanceof Error ? err.message : String(err)}`);
    return json({ error: "temporarily_unavailable", error_description: "The authorization server metadata could not be fetched." }, 502);
  }
}
