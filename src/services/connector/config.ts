// Where the connector lives, who issues its tokens, which scope its tokens
// must carry and which OAuth clients may reach the firm's data. Kept free of
// server imports: the route handlers, the Firm page and the in-process check
// script all read it. Environment variables are read on every call, so a
// test (or a restart with new settings) sees the current values.

/** The MCP endpoint's path (src/app/api/mcp/route.ts). The server URL a firm enters in Claude or ChatGPT is the origin plus this. */
export const MCP_ENDPOINT_PATH = "/api/mcp";

/**
 * The protected resource metadata (RFC 9728) for the endpoint, at the path
 * the MCP authorization spec derives from the endpoint's own path. The same
 * document is also served at the root well-known path for clients that only
 * look there.
 */
export const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_ENDPOINT_PATH}`;

/** The scope that makes Clerk's consent screen show an organization selector and put the chosen one in the org_id claim. */
export const ORG_SCOPE = "user:org:read";

/** The default of CONNECTOR_REQUIRED_SCOPE. */
export const DEFAULT_CONNECTOR_SCOPE = "practice:connector";

/**
 * The custom Clerk scope every connector token must carry
 * (CONNECTOR_REQUIRED_SCOPE, default practice:connector). Clerk issues
 * OAuth tokens for every OAuth application of the instance; requiring a
 * scope that only the connector's clients are given keeps a token issued
 * for some other application of the same instance from working here (Clerk
 * has no audience for the MCP resource). It does not tell Claude from an
 * impostor client: the client allow list below does that.
 */
export function connectorRequiredScope(): string {
  const value = process.env.CONNECTOR_REQUIRED_SCOPE?.trim();
  return value && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value) ? value : DEFAULT_CONNECTOR_SCOPE;
}

/**
 * The OAuth scopes the connector asks Clerk for: the OpenID scopes identify
 * the user, user:org:read makes the consent screen show an organization
 * selector (how a member of several firms picks one), and the required
 * custom scope marks the token as one for this connector. Claude requests
 * the scopes in the 401's scope parameter, or else scopes_supported;
 * ChatGPT requests the scopes the metadata advertises.
 */
export function connectorScopes(): string[] {
  return ["openid", "profile", "email", ORG_SCOPE, connectorRequiredScope()];
}

/** Display name in the metadata and the MCP initialize response. */
export const CONNECTOR_NAME = "MeritDesk.AI";

function listEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * A prefix may only be an https URL with a path (https://claude.ai/...), so
 * it pins the host: "https://claude.ai" without the slash would also match
 * https://claude.ai.attacker.example/.
 */
function isSafeClientIdPrefix(prefix: string): boolean {
  return /^https:\/\/[a-z0-9.-]+(:\d+)?\/.*$/i.test(prefix);
}

let warnedPrefixes = "";

/**
 * The OAuth client ids allowed to use the case-work tools:
 * CONNECTOR_ALLOWED_CLIENT_IDS (exact ids) and
 * CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES (https URL prefixes, for clients
 * that identify themselves with a Client ID Metadata Document URL). Anyone
 * can register a client with Clerk under any name (DCR), so a token's client
 * is trusted with client data only when its id is listed here; with
 * neither variable set, no client is.
 */
export function connectorClientAllowList(): { ids: string[]; prefixes: string[] } {
  const ids = listEnv("CONNECTOR_ALLOWED_CLIENT_IDS");
  const rawPrefixes = listEnv("CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES");
  const prefixes = rawPrefixes.filter(isSafeClientIdPrefix);
  const rejected = rawPrefixes.filter((p) => !isSafeClientIdPrefix(p)).join(" ");
  if (rejected && rejected !== warnedPrefixes) {
    warnedPrefixes = rejected;
    console.error(`[connector] CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES: ignoring ${rejected} (each prefix must be an https URL with a path, ending in a slash after the host)`);
  }
  return { ids, prefixes };
}

/** Whether any client is allowed at all (the Firm page says so when none is). */
export function connectorClientAllowListConfigured(): boolean {
  const { ids, prefixes } = connectorClientAllowList();
  return ids.length > 0 || prefixes.length > 0;
}

/** Whether the token's OAuth client may use the case-work tools. */
export function isAllowedConnectorClient(clientId: string | null | undefined): boolean {
  if (!clientId) return false;
  const { ids, prefixes } = connectorClientAllowList();
  return ids.includes(clientId) || prefixes.some((p) => clientId.startsWith(p));
}

function trimOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The request headers the origin was built from in development, for a Vary header. */
export const ORIGIN_VARY = "Host, X-Forwarded-Host, X-Forwarded-Proto";

/**
 * The public origin of the app (https://app.example.com), and whether it was
 * built from the request's headers. CONNECTOR_PUBLIC_ORIGIN when set and
 * valid. In production it must be: the metadata's resource must equal the
 * URL the firm entered exactly, and a Host or X-Forwarded-Host header is
 * the caller's to choose, so without it the origin is null and the
 * connector answers 500. Outside production the request's forwarded host
 * and protocol, then its URL, are used (responses then say Vary).
 */
export function resolveConnectorOrigin(headers: Pick<Headers, "get">, requestUrl?: string): { origin: string | null; fromRequest: boolean } {
  const configured = process.env.CONNECTOR_PUBLIC_ORIGIN?.trim();
  if (configured) {
    const origin = trimOrigin(configured);
    if (origin) return { origin, fromRequest: false };
    console.error("[connector] CONNECTOR_PUBLIC_ORIGIN is not an http(s) URL");
  }
  if (process.env.NODE_ENV === "production") {
    if (!configured) console.error("[connector] CONNECTOR_PUBLIC_ORIGIN is not set; the connector refuses to answer until it is");
    return { origin: null, fromRequest: false };
  }
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || headers.get("host");
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const urlProtocol = requestUrl ? new URL(requestUrl).protocol.replace(":", "") : "https";
  if (host) {
    const scheme = proto === "http" || proto === "https" ? proto : urlProtocol;
    const origin = trimOrigin(`${scheme}://${host}`);
    if (origin) return { origin, fromRequest: true };
  }
  return { origin: requestUrl ? new URL(requestUrl).origin : "https://localhost", fromRequest: true };
}

/** resolveConnectorOrigin for a route handler's request. */
export function connectorOrigin(request: Request): { origin: string | null; fromRequest: boolean } {
  return resolveConnectorOrigin(request.headers, request.url);
}

/** The MCP server URL: what a firm enters in Claude or ChatGPT, and the protected resource's identifier. */
export function connectorResourceUrl(origin: string): string {
  return `${origin}${MCP_ENDPOINT_PATH}`;
}

/**
 * Clerk's Frontend API URL, which is the issuer of its OAuth tokens and
 * serves its authorization server metadata. CLERK_OAUTH_ISSUER overrides it
 * (no trailing slash, exactly the `issuer` Clerk's
 * /.well-known/oauth-authorization-server states); otherwise it is decoded
 * from the publishable key, which encodes the Frontend API host
 * (pk_live_<base64 of "clerk.example.com$">), as @clerk/mcp-tools does.
 */
export function clerkIssuer(): string | null {
  const override = process.env.CLERK_OAUTH_ISSUER?.trim();
  if (override) return override.replace(/\/+$/, "");
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  if (!key) return null;
  const encoded = key.replace(/^pk_(test|live)_/, "");
  try {
    const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
    if (!/^[a-z0-9.-]+$/i.test(host)) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

/** RFC 9728 protected resource metadata for the endpoint. */
export function protectedResourceMetadata(origin: string, issuer: string) {
  return {
    resource: connectorResourceUrl(origin),
    authorization_servers: [issuer],
    scopes_supported: connectorScopes(),
    bearer_methods_supported: ["header"],
    resource_name: CONNECTOR_NAME,
  };
}

/** The WWW-Authenticate value of a 401 (and of a 403 with an error code), pointing at the metadata. */
export function wwwAuthenticate(origin: string, error?: { code: "invalid_token" | "insufficient_scope"; description: string }): string {
  const parts = [`resource_metadata="${origin}${PROTECTED_RESOURCE_METADATA_PATH}"`, `scope="${connectorScopes().join(" ")}"`];
  if (error) {
    parts.unshift(`error="${error.code}"`);
    // Quoted-string: no quotes or backslashes inside.
    parts.push(`error_description="${error.description.replace(/["\\]/g, "'")}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}
